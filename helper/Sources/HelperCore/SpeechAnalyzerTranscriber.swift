import AVFoundation
import Speech

public enum TranscriberError: Error, CustomStringConvertible {
    case unsupportedLocale(String)
    case noCompatibleFormat
    case conversionFailed(String)
    case backlogExceeded(limit: Int)

    public var description: String {
        switch self {
        case .unsupportedLocale(let id): return "SpeechTranscriber が \(id) に対応していない"
        case .noCompatibleFormat: return "SpeechAnalyzer が受け付ける音声形式を決められない"
        case .conversionFailed(let reason): return "音声形式の変換に失敗した: \(reason)"
        case .backlogExceeded(let limit): return "SpeechAnalyzer の処理が追いつかず、未消費の入力が上限（\(limit) 個）を超えた"
        }
    }
}

/// SpeechAnalyzer（ja-JP・端末内）をストリーミングで直接使う `Transcriber`。
public final class SpeechAnalyzerTranscriber: Transcriber {
    private let locale = Locale(identifier: "ja-JP")
    private let transcriber: SpeechTranscriber
    // 2048 個: ProcessTap の上限と同じ。通常の遅れは吸収し、analyzer が止まった場合だけ超える。
    private static let backlogLimit = 2048

    private var analyzerFormat: AVAudioFormat?

    public init() {
        transcriber = SpeechTranscriber(
            locale: Locale(identifier: "ja-JP"),
            transcriptionOptions: [],
            // .fastResults がないと、約 11.5 秒分の音声をまとめて処理し、途中結果も確定も塊で遅れて出る（2026-10-02 実測）
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.audioTimeRange]
        )
    }

    public func prepare() async throws {
        guard await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil else {
            throw TranscriberError.unsupportedLocale(locale.identifier)
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw TranscriberError.noCompatibleFormat
        }
        analyzerFormat = format
    }

    public func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        guard let format = analyzerFormat else { throw TranscriberError.noCompatibleFormat }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let limit = Self.backlogLimit
        let (inputs, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingOldest(limit))
        try await analyzer.start(inputSequence: inputs)

        let transcriber = self.transcriber
        let timeline = TrackTimeline(origin: origin)
        return AsyncThrowingStream { continuation in
            // 音声 → 変換 → AnalyzerInput。音声が終わったら入力を閉じ、残りを確定させる。
            let feeder = Task {
                var converter: AVAudioConverter?
                var received = false
                do {
                    for try await captured in audio {
                        received = true
                        let buffer = captured.buffer
                        // 結果の時刻は、アナライザに入れた最初の音声が 0。最初のバッファの取得時刻と共通の基準との差で補正する。
                        timeline.record(captured)
                        if converter == nil {
                            converter = AVAudioConverter(from: buffer.format, to: format)
                        }
                        guard let converter else {
                            throw TranscriberError.conversionFailed("\(buffer.format) → \(format)")
                        }
                        let input = AnalyzerInput(buffer: try Self.convert(buffer, with: converter, to: format))
                        // 満杯で入らなかった入力は捨てずに、エラーで終わらせる（時刻の意味を保つため）。
                        if case .dropped = inputBuilder.yield(input) {
                            throw TranscriberError.backlogExceeded(limit: limit)
                        }
                    }
                } catch {
                    inputBuilder.finish()
                    continuation.finish(throwing: error)
                    await analyzer.cancelAndFinishNow()
                    return
                }
                inputBuilder.finish()
                // 入力が 0 件のまま finalize を呼ぶと戻らず、結果の流れが終わらない（#70）。
                // 確定させる結果がないので、結果の流れを先に閉じてから analyzer を捨てる。
                if !received {
                    continuation.finish()
                    await analyzer.cancelAndFinishNow()
                    return
                }
                do {
                    try await analyzer.finalizeAndFinishThroughEndOfInput()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // SpeechTranscriber の結果 → TranscriptionResult。analyzer の終了で結果の流れも終わる。
            let collector = Task {
                do {
                    for try await result in transcriber.results {
                        let range = result.range
                        continuation.yield(timeline.align(TranscriptionResult(
                            text: String(result.text.characters),
                            isFinal: result.isFinal,
                            start: range.start.isNumeric ? range.start.seconds : 0,
                            end: range.end.isNumeric ? range.end.seconds : 0
                        )))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                feeder.cancel()
                collector.cancel()
            }
        }
    }

    public static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw TranscriberError.conversionFailed("出力バッファを作れない")
        }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            throw TranscriberError.conversionFailed(conversionError?.localizedDescription ?? "不明")
        }
        return output
    }
}
