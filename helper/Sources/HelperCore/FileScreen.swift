import AVFoundation
import CoreImage
import Foundation

// 録画の動画の映像を共有画面として流す経路（`transcribe-file`、Issue #1090）。
//   動画 → AVAssetReader（最初の映像トラック、BGRA） → 4 fps に間引く → 1280×720 に収める → ScreenChangeDetector → screen
// 判定器・送る画像（JPEG 0.8）・OCR はライブ（`ScreenCapture`）と同じ。時刻は動画の時刻（PTS、先頭が 0 秒）で、音声の時刻と同じ。
// ブラウザのタブの判定はかけない（bundle id を空に、タイトルを nil にする）。顔だけの画面も特別扱いしない。
// 映像のトラックが無いファイルは何も流さない。映像が読めなければ `screen-off` で知らせて、音声だけで続ける。

/// ライブと同じ 4 fps（`screenFramesPerSecond`）に間引く。時刻を 1/4 秒の枠に分け、前に通した枠より後ろの枠のフレームだけを通す。
struct ScreenFrameThinner {
    private var lastSlot: Int?

    mutating func admits(_ time: Double) -> Bool {
        let slot = Int((time * Double(screenFramesPerSecond)).rounded(.down))
        if let lastSlot, slot <= lastSlot { return false }
        lastSlot = slot
        return true
    }
}

/// 映像の読み出しは、デコードが済むまでスレッドを止めて待つ。Swift の並行処理のスレッドで呼ばず、専用の直列のキューで行う（音声の `fileReadingQueue` と同じ事情。Issue #1086）。
/// 音声の読み出しと別のキューにして、映像の JPEG・OCR で音声の読み出しを止めない。
let fileScreenQueue = DispatchQueue(label: "live-mindmap.file-screen")

func onFileScreenQueue<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
        fileScreenQueue.async { continuation.resume(returning: body()) }
    }
}

/// 動画の最初の映像トラックを読み、変化した画面のイベントにする。`step()` は `fileScreenQueue` の上でだけ呼ぶ。
/// AVAssetReader の読み出しと停止（`copyNextSampleBuffer`・`cancelReading`）は `fileScreenQueue` の上（と `deinit`）でだけ行う。読み出し中に別のスレッドから `cancelReading` が入ると落ちる（Issue #1198）。
final class FileScreenReading: @unchecked Sendable {
    enum Opened {
        /// 映像のトラックが無い（音声だけのファイル）。「読めない」とは別。
        case noVideo
        /// 映像のトラックはあるが、読み始められない。
        case unreadable(String)
        case reading(FileScreenReading)
    }

    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let imageContext = CIContext()
    private var thinner = ScreenFrameThinner()
    private var detector = ScreenChangeDetector(bundleID: "")
    /// 最後に読んだフレームの時刻（途中で読めなくなったときの `screen-off` の時刻。`--self-file` の 2 トラックでは映像の判定の進み）。
    private(set) var lastTime: Double
    private var finished = false
    /// 取り消しの印。`cancel()` はどのスレッドからでも立てられ、`next()` はフレームを読むたびに見る。
    private let cancelLock = NSLock()
    private var cancelled = false
    private var isCancelled: Bool { cancelLock.withLock { cancelled } }

    private init(reader: AVAssetReader, output: AVAssetReaderTrackOutput, startingAt: Double) {
        self.reader = reader
        self.output = output
        self.lastTime = startingAt
    }

    deinit { reader.cancelReading() }

