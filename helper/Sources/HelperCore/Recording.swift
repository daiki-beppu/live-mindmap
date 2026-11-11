import AVFoundation
import CoreAudio
import Foundation

let recordingSampleRate = 48_000.0
let recordingBitRate = 64_000
let recordingChannelCount = 1

public func recordingFileName(track: Track, attempt: Int) -> String {
    attempt > 1 ? "\(track.rawValue)-\(attempt).m4a" : "\(track.rawValue).m4a"
}

func leadingSilenceFrames(origin: UInt64, firstHostTime: UInt64, sampleRate: Double) -> AVAudioFrameCount {
    AVAudioFrameCount((offsetSeconds(from: origin, to: firstHostTime) * sampleRate).rounded())
}

public final class TrackRecorder: @unchecked Sendable {
    private let origin: UInt64
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var aligned = false

    public init(url: URL, origin: UInt64) throws {
        self.origin = origin
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: recordingSampleRate,
            AVNumberOfChannelsKey: recordingChannelCount,
            AVEncoderBitRateKey: recordingBitRate,
        ])
    }

    public func write(_ audio: CapturedAudio) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { return }
        let format = file.processingFormat
        if !aligned {
            aligned = true
            let silence = leadingSilenceFrames(origin: origin, firstHostTime: audio.hostTime, sampleRate: format.sampleRate)
            if silence > 0 { try Self.writeSilence(frames: silence, format: format, to: file) }
        }
        if converter == nil {
            converter = AVAudioConverter(from: audio.buffer.format, to: format)
            converter?.downmix = true
        }
        guard let converter else {
            throw TranscriberError.conversionFailed("\(audio.buffer.format) → \(format)")
        }
        try file.write(from: try SpeechAnalyzerTranscriber.convert(audio.buffer, with: converter, to: format))
    }

    public func finish() throws {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { return }
        self.file = nil
        if let converter {
            try file.write(from: try Self.drain(converter, to: file.processingFormat))
        }
    }

    private static func drain(_ converter: AVAudioConverter, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_384) else {
            throw TranscriberError.conversionFailed("出力バッファを作れない")
        }
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            inputStatus.pointee = .endOfStream
            return nil
        }
        if status == .error {
            throw TranscriberError.conversionFailed(conversionError?.localizedDescription ?? "不明")
        }
        return output
    }

    private static let maxSilenceChunkFrames: AVAudioFrameCount = 48_000

    private static func writeSilence(frames: AVAudioFrameCount, format: AVAudioFormat, to file: AVAudioFile) throws {
        var remaining = frames
        while remaining > 0 {
            let chunk = min(remaining, maxSilenceChunkFrames)
            try file.write(from: try silentBuffer(frames: chunk, format: format))
            remaining -= chunk
        }
    }

    private static func silentBuffer(frames: AVAudioFrameCount, format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
            throw TranscriberError.conversionFailed("無音のバッファを作れない")
        }
        buffer.frameLength = frames
        for channel in 0..<Int(format.channelCount) {
            if let samples = buffer.floatChannelData?[channel] { samples.update(repeating: 0, count: Int(frames)) }
        }
        return buffer
    }
}

let downstreamBacklogLimit = 2048

protocol TrackRecording: Sendable {
    func write(_ audio: CapturedAudio) throws
    func finish() throws
}

extension TrackRecorder: TrackRecording {}

public func recording(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>,
    to recorder: TrackRecorder
) -> (stream: AsyncThrowingStream<CapturedAudio, Error>, finished: Task<Void, Error>) {
    recordingStream(upstream, to: recorder)
}

func recordingStream<Recorder: TrackRecording>(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>,
    to recorder: Recorder
) -> (stream: AsyncThrowingStream<CapturedAudio, Error>, finished: Task<Void, Error>) {
    let (stream, continuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
    let finished = Task {
        do {
            for try await captured in upstream {
                try recorder.write(captured)
                if case .dropped = continuation.yield(captured) {
                    throw TranscriberError.backlogExceeded(limit: downstreamBacklogLimit)
                }
            }
        } catch {
            do { try recorder.finish() } catch {
                FileHandle.standardError.write(Data("録音の末尾を書けませんでした: \(error)\n".utf8))
            }
            continuation.finish(throwing: error)
            throw error
        }
        do { try recorder.finish() } catch {
            FileHandle.standardError.write(Data("録音の末尾を書けませんでした: \(error)\n".utf8))
            continuation.finish(throwing: error)
            throw error
        }
        continuation.finish()
    }
    return (stream, finished)
}
