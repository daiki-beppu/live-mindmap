import AVFoundation
import CoreMedia
import Foundation
import HelperCore
import Speech

// 候補の設定。baseline は本番の `SpeechAnalyzerTranscriber` そのもので、それ以外はここで analyzer を組む（本番の挙動は変えない）。

struct Variant {
    var name: String
    var detail: String
    var reporting: Set<SpeechTranscriber.ReportingOption> = [.volatileResults, .fastResults]
    var attributes: Set<SpeechTranscriber.ResultAttributeOption> = [.audioTimeRange]
    var preset: SpeechTranscriber.Preset?
    var detector: SpeechDetector.SensitivityLevel?
    /// 結果がこの秒数更新されなければ、`finalize(through:)` で確定を促す
    var finalizeAfterQuiet: Double?
    var priority: TaskPriority?
    var ignoresResourceLimits = false
}

let variants: [Variant] = [
    Variant(name: "baseline", detail: "本番の設定（volatile + fast, audioTimeRange）"),
    Variant(name: "no-fast", detail: "volatileResults のみ（fastResults なし）", reporting: [.volatileResults]),
    Variant(name: "final-only", detail: "途中結果なし（fastResults のみ）", reporting: [.fastResults]),
    Variant(name: "alternatives", detail: "volatile + fast + alternativeTranscriptions", reporting: [.volatileResults, .fastResults, .alternativeTranscriptions]),
    Variant(name: "confidence", detail: "attributeOptions に transcriptionConfidence を足す", attributes: [.audioTimeRange, .transcriptionConfidence]),
    Variant(name: "preset-progressive", detail: "Preset.timeIndexedProgressiveTranscription", preset: .timeIndexedProgressiveTranscription),
    Variant(name: "detector-low", detail: "SpeechDetector（感度 low）を足す", detector: .low),
    Variant(name: "detector-medium", detail: "SpeechDetector（感度 medium）を足す", detector: .medium),
    Variant(name: "detector-high", detail: "SpeechDetector（感度 high）を足す", detector: .high),
    Variant(name: "finalize-1s", detail: "1 秒更新がなければ finalize(through:)", finalizeAfterQuiet: 1),
    Variant(name: "finalize-2s", detail: "2 秒更新がなければ finalize(through:)", finalizeAfterQuiet: 2),
    Variant(name: "finalize-3s", detail: "3 秒更新がなければ finalize(through:)", finalizeAfterQuiet: 3),
    Variant(name: "priority", detail: "Options(priority: .userInitiated, modelRetention: .processLifetime)", priority: .userInitiated),
    Variant(name: "ignore-limits", detail: "ignoresResourceLimits（macOS 27 以降）", priority: .userInitiated, ignoresResourceLimits: true),
]

func makeTranscriber(_ variant: Variant) -> any Transcriber {
    variant.name == "baseline" ? SpeechAnalyzerTranscriber() : BenchTranscriber(variant)
}

/// baseline 以外の候補を試す `Transcriber`。入力の変換は本番の `SpeechAnalyzerTranscriber.convert` を使う。
final class BenchTranscriber: Transcriber, @unchecked Sendable {
    private let variant: Variant
    private let locale = Locale(identifier: "ja-JP")
    private let transcriber: SpeechTranscriber
    private let detector: SpeechDetector?
    private var analyzerFormat: AVAudioFormat?

