import AVFoundation
import Foundation
import Speech

// 音声ファイル 1 本を文字にする経路（`transcribe-file`）。ライブの `Transcriber` とは別の口で、
//   ファイル → AVAssetReader（PCM） → FileAudioInputs（AnalyzerInput の列） → FileTranscriber → 無音の区間を捨てる → 結果
// と流す。結果の時刻は「ファイルの音声の時刻」（先頭が 0 秒）で、壁時計ではない。
// 音声は analyzer が引いたぶんだけ読む（間に上限つきの列を置かない）ので、速さは analyzer に合う。上限 2048 には当たらない。
// 無音の判定は、ライブと同じ基準（`isSilentMeanSquare`）で、ファイルから区間の音量を読み直して行う
// （ライブの `TrackLoudness` は直近 30 秒しか覚えないので、先へ文字にする経路では使えない）。

public enum FileTranscriptionError: Error, CustomStringConvertible {
    case noAudioTrack(String)
    case unsupportedFormat(String)
    case readFailed(String)

    public var description: String {
        switch self {
        case .noAudioTrack(let path): return "音声のトラックが無い: \(path)"
        case .unsupportedFormat(let reason): return "対応していない音声の形式: \(reason)"
        case .readFailed(let reason): return "音声を読み出せない: \(reason)"
        }
    }
}

/// ファイルの音声を文字にする役。`SpeechAnalyzerTranscriber` が準拠する。
public protocol FileTranscriber {
    /// 認識に必要な準備（モデルの取得など）。音声を流す前に呼ぶ。
    func prepare() async throws
    /// ファイルの音声の列を文字起こしする。列が終わると、残りを確定して結果の流れも終わる。
    /// 結果の `start` / `end` は、ファイルの音声の先頭を 0 とする秒数。インスタンスごとに 1 回だけ呼べる。
    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error>
}

/// ファイルの音声を PCM として読む目的。形式が違う。
enum FilePCM {
    /// 音量を測る。ファイルのチャンネル数のままの Float32（インターリーブなし）。ライブの `TrackLoudness` と同じ測り方（`forEachFrameMeanSquare`）が読める形。
    case measuring
    /// `AnalyzerInput` にする。`AnalyzerInput` は Int16 のバッファしか受け付けない（Float32 だと init が落ちる）ので、モノラルの Int16。
    case analyzing
}

/// ファイルの音声トラック 1 本と、それを読む PCM の形式。
struct FileAudioSource {
    let asset: AVURLAsset
    let track: AVAssetTrack
    /// ファイルにある音声トラックの本数。使うのは最初の 1 本（`track`）だけ。
    let audioTrackCount: Int
    let sampleRate: Double
    let channels: Int
    let measuringFormat: AVAudioFormat
    let analyzingFormat: AVAudioFormat

    static func open(_ url: URL) async throws -> FileAudioSource {
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            throw FileTranscriptionError.readFailed("\(url.path) (\(error.localizedDescription))")
        }
        guard let track = tracks.first else { throw FileTranscriptionError.noAudioTrack(url.path) }
        let descriptions = try await track.load(.formatDescriptions)
        guard let description = descriptions.first,
            let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
            basic.mSampleRate > 0, basic.mChannelsPerFrame > 0
        else {
            throw FileTranscriptionError.unsupportedFormat(url.path)
        }
        // チャンネルは 2 までに限る（AVAudioFormat はそれ以上のとき channel layout を要る）。会議の録画は 1〜2ch
        guard basic.mChannelsPerFrame <= 2,
            let measuringFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: basic.mSampleRate, channels: AVAudioChannelCount(basic.mChannelsPerFrame), interleaved: false),
            let analyzingFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: basic.mSampleRate, channels: 1, interleaved: true)
        else {
            throw FileTranscriptionError.unsupportedFormat("\(basic.mChannelsPerFrame) チャンネル: \(url.path)")
        }
        return FileAudioSource(
            asset: asset, track: track, audioTrackCount: tracks.count, sampleRate: basic.mSampleRate, channels: Int(basic.mChannelsPerFrame),
            measuringFormat: measuringFormat, analyzingFormat: analyzingFormat)
    }

    func format(for kind: FilePCM) -> AVAudioFormat {
        switch kind {
        case .measuring: return measuringFormat
        case .analyzing: return analyzingFormat
        }
    }

    /// `kind` の形式の PCM を、ファイルのサンプルレートのまま読む reader。`timeRange` が nil なら全体。
    func makeReader(_ kind: FilePCM, timeRange: CMTimeRange? = nil) throws -> (reader: AVAssetReader, output: AVAssetReaderTrackOutput) {
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any]
        switch kind {
        case .measuring:
            settings = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: channels,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: true,
            ]
        case .analyzing:
            settings = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
        }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw FileTranscriptionError.readFailed("音声を PCM として読み出せない") }
        reader.add(output)
        if let timeRange { reader.timeRange = timeRange }
        guard reader.startReading() else {
            throw FileTranscriptionError.readFailed(reader.error?.localizedDescription ?? "不明")
        }
        return (reader, output)
    }

    /// reader が返した 1 つのサンプルバッファを PCM バッファにする。
    func pcmBuffer(from sample: CMSampleBuffer, _ kind: FilePCM) throws -> AVAudioPCMBuffer {
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format(for: kind), frameCapacity: frames) else {
            throw FileTranscriptionError.readFailed("バッファを作れない")
        }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
        guard status == noErr else { throw FileTranscriptionError.readFailed("PCM に変換できない (\(status))") }
        return buffer
    }
}

