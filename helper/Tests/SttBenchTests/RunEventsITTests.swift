import AVFoundation
import CoreAudio
import Foundation
import HelperCore
import Testing
@testable import stt_bench

// Issue #1031: `stt-bench run --events`。認識と話者分離を同じ音声（と、あれば 自分 の音声）に流し、
// 届いた時刻 arrival つきの HelperEvent を 1 行 1 イベントの JSON で出す（speakerReplay --offline がそのまま読める形）。
// 認識と話者分離は偽物で流すので CI でも流す。既定の出力（ResultLine）は RecognizeITTests が見る。

private final class FakeTranscriber: Transcriber, @unchecked Sendable {
    let results: [TranscriptionResult]
    init(results: [TranscriptionResult]) { self.results = results }

    func prepare() async throws {}

    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        for try await _ in audio {}
        let results = self.results
        return AsyncThrowingStream { c in
            results.forEach { c.yield($0) }
            c.finish()
        }
    }
}

private final class FakeDiarizer: SpeakerDiarizer, @unchecked Sendable {
    let items: [SpeakerDiarization]
    let failure: Error?
    private let lock = NSLock()
    private var _calls = 0
    var calls: Int { lock.withLock { _calls } }

    init(items: [SpeakerDiarization], failure: Error? = nil) {
        self.items = items
        self.failure = failure
    }

    func prepare() async throws {}

    func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error> {
        lock.withLock { _calls += 1 }
        for try await _ in audio {}
        let items = self.items
        let failure = self.failure
        return AsyncThrowingStream { c in
            if let failure {
                c.finish(throwing: failure)
                return
            }
            items.forEach { c.yield($0) }
            c.finish()
        }
    }
}

private struct DiarizerFailure: Error {}

private func writeSilence(seconds: Double) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("stt-bench-events-\(UUID().uuidString).wav")
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(16000 * seconds))!
    buffer.frameLength = buffer.frameCapacity
    try file.write(from: buffer)
    return url
}

private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    func add(_ line: String) { lock.withLock { _lines.append(line) } }
    /// 出た行を JSON として読んだもの（どの行も JSON のオブジェクトであること）
    var objects: [[String: Any]] {
        get throws {
            try lock.withLock { _lines }.map { line in
                try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            }
        }
    }
}

private let wordTimes = [WordTime(location: 0, length: 2, start: 0.1, end: 0.3)]
private let diarization: [SpeakerDiarization] = [
    .segment(SpeakerSegment(start: 0.1, end: 0.3, slot: 1, isFinal: true)),
    .segment(SpeakerSegment(start: 0.3, end: 0.4, slot: 0, isFinal: false)),
    .centroid(slot: 1, centroid: [1, 0]),
    .mixed(slot: 1, at: 0.3),
    .settled(to: 0.3),
]

@Suite("run --events: 認識と話者分離のイベントを arrival つきの JSONL にする", .timeLimit(.minutes(1)))
struct RunEventsITTests {
    private func run(selfResults: [TranscriptionResult]? = nil, diarizer: FakeDiarizer = FakeDiarizer(items: diarization)) async throws -> (lines: [[String: Any]], diarizer: FakeDiarizer) {
        let audio = try writeSilence(seconds: 0.35)
        let selfAudio = try selfResults.map { _ in try writeSilence(seconds: 0.25) }
        defer {
            try? FileManager.default.removeItem(at: audio)
            if let selfAudio { try? FileManager.default.removeItem(at: selfAudio) }
        }
        let lines = Lines()
        try await streamEvents(
            audio: audio,
            selfAudio: selfAudio,
            transcriber: FakeTranscriber(results: [
                TranscriptionResult(text: "明日の", isFinal: false, start: 0.1, end: 0.3),
                TranscriptionResult(text: "明日の会議。", isFinal: true, start: 0.1, end: 0.3, wordTimes: wordTimes),
            ]),
            selfTranscriber: selfResults.map { FakeTranscriber(results: $0) },
            diarizer: diarizer,
            start: ContinuousClock.now
        ) { lines.add($0) }
        return (try lines.objects, diarizer)
    }

