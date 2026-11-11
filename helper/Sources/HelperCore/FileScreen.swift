import AVFoundation
import CoreImage
import Foundation

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
let fileScreenQueue = DispatchQueue(label: "live-mindmap.file-screen")

func onFileScreenQueue<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
        fileScreenQueue.async { continuation.resume(returning: body()) }
    }
}

/// AVAssetReader の読み出しと停止（`copyNextSampleBuffer`・`cancelReading`）は `fileScreenQueue` の上（と `deinit`）でだけ行う。読み出し中に別のスレッドから `cancelReading` が入ると落ちる（Issue #1198）。
final class FileScreenReading: @unchecked Sendable {
    enum Opened {
        case noVideo
        case unreadable(String)
        case reading(FileScreenReading)
    }

    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let imageContext = CIContext()
    private var thinner = ScreenFrameThinner()
    private var detector = ScreenChangeDetector.withoutTabDetection()
    private(set) var lastTime: Double
    var allEventsSentBefore: Double? { detector.fileProgress }
    private var finished = false
    private let cancelLock = NSLock()
    private var cancelled = false
    private var isCancelled: Bool { cancelLock.withLock { cancelled } }

    private init(reader: AVAssetReader, output: AVAssetReaderTrackOutput, startingAt: Double) {
        self.reader = reader
        self.output = output
        self.lastTime = startingAt
    }

    deinit { reader.cancelReading() }

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

    func cancel() {
        let first = cancelLock.withLock { () -> Bool in
            defer { cancelled = true }
            return !cancelled
        }
        if first { fileScreenQueue.async { self.reader.cancelReading() } }
    }

    var readerStatus: AVAssetReader.Status { reader.status }

    enum Step {
        case frame
        case events([HelperEvent])
        case end
    }

    func step() -> Step {
        if finished || isCancelled { return .end }
        if !isCancelled, let sample = output.copyNextSampleBuffer() {
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard time.isFinite, thinner.admits(time), let rendered = render(sample) else { return .frame }
            lastTime = time
            let frame = ScreenFrame(luma: rendered.luma, time: time, title: nil)
            let events = detector.fileScreenEvent(for: frame, encode: { screenShot(of: rendered.image) })
            return events.isEmpty ? .frame : .events(events)
        }
        finished = true
        guard !isCancelled else { return .end }
        if reader.status == .failed {
            printScreenError("動画の映像を最後まで読めなかった（音声だけで続ける）: \(reader.error?.localizedDescription ?? "不明")")
            var events = detector.screenEvent(windowGoneAt: lastTime)
            events.append(.screenOff(start: lastTime, reason: .許可なし))
            return .events(events)
        }
        let events = detector.finish()
        return events.isEmpty ? .end : .events(events)
    }

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

public func selectFileVideo(theirs: URL, mine: URL?) async -> URL? {
    if await hasVideoTrack(theirs) { return theirs }
    if let mine, await hasVideoTrack(mine) { return mine }
    return nil
}

private func hasVideoTrack(_ url: URL) async -> Bool {
    guard let tracks = try? await AVURLAsset(url: url).loadTracks(withMediaType: .video) else { return false }
    return !tracks.isEmpty
}

public func relayFileScreen(
    from url: URL, to server: WebSocketServer, progress: FileReadingAlignment.Screen, startingAt: Double = 0, gate: FileReadingGate? = nil
) async {
    await relayFileScreen(from: url, to: server, progress: progress, startingAt: startingAt, gate: gate, afterFrame: nil)
}

func relayFileScreen(
    from url: URL, to server: WebSocketServer, progress: FileReadingAlignment.Screen,
    startingAt: Double = 0, gate: FileReadingGate? = nil, afterFrame: (@Sendable (Double) async -> Void)?
) async {
    switch await FileScreenReading.open(url, startingAt: startingAt) {
    case .noVideo:
        break
    case .unreadable(let reason):
        printScreenError("動画の映像を読めない（音声だけで続ける）: \(reason)")
        await server.send(.screenOff(start: 0, reason: .許可なし))
    case .reading(let reading):
        await withTaskCancellationHandler {
            while !Task.isCancelled {
                do { try await gate?.waitOpen() } catch { break }
                let stepped = await onFileScreenQueue { () -> (events: [HelperEvent], time: Double, allEventsSentBefore: Double?)? in
                    switch reading.step() {
                    case .frame: return ([], reading.lastTime, reading.allEventsSentBefore)
                    case .events(let events): return (events, reading.lastTime, reading.allEventsSentBefore)
                    case .end: return nil
                    }
                }
                guard let (events, time, allEventsSentBefore) = stepped else { break }
                for event in events where !Task.isCancelled { await server.send(event) }
                if let allEventsSentBefore { await progress.sentAllScreenEvents(before: allEventsSentBefore) }
                await afterFrame?(time)
            }
        } onCancel: {
            reading.cancel()
        }
        reading.cancel()
    }
    await progress.finish()
}
