import AVFoundation
import Foundation
import Speech

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

public protocol FileTranscriber {
    func prepare() async throws
    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error>
}

enum FilePCM {
    case measuring
    /// `AnalyzerInput` にする。`AnalyzerInput` は Int16 のバッファしか受け付けない（Float32 だと init が落ちる）ので、モノラルの Int16。
    case analyzing
}

struct FileAudioSource {
    let asset: AVURLAsset
    let track: AVAssetTrack
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

private func onFileReadingQueue<T>(_ body: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        fileReadingQueue.async { continuation.resume(with: Result { try body() }) }
    }
}

public func fileDuration(of url: URL) async throws -> Double {
    try await duration(of: FileAudioSource.open(url), path: url.path)
}

private func duration(of source: FileAudioSource, path: String) async throws -> Double {
    let range = try await source.track.load(.timeRange)
    guard range.duration.isNumeric else { throw FileTranscriptionError.readFailed("長さが決まらない: \(path)") }
    return range.duration.seconds
}

public struct FileHeader: Equatable, Sendable {
    public let duration: Double
    public let audioTrackCount: Int

    public init(duration: Double, audioTrackCount: Int) {
        self.duration = duration
        self.audioTrackCount = audioTrackCount
    }
}

public func readFileHeader(of url: URL) async throws -> FileHeader {
    let source = try await FileAudioSource.open(url)
    return FileHeader(duration: try await duration(of: source, path: url.path), audioTrackCount: source.audioTrackCount)
}

public func broadcastFileHeader(_ header: FileHeader, on server: WebSocketServer) async {
    await server.send(.fileDuration(duration: header.duration))
    await server.send(.fileAudioTracks(count: header.audioTrackCount))
}

public struct FileAudioInputs: AsyncSequence {
    public typealias Element = AnalyzerInput

    let url: URL
    let alignment: FileReadingAlignment.Reader?
    let from: Double
    let gate: FileReadingGate?
    let diarization: FileDiarizationFeed?

    init(url: URL, alignment: FileReadingAlignment.Reader? = nil, from: Double = 0, gate: FileReadingGate? = nil, diarization: FileDiarizationFeed? = nil) {
        self.url = url
        self.alignment = alignment
        self.from = from
        self.gate = gate
        self.diarization = diarization
    }

    public func makeAsyncIterator() -> Iterator {
        Iterator(url: url, alignment: alignment, from: from, gate: gate, diarization: diarization)
    }

    public struct Iterator: AsyncIteratorProtocol {
        let url: URL
        let alignment: FileReadingAlignment.Reader?
        let from: Double
        let gate: FileReadingGate?
        let diarization: FileDiarizationFeed?
        private var reading: Reading?
        private var finished = false

        init(url: URL, alignment: FileReadingAlignment.Reader?, from: Double, gate: FileReadingGate?, diarization: FileDiarizationFeed?) {
            self.url = url
            self.alignment = alignment
            self.from = from
            self.gate = gate
            self.diarization = diarization
        }

        public mutating func next() async throws -> AnalyzerInput? {
            if finished { return nil }
            do {
                if Task.isCancelled { throw CancellationError() }
                if reading == nil { reading = try await Reading.open(url, from: from) }
                guard let reading else { return nil }
                try await alignment?.waitTurn(start: reading.position)
                try await gate?.waitOpen()
                let input = try await onFileReadingQueue { try reading.nextInput() }
                if input != nil { try await alignment?.waitUntilScreenEventsSent(before: reading.position) }
                if let input, let diarization {
                    let buffer = input.buffer
                    try await diarization.send(buffer: buffer, start: reading.position - Double(buffer.frameLength) / buffer.format.sampleRate)
                }
                if input == nil {
                    finished = true
                    await alignment?.finish()
                    await diarization?.finish()
                } else {
                    await alignment?.advance(to: reading.position)
                }
                return input
            } catch {
                finished = true
                reading?.reader.cancelReading()
                await alignment?.finish()
                await diarization?.finish()
                throw error
            }
        }
    }