    @Test("相手の確定結果は remark、途中結果は partial で、track は 相手。語の区間 wordTimes を持つ")
    func recognitionEvents() async throws {
        let lines = try await run().lines
        let remarks = lines.filter { $0["type"] as? String == "remark" }
        let partials = lines.filter { $0["type"] as? String == "partial" }
        #expect(remarks.count == 1)
        #expect(partials.count == 1)
        #expect(remarks[0]["track"] as? String == "相手")
        #expect(remarks[0]["text"] as? String == "明日の会議。")
        #expect(remarks[0]["start"] as? Double == 0.1)
        #expect(remarks[0]["end"] as? Double == 0.3)
        #expect((remarks[0]["wordTimes"] as? [[String: Any]])?.count == 1)
        #expect(remarks[0]["words"] != nil)
        #expect(partials[0]["track"] as? String == "相手")
    }

    @Test("話者分離の区間・確定済みの位置・混入・重心を、それぞれのイベントで出す（segment だけを出して他を捨てない）")
    func speakerEvents() async throws {
        let lines = try await run().lines
        let speakers = lines.filter { $0["type"] as? String == "speaker" }
        #expect(speakers.map { $0["slot"] as? Int } == [1, 0])
        #expect(speakers.map { $0["final"] as? Bool } == [true, false])
        #expect(speakers.allSatisfy { $0["track"] as? String == "相手" })
        let settled = lines.filter { $0["type"] as? String == "speaker-settled" }
        #expect(settled.count == 1)
        #expect(settled[0]["to"] as? Double == 0.3)
        let mixed = lines.filter { $0["type"] as? String == "speaker-mixed" }
        #expect(mixed.count == 1)
        #expect(mixed[0]["slot"] as? Int == 1)
        let centroids = lines.filter { $0["type"] as? String == "speaker-centroid" }
        #expect(centroids.count == 1)
        #expect((centroids[0]["centroid"] as? [Double]) == [1, 0])
    }

    @Test("どの行も arrival（流し始めからの秒）を持ち、話者分離の出力は流した順に届いた時刻が増える")
    func arrivalOnEveryLine() async throws {
        let lines = try await run().lines
        #expect(!lines.isEmpty)
        #expect(lines.allSatisfy { ($0["arrival"] as? Double ?? -1) >= 0 })
        let speakerArrivals = lines.filter { ($0["type"] as? String)?.hasPrefix("speaker") == true }.compactMap { $0["arrival"] as? Double }
        #expect(speakerArrivals.count == 5)
        #expect(speakerArrivals == speakerArrivals.sorted())
        // 実時間で音声（0.35 秒）を流し切ってから結果が届く
        #expect(speakerArrivals.allSatisfy { $0 >= 0.3 })
    }

    @Test("話者分離は 相手 の音声に 1 回だけ掛ける")
    func diarizesOnce() async throws {
        let result = try await run(selfResults: [TranscriptionResult(text: "はい。", isFinal: true, start: 0.0, end: 0.2)])
        #expect(result.diarizer.calls == 1)
    }

    @Test("自分 の音声を渡すと、その認識結果が track 自分 の remark として同じ出力に出る。渡さなければ 自分 の行は出ない")
    func selfTrack() async throws {
        let withSelf = try await run(selfResults: [TranscriptionResult(text: "はい。", isFinal: true, start: 0.0, end: 0.2)]).lines
        let selfRemarks = withSelf.filter { $0["track"] as? String == "自分" }
        #expect(selfRemarks.count == 1)
        #expect(selfRemarks[0]["type"] as? String == "remark")
        #expect(selfRemarks[0]["text"] as? String == "はい。")
        #expect(selfRemarks[0]["arrival"] is Double)
        #expect(withSelf.filter { $0["track"] as? String == "相手" && $0["type"] as? String == "remark" }.count == 1)

        let withoutSelf = try await run().lines
        #expect(withoutSelf.allSatisfy { $0["track"] as? String != "自分" })
    }

    @Test("話者分離が失敗したら run を失敗にする（話者なしで黙って続けない）")
    func diarizerFailureFails() async throws {
        await #expect(throws: DiarizerFailure.self) {
            _ = try await run(diarizer: FakeDiarizer(items: [], failure: DiarizerFailure()))
        }
    }
}