/// `AVAssetReader` の読み出し（`copyNextSampleBuffer`）は、デコードが済むまでスレッドを止めて待つ。
/// Swift の並行処理のスレッド（コア数ぶんしかない）の上で呼ぶと、ほかの同期の待ちと重なったときにスレッドが尽きて止まる
/// （CI のランナーで IT が止まり続けた。Issue #1086）。読み出しは、このキューの上で行う。
private let fileReadingQueue = DispatchQueue(label: "live-mindmap.file-reading")

/// `body` を `fileReadingQueue` の上で動かし、その結果を返す。
private func onFileReadingQueue<T>(_ body: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        fileReadingQueue.async { continuation.resume(with: Result { try body() }) }
    }
}

/// ファイルの音声の全体の長さ（秒）。
public func fileDuration(of url: URL) async throws -> Double {
    try await duration(of: FileAudioSource.open(url), path: url.path)
}

private func duration(of source: FileAudioSource, path: String) async throws -> Double {
    let range = try await source.track.load(.timeRange)
    guard range.duration.isNumeric else { throw FileTranscriptionError.readFailed("長さが決まらない: \(path)") }
    return range.duration.seconds
}

/// `transcribe-file` が最初に流すファイルの情報。
public struct FileHeader: Equatable, Sendable {
    /// ファイルの音声の全体の長さ（秒）。
    public let duration: Double
    /// ファイルの音声トラックの本数。文字にするのは最初の 1 本だけなので、2 本以上あることを知らせるために数える。
    public let audioTrackCount: Int
}

/// ファイルの長さと音声トラックの本数を読む。読めないファイルはここで失敗する（待ち受けを始める前に呼ぶ）。
public func readFileHeader(of url: URL) async throws -> FileHeader {
    let source = try await FileAudioSource.open(url)
    return FileHeader(duration: try await duration(of: source, path: url.path), audioTrackCount: source.audioTrackCount)
}

/// `file-duration`、`file-audio-tracks` の順に、別々のキーで保持して流す。後から接続したクライアントにも、この順で届く。
public func broadcastFileHeader(_ header: FileHeader, on server: WebSocketServer) async throws {
    try await server.broadcastRetained(HelperEvent.fileDuration(duration: header.duration).jsonString(), key: "file-duration")
    try await server.broadcastRetained(HelperEvent.fileAudioTracks(count: header.audioTrackCount).jsonString(), key: "file-audio-tracks")
}

/// ファイルの音声を、引かれたぶんだけ読んで `AnalyzerInput` にする列。各入力は、ファイル上の位置（先頭からのフレーム数）を `bufferStartTime` に持つ。
public struct FileAudioInputs: AsyncSequence {
    public typealias Element = AnalyzerInput

    let url: URL

    init(url: URL) {
        self.url = url
    }

    public func makeAsyncIterator() -> Iterator {
        Iterator(url: url)
    }

    public struct Iterator: AsyncIteratorProtocol {
        let url: URL
        private var reading: Reading?
        private var finished = false

        init(url: URL) {
            self.url = url
        }

        public mutating func next() async throws -> AnalyzerInput? {
            if finished { return nil }
            if Task.isCancelled {
                finished = true
                reading?.reader.cancelReading()
                throw CancellationError()
            }
            if reading == nil { reading = try await Reading.open(url) }
            guard let reading else { return nil }
            let input = try await onFileReadingQueue { try reading.nextInput() }
            if input == nil { finished = true }
            return input
        }
    }