    fileprivate final class Reading {
        let source: FileAudioSource
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        var framesRead: Int
        private var needsOrigin: Bool

        init(source: FileAudioSource, reader: AVAssetReader, output: AVAssetReaderTrackOutput, from: Double) {
            self.source = source
            self.reader = reader
            self.output = output
            self.framesRead = Int((from * source.sampleRate).rounded(.down))
            self.needsOrigin = from > 0
        }

        deinit { reader.cancelReading() }

        var position: Double { Double(framesRead) / source.sampleRate }

        func nextInput() throws -> AnalyzerInput? {
            while let sample = output.copyNextSampleBuffer() {
                if CMSampleBufferGetNumSamples(sample) == 0 { continue }
                // 途中から読むと、最初のサンプルは開始位置の少し前から始まることがある。位置は数え直さず、サンプルの PTS（ファイル上の位置）を使う
                if needsOrigin {
                    needsOrigin = false
                    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                    if pts.isFinite, pts >= 0 { framesRead = Int((pts * source.sampleRate).rounded()) }
                }
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

        static func open(_ url: URL, from: Double) async throws -> Reading {
            let source = try await FileAudioSource.open(url)
            let timeRange = from > 0 ? CMTimeRange(start: CMTime(seconds: from, preferredTimescale: CMTimeScale(source.sampleRate)), duration: .positiveInfinity) : nil
            let (reader, output) = try source.makeReader(.analyzing, timeRange: timeRange)
            return Reading(source: source, reader: reader, output: output, from: from)
        }
    }
}

final class FileLoudness {
    private let source: FileAudioSource
    private static let margin = 0.25

    init(source: FileAudioSource) {
        self.source = source
    }

    func verdict(start: Double, end: Double) -> SilenceVerdict {
        guard start.isFinite, end.isFinite, end > start else { return .unmeasurable(.emptySpan) }
        guard end > 0 else { return .unmeasurable(.beforeFirstAudio) }
        let sampleRate = source.sampleRate
        let firstFrame = Int((max(0, start) * sampleRate).rounded(.up))
        let endFrame = Int((end * sampleRate).rounded(.up))
        guard firstFrame < endFrame else { return .unmeasurable(.emptySpan) }

        let timescale = CMTimeScale(sampleRate)
        let readStart = max(0, Double(firstFrame) / sampleRate - Self.margin)
        let readEnd = Double(endFrame) / sampleRate + Self.margin
        guard let (reader, output) = try? source.makeReader(.measuring, timeRange: CMTimeRange(
            start: CMTime(seconds: readStart, preferredTimescale: timescale),
            end: CMTime(seconds: readEnd, preferredTimescale: timescale)))
        else { return .unmeasurable(.unsupportedFormat) }
        defer { reader.cancelReading() }

        var sum = 0.0
        var counted = 0
        while let sample = output.copyNextSampleBuffer() {
            let first = Int((CMSampleBufferGetPresentationTimeStamp(sample).seconds * sampleRate).rounded())
            if first >= endFrame { break }
            guard let buffer = try? source.pcmBuffer(from: sample, .measuring) else { return .unmeasurable(.unsupportedFormat) }
            let measurable = forEachFrameMeanSquare(of: buffer) { frame, meanSquare in
                let position = first + frame
                guard position >= firstFrame, position < endFrame else { return }
                sum += Double(meanSquare)
                counted += 1
            }
            if !measurable { return .unmeasurable(.unsupportedFormat) }
        }
        if reader.status == .failed { return .unmeasurable(.unsupportedFormat) }
        if counted == 0 { return .unmeasurable(.emptySpan) }
        return isSilentMeanSquare(sum / Double(counted)) ? .silent : .audible
    }
}

public func transcribeFile(
    at url: URL, with transcriber: any FileTranscriber, alignment: FileReadingAlignment.Reader? = nil, from: Double = 0, gate: FileReadingGate? = nil,
    diarization: FileDiarizationFeed? = nil
) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
    let loudness = FileLoudness(source: try await FileAudioSource.open(url))
    let results = try await transcriber.transcribe(FileAudioInputs(url: url, alignment: alignment, from: from, gate: gate, diarization: diarization))
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
    let task = Task {
        do {
            for try await result in results {
                let verdict = try await onFileReadingQueue { loudness.verdict(start: result.start, end: result.end) }
                if case .silent = verdict { continue }
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