    init(_ variant: Variant) {
        self.variant = variant
        if let preset = variant.preset {
            transcriber = SpeechTranscriber(locale: locale, preset: preset)
        } else {
            transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: variant.reporting, attributeOptions: variant.attributes)
        }
        detector = variant.detector.map { SpeechDetector(detectionOptions: .init(sensitivityLevel: $0), reportResults: false) }
    }

    private var modules: [any SpeechModule] {
        detector.map { [transcriber, $0] } ?? [transcriber]
    }

    private var options: SpeechAnalyzer.Options? {
        guard let priority = variant.priority else { return nil }
        #if compiler(>=6.4)
        if variant.ignoresResourceLimits, #available(macOS 27, *) {
            return SpeechAnalyzer.Options(priority: priority, modelRetention: .processLifetime, ignoresResourceLimits: true)
        }
        #endif
        return SpeechAnalyzer.Options(priority: priority, modelRetention: .processLifetime)
    }

    func prepare() async throws {
        guard await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil else {
            throw TranscriberError.unsupportedLocale(locale.identifier)
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
            throw TranscriberError.noCompatibleFormat
        }
        analyzerFormat = format
    }

    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        guard let format = analyzerFormat else { throw TranscriberError.noCompatibleFormat }
        let analyzer = SpeechAnalyzer(modules: modules, options: options)
        let (inputs, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self)
        try await analyzer.start(inputSequence: inputs)

        let transcriber = self.transcriber
        let quiet = variant.finalizeAfterQuiet
        let progress = ResultProgress()
        return AsyncThrowingStream { continuation in
            let feeder = Task {
                var converter: AVAudioConverter?
                do {
                    for try await captured in audio {
                        let buffer = captured.buffer
                        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: format) }
                        guard let converter else { throw TranscriberError.conversionFailed("\(buffer.format) → \(format)") }
                        inputBuilder.yield(AnalyzerInput(buffer: try SpeechAnalyzerTranscriber.convert(buffer, with: converter, to: format)))
                    }
                    inputBuilder.finish()
                    try await analyzer.finalizeAndFinishThroughEndOfInput()
                } catch {
                    inputBuilder.finish()
                    continuation.finish(throwing: error)
                    await analyzer.cancelAndFinishNow()
                }
            }
            let collector = Task {
                do {
                    for try await result in transcriber.results {
                        let range = result.range
                        let end = range.end.isNumeric ? range.end.seconds : 0
                        if !result.isFinal { progress.record(volatileEnd: end) } else { progress.recordFinal(through: end) }
                        continuation.yield(TranscriptionResult(
                            text: String(result.text.characters),
                            isFinal: result.isFinal,
                            start: range.start.isNumeric ? range.start.seconds : 0,
                            end: end
                        ))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // 候補: 途中結果がしばらく更新されなければ、そこまでの確定を analyzer に促す
            let watchdog = quiet.map { quiet in
                Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(100))
                        let outcome = await finalizeStep(progress: progress, quiet: quiet) { end in
                            try await analyzer.finalize(through: CMTime(seconds: end, preferredTimescale: 600))
                        }
                        switch outcome {
                        case .idle: break
                        case let .finalized(end): logFinalize("finalize(through: \(end)) ok")
                        case let .failed(end, message): logFinalize("finalize(through: \(end)) failed: \(message)")
                        }
                    }
                }
            }
            continuation.onTermination = { _ in
                feeder.cancel()
                collector.cancel()
                watchdog?.cancel()
            }
        }
    }
}

/// finalize の成否を stderr に 1 行書く（stdout は JSONL 専用）。
private func logFinalize(_ line: String) {
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

/// watchdog の 1 回分の処理の結果。
enum FinalizeOutcome: Equatable {
    case idle
    case finalized(through: Double)
    case failed(through: Double, message: String)
}

/// watchdog の 1 回分: 静かな位置があれば `finalize` を呼び、成功したときだけその位置を処理済みにする。
/// 失敗した位置は処理済みにしないので、次の周期で再び対象になる。
func finalizeStep(progress: ResultProgress, quiet: Double, finalize: (Double) async throws -> Void) async -> FinalizeOutcome {
    guard let end = progress.quietEnd(for: quiet) else { return .idle }
    do {
        try await finalize(end)
        progress.markFinalized(through: end)
        return .finalized(through: end)
    } catch {
        return .failed(through: end, message: "\(error)")
    }
}

/// 途中結果の最後の更新時刻と、確定を促した位置。collector と watchdog が共有する。
final class ResultProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var lastUpdate: ContinuousClock.Instant?
    private var volatileEnd = 0.0
    private var finalizedThrough = 0.0

    func record(volatileEnd end: Double) {
        lock.lock()
        defer { lock.unlock() }
        lastUpdate = .now
        volatileEnd = max(volatileEnd, end)
    }

    func recordFinal(through end: Double) {
        lock.lock()
        defer { lock.unlock() }
        finalizedThrough = max(finalizedThrough, end)
    }

    /// 最後の更新から `quiet` 秒たち、まだ確定していない途中結果があれば、その end を返す（状態は変えない）。
    func quietEnd(for quiet: Double) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        guard let lastUpdate, volatileEnd > finalizedThrough, lastUpdate.duration(to: .now) >= .seconds(quiet) else { return nil }
        return volatileEnd
    }

    /// `end` までを処理済みにする。確定を促す呼び出しが成功したときに使う。
    func markFinalized(through end: Double) {
        lock.lock()
        defer { lock.unlock() }
        finalizedThrough = max(finalizedThrough, end)
    }
}