    /// `startingAt` は読み始める映像の時刻（秒。起動し直しのとき 0 より後ろ）。
    static func open(_ url: URL, startingAt: Double = 0) async -> Opened {
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .video)
        } catch {
            return .unreadable(error.localizedDescription)
        }
        guard let track = tracks.first else { return .noVideo }
        return await onFileScreenQueue { start(asset, track, startingAt: startingAt) }
    }

    private static func start(_ asset: AVURLAsset, _ track: AVAssetTrack, startingAt: Double) -> Opened {
        do {
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(
                track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            guard reader.canAdd(output) else { return .unreadable("映像を BGRA として読み出せない") }
            reader.add(output)
            if startingAt > 0 { reader.timeRange = CMTimeRange(start: CMTime(seconds: startingAt, preferredTimescale: 600), duration: .positiveInfinity) }
            guard reader.startReading() else { return .unreadable(reader.error?.localizedDescription ?? "不明") }
            return .reading(FileScreenReading(reader: reader, output: output, startingAt: startingAt))
        } catch {
            return .unreadable(error.localizedDescription)
        }
    }

    /// 読むのをやめる。どのスレッドから呼んでもよい。読み出し中の `next()` は次のフレームで抜け、読み手は `fileScreenQueue` の上で止める。
    func cancel() {
        let first = cancelLock.withLock { () -> Bool in
            defer { cancelled = true }
            return !cancelled
        }
        if first { fileScreenQueue.async { self.reader.cancelReading() } }
    }

    /// 読み手の状態（テストで、取り消しが AVAssetReader に触れた時機を見る）。`fileScreenQueue` の上か、キューを塞いでいる間にだけ読む。
    var readerStatus: AVAssetReader.Status { reader.status }

    /// `step()` の結果。
    enum Step {
        /// フレームを 1 つ読んだ。出すイベントは無い。
        case frame
        /// イベントが出た。
        case events([HelperEvent])
        /// 映像を読み終えた。
        case end
    }

    /// フレームを 1 つだけ読んで進める。呼び出し側が 1 フレームごとに止められるよう、イベントが出るまでは進めない（一時停止の間は読み進めない。Issue #1092）。
    /// 途中で読めなくなったら、画像を送った後なら `image: null`、続けて `screen-off`（許可なし）を返してから終わる（ライブの `emitCaptureStopped` と同じ順）。
    func step() -> Step {
        if finished || isCancelled { return .end }
        if !isCancelled, let sample = output.copyNextSampleBuffer() {
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard time.isFinite, thinner.admits(time), let rendered = render(sample) else { return .frame }
            lastTime = time
            let frame = ScreenFrame(luma: rendered.luma, time: time, title: nil)
            if let event = detector.screenEvent(for: frame, encode: { screenShot(of: rendered.image) }) { return .events([event]) }
            return .frame
        }
        finished = true
        guard !isCancelled, reader.status == .failed else { return .end }
        printScreenError("動画の映像を最後まで読めなかった（音声だけで続ける）: \(reader.error?.localizedDescription ?? "不明")")
        var events: [HelperEvent] = []
        if let event = detector.screenEvent(windowGoneAt: lastTime) { events.append(event) }
        events.append(.screenOff(start: lastTime, reason: .許可なし))
        return .events(events)
    }

    /// フレームを 1280×720 に収めた画像にして、輝度の画像と一緒に返す。作れなければ nil（そのフレームは判定に入れない）。
    private func render(_ sample: CMSampleBuffer) -> (luma: [UInt8], image: CGImage)? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return nil }
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        let width = Int(source.extent.width)
        let height = Int(source.extent.height)
        guard width > 0, height > 0 else { return nil }
        let size = fitScreenSize(width: width, height: height)
        let fitted = (size.width, size.height) == (width, height)
            ? source
            : source.transformed(by: CGAffineTransform(scaleX: Double(size.width) / Double(width), y: Double(size.height) / Double(height)))
        let rect = CGRect(x: 0, y: 0, width: size.width, height: size.height)
        guard let image = imageContext.createCGImage(fitted, from: rect), let luma = lumaGrid(of: image) else { return nil }
        return (luma: luma, image: image)
    }
}

