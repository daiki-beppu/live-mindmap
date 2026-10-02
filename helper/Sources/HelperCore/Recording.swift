import AVFoundation
import CoreAudio
import Foundation

// トラックごとの録音（AAC・モノラル）。0 秒は発言の時刻の基準（origin）と同じ時点にそろえ、
// 議事録の発言の時刻から、そのまま音声を聞き返せるようにする。

// 録音の音質。後で話者分離（pyannote など）にかけられるよう、AAC は 64 kbps 以上、サンプルレートは 16 kHz 以上を保つ。
// モノラルへの変換は左右の平均（会議アプリの音は左右がほぼ同じで、話者の情報はチャンネルにない）。
let recordingSampleRate = 48_000.0
let recordingBitRate = 64_000
let recordingChannelCount = 1

/// 基準時刻 `origin` から最初のバッファの取得時刻までの無音のフレーム数。取得時刻が基準と同じか前なら 0。
func leadingSilenceFrames(origin: UInt64, firstHostTime: UInt64, sampleRate: Double) -> AVAudioFrameCount {
    AVAudioFrameCount((offsetSeconds(from: origin, to: firstHostTime) * sampleRate).rounded())
}

/// 1 トラック分の録音ファイル（AAC・48 kHz・モノラル）。最初のバッファの前だけ、基準との差の分の無音を入れる。
/// 途中の取得の空白は無音で埋めない。発言の時刻（`TrackTimeline`）も空白を数えないので、同じ規則にそろえることで
/// 発言の時刻と録音の位置が一致する。
/// 書き込みは 1 つの流れ（`recording(_:to:)` の Task）から順に呼ぶ。`finish` は何度呼んでもよい。
public final class TrackRecorder: @unchecked Sendable {
    private let origin: UInt64
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var aligned = false

    public init(url: URL, origin: UInt64) throws {
        self.origin = origin
        // フォルダの不備などは、ここで早く失敗させる
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
            if silence > 0 { try file.write(from: try Self.silentBuffer(frames: silence, format: format)) }
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

    /// ファイルを閉じる。閉じた後の `write` と、2 回目以降の `finish` は何もしない（投げない）。
    /// 閉じる前に、サンプルレート変換器が持ち越した末尾の音声を書き出す。書けなくても閉じてから、その失敗を投げる。
    public func finish() throws {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { return }
        self.file = nil
        if let converter {
            try file.write(from: try Self.drain(converter, to: file.processingFormat))
        }
    }

    /// 入力の終わりを伝え、変換器に残っている出力を取り出す。
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

// 下流（文字起こし）へ渡す未消費のバッファの上限。ProcessTap と同じ。
private let downstreamBacklogLimit = 2048

/// `recording` が使う録音の操作。実際の録音は `TrackRecorder`。テストでは `finish` の失敗を差し替える。
protocol TrackRecording: Sendable {
    func write(_ audio: CapturedAudio) throws
    func finish() throws
}

extension TrackRecorder: TrackRecording {}

/// 上流の音声を 1 つずつ録音に書いてから、下流へ流す。
/// 上流が終わったとき（正常・エラーとも）か書き込みに失敗したときに、録音を閉じてから下流を終わらせる。
/// 下流が先に終わっても、録音は上流の終わりまで続ける。`finished` は録音を閉じた時点で完了する。
/// 録音の末尾を書けなかったとき（`finish` の失敗）は、上流が正常に終わっていれば、下流と `finished` をその失敗で終わらせる。
/// 書き込みや上流のエラーが先にあれば、そのエラーが基準で、`finish` の失敗は標準エラーに記録するだけにする。
/// 取得側のコールバックでは書かず、この Task で書く（リアルタイムに近いスレッドを塞がない）。
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
                // 満杯で入らなかったバッファは捨てずに、エラーで終わらせる（時刻の意味を保つため）。
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