    /// 読み出し中の reader と、ここまでに渡したフレーム数。
    fileprivate final class Reading {
        let source: FileAudioSource
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        var framesRead = 0

        init(source: FileAudioSource, reader: AVAssetReader, output: AVAssetReaderTrackOutput) {
            self.source = source
            self.reader = reader
            self.output = output
        }

        deinit { reader.cancelReading() }

        /// 次の入力を読む。読み終えたら `nil`。同期で待つので `fileReadingQueue` の上で呼ぶ。
        func nextInput() throws -> AnalyzerInput? {
            while let sample = output.copyNextSampleBuffer() {
                if CMSampleBufferGetNumSamples(sample) == 0 { continue }
                let buffer = try source.pcmBuffer(from: sample, .analyzing)
                let start = framesRead
                framesRead += Int(buffer.frameLength)
                let startTime = CMTime(value: CMTimeValue(start), timescale: CMTimeScale(source.sampleRate))
                return AnalyzerInput(buffer: buffer, bufferStartTime: startTime)
            }
            if reader.status == .failed {
                throw FileTranscriptionError.readFailed(reader.error?.localizedDescription ?? "不明")
            }
            return nil
        }

        static func open(_ url: URL) async throws -> Reading {
            let source = try await FileAudioSource.open(url)
            let (reader, output) = try source.makeReader(.analyzing)
            return Reading(source: source, reader: reader, output: output)
        }
    }
}

/// ファイルから区間の音量を読み直して、ほぼ無音か判定する。基準はライブの `TrackLoudness` と同じ（`isSilentMeanSquare`）。
/// 記録は持たず、結果ごとに区間だけを別の reader で読む（長い録画でも、メモリは区間の長さぶんだけ）。
final class FileLoudness {
    private let source: FileAudioSource
    /// 区間の端がデコードの単位に揃わなくても、サンプルの位置（PTS）で数え直すための余白（秒）。
    private static let margin = 0.25

    init(source: FileAudioSource) {
        self.source = source
    }

    /// 区間 `[start, end)`（ファイルの秒）がほぼ無音か。同期で待つので `fileReadingQueue` の上で呼ぶ。`nil` は「測れない」（無音と混同しない。測れない区間の結果は捨てない）。
    /// 区間が音声の長さを越える分は、読めた部分だけで判定する。ファイルと重ならない区間・読めない区間は `nil`。
    /// フレームは `[ceil(start·sr), ceil(end·sr))`（ライブの `TrackLoudness` と同じ区切り）。
    func isBelowSilenceThreshold(start: Double, end: Double) -> Bool? {
        guard start.isFinite, end.isFinite, end > start else { return nil }
        let sampleRate = source.sampleRate
        let firstFrame = Int((max(0, start) * sampleRate).rounded(.up))
        let endFrame = Int((end * sampleRate).rounded(.up))
        guard firstFrame < endFrame else { return nil }

        let timescale = CMTimeScale(sampleRate)
        let readStart = max(0, Double(firstFrame) / sampleRate - Self.margin)
        let readEnd = Double(endFrame) / sampleRate + Self.margin
        guard let (reader, output) = try? source.makeReader(.measuring, timeRange: CMTimeRange(
            start: CMTime(seconds: readStart, preferredTimescale: timescale),
            end: CMTime(seconds: readEnd, preferredTimescale: timescale)))
        else { return nil }
        defer { reader.cancelReading() }

        var sum = 0.0
        var counted = 0
        var measurable = true
        while let sample = output.copyNextSampleBuffer() {
            let first = Int((CMSampleBufferGetPresentationTimeStamp(sample).seconds * sampleRate).rounded())
            if first >= endFrame { break }
            guard let buffer = try? source.pcmBuffer(from: sample, .measuring) else { return nil }
            measurable = forEachFrameMeanSquare(of: buffer) { frame, meanSquare in
                let position = first + frame
                guard position >= firstFrame, position < endFrame else { return }
                sum += Double(meanSquare)
                counted += 1
            }
            if !measurable { return nil }
        }
        if reader.status == .failed || counted == 0 { return nil }
        return isSilentMeanSquare(sum / Double(counted))
    }
}

/// `url` のファイルを `transcriber` で文字にする。区間がほぼ無音の結果（途中結果・確定結果とも）は、ファイルから音量を読み直して捨てる。
/// 結果の時刻は `transcriber` が返したまま（ファイルの音声の時刻）。
public func transcribeFile(at url: URL, with transcriber: any FileTranscriber) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
    let loudness = FileLoudness(source: try await FileAudioSource.open(url))
    let results = try await transcriber.transcribe(FileAudioInputs(url: url))
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
    let task = Task {
        do {
            for try await result in results {
                // 測れない区間（nil）は、ほぼ無音とみなさない
                let silent = try await onFileReadingQueue { loudness.isBelowSilenceThreshold(start: result.start, end: result.end) }
                if silent ?? false { continue }
                continuation.yield(result)
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
}