/// 動画のセッションのイベント（`cli recorded`）。文字起こしを先に始め、映像の判定と OCR をそれと並べて進める。
/// 流す順は、画面のイベントをすべて流し切ってから、文字起こしの結果。文字起こしの結果は流れの中に溜まるので、画面を先に流しても止まらない。
/// サーバーは画面の変化を発言より先に受け取る前提で、音声の時刻の順に並べる。
/// 映像が読めなければ `screen-off`（許可なし）を流して、音声の結果は続く。映像のトラックが無ければ画面のイベントは出ない。
/// `from` は読み始める音声・映像の時刻（秒。サーバーの起動し直しのとき）。結果の時刻はファイルの時刻のまま。
/// `gate` があれば、サーバーの指示で止められている間は読み進めない。
public func fileSessionEvents(
    at url: URL, with transcriber: any FileTranscriber, from: Double = 0, gate: FileReadingGate? = nil
) async throws -> AsyncThrowingStream<HelperEvent, Error> {
    let results = try await transcribeFile(at: url, with: transcriber, from: from, gate: gate)
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: HelperEvent.self, throwing: Error.self)
    let task = Task {
        var reading: FileScreenReading?
        do {
            switch await FileScreenReading.open(url, startingAt: from) {
            case .noVideo:
                break
            case .unreadable(let reason):
                printScreenError("動画の映像を読めない（音声だけで続ける）: \(reason)")
                continuation.yield(.screenOff(start: 0, reason: .許可なし))
            case .reading(let opened):
                reading = opened
                screenLoop: while !Task.isCancelled {
                    // 止められている間は、映像も読み進めない（1 フレームごとに確かめる）
                    try await gate?.waitOpen()
                    switch await onFileScreenQueue({ opened.step() }) {
                    case .frame: continue
                    case .events(let events): for event in events { continuation.yield(event) }
                    case .end: break screenLoop
                    }
                }
            }
            reading?.cancel()
            for try await result in results {
                continuation.yield(event(from: result, track: .相手))
            }
            continuation.finish()
        } catch {
            reading?.cancel()
            continuation.finish(throwing: error)
        }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
}

/// 2 トラック（`cli recorded --self`）の映像を選ぶ。メインに映像があればメイン、なければ自分用にあれば自分用、どちらにもなければ nil。
/// 映像の有無を確かめられないファイルは、映像なしとして扱う（音声の読み出しが、そのファイルの失敗を扱う）。
public func selectFileVideo(theirs: URL, mine: URL) async -> URL? {
    if await hasVideoTrack(theirs) { return theirs }
    if await hasVideoTrack(mine) { return mine }
    return nil
}

private func hasVideoTrack(_ url: URL) async -> Bool {
    guard let tracks = try? await AVURLAsset(url: url).loadTracks(withMediaType: .video) else { return false }
    return !tracks.isEmpty
}

/// 2 トラック（`cli recorded --self`）の映像を読み、変化した画面を `server` に流す。判定・画像・`screen-off` は 1 本のとき（`FileScreenReading`）と同じ。
/// 1 本のときと違い、文字起こしの結果と並べて流す。イベントを流した後に、判定したフレームの時刻まで `progress` を進め
/// （音声の読み手は、判定の済んだ時刻を越えて入力を渡さない）、どの出口でも終わりを知らせる。取り消されたら読むのをやめる。
/// `gate` があれば、サーバーの指示で止められている間は読み進めない。
public func relayFileScreen(
    from url: URL, to server: WebSocketServer, progress: FileReadingAlignment.Screen, startingAt: Double = 0, gate: FileReadingGate? = nil
) async {
    switch await FileScreenReading.open(url, startingAt: startingAt) {
    case .noVideo:
        break
    case .unreadable(let reason):
        printScreenError("動画の映像を読めない（音声だけで続ける）: \(reason)")
        await broadcast(.screenOff(start: 0, reason: .許可なし), to: server)
    case .reading(let reading):
        // 取り消されたら、読み出しを止めて `next()` を抜けさせる（変化の無い長い区間を、次のイベントまで読み切らない）
        await withTaskCancellationHandler {
            while !Task.isCancelled {
                // 止められている間は、映像も読み進めない。キャンセルされたら読むのをやめる
                do { try await gate?.waitOpen() } catch { break }
                let stepped = await onFileScreenQueue { () -> (events: [HelperEvent], time: Double)? in
                    switch reading.step() {
                    case .frame: return ([], reading.lastTime)
                    case .events(let events): return (events, reading.lastTime)
                    case .end: return nil
                    }
                }
                guard let (events, time) = stepped else { break }
                // イベントが出ないフレームでは、判定の進みを動かさない（従来はイベントが出るまで 1 回で読み進めていた）
                if events.isEmpty { continue }
                for event in events where !Task.isCancelled { await broadcast(event, to: server) }
                await progress.advance(to: time)
            }
        } onCancel: {
            reading.cancel()
        }
        reading.cancel()
    }
    await progress.finish()
}

private func broadcast(_ event: HelperEvent, to server: WebSocketServer) async {
    do {
        await server.broadcast(try event.jsonString())
    } catch {
        printScreenError("画面のイベントを JSON にできなかったので送らない: \(error)")
    }
}
