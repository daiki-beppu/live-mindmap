import AVFoundation
import CoreAudio
import Foundation
import Speech
import Testing
@testable import HelperCore

// 録画のファイルの `相手` を話者分離にかける経路（Issue #1094。`transcribe-file` / `cli recorded`）の IT。
// ファイルはテストの中で作った合成の WAV。文字にする役と話者分離は偽物で、引き方（速さ・止まり・失敗）をテストが決める。
// 確かめること: 1 つの読み手が STT と話者分離の両方へ同じ音声を流す / 読む速さは遅いほう（話者分離）に抑えられる /
// 話者分離が使えない・途中で止まると `speaker-off` を流し、抑えが外れて STT の速さで最後まで読む /
// `--self` の 2 本は `相手` の話者分離の速さで読まれ、話者分離には `相手` の音声だけが渡る。
//
// 使う API（実装側が用意する）:
//   FileDiarization.prepare(_:from:emit:) … 話者分離を準備する。使えなければ `speakerOff(start: from, reason:)` を emit して `feed` が nil になる
//   FileDiarization.feed / run()          … 読み手が音声を渡す口 / 話者分離を走らせ、結果を emit する。流れが終わる（settled まで流し切る）と戻る
//   transcribeFile(…, diarization:) / relayFileSession(…, theirsDiarization:) … 読み手に `feed` を渡す（`相手` 側だけ）

private typealias Support = FileAudioTestSupport

private struct WaitTimedOut: Error, CustomStringConvertible {
    let condition: String
    var description: String { "待っていた条件が成り立たなかった: \(condition)" }
}

private func waitUntil(_ condition: String, _ check: @Sendable () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(20)
    while !check() {
        if ContinuousClock.now >= deadline { throw WaitTimedOut(condition: condition) }
        try await Task.sleep(for: .milliseconds(25))
    }
}

private final class Gate: @unchecked Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream(of: Void.self) }
    func open() { continuation.finish() }
    func wait() async { for await _ in stream {} }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var set = false
    func raise() { lock.withLock { set = true } }
    var isRaised: Bool { lock.withLock { set } }
}

/// 引いた入力の位置の記録（開始・終了の秒）。
private final class PullLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(reader: String, start: Double, end: Double)] = []
    func append(reader: String, start: Double, end: Double) { lock.withLock { items.append((reader, start, end)) } }
    func maxEnd(of reader: String) -> Double { lock.withLock { items.filter { $0.reader == reader }.map(\.end).max() ?? 0 } }
    var widest: Double { lock.withLock { items.map { $0.end - $0.start }.max() ?? 0 } }
}

/// 渡された音声をひたすら（`afterPull` の分だけ待って）引く偽の役。
private final class PullingTranscriber: FileTranscriber, @unchecked Sendable {
    private let name: String
    private let log: PullLog
    init(_ name: String, log: PullLog) {
        self.name = name
        self.log = log
    }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        // 本物の役と同じに、結果の流れはすぐ返し、音声は別のタスクで引く（`--self` の 2 本を順に始めるとき、片方が引き切るまで次を始められなくなるのを避ける）
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
        let name = name
        let log = log
        let task = Task {
            do {
                for try await input in inputs {
                    let start = try #require(input.bufferStartTime).seconds
                    log.append(reader: name, start: start, end: start + Double(input.buffer.frameLength) / input.buffer.format.sampleRate)
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }
}

private func drain(_ stream: AsyncThrowingStream<TranscriptionResult, Error>) async throws {
    for try await _ in stream {}
}

private struct StubFailure: Error {}

/// 受け取った音声を記録する偽の話者分離。`stallAfterFirst` が閉じている間は、最初の音声を受け取った後で次を受け取らない。
/// `failAfter` 件を受け取ったら流れを失敗で終える。`startFailure` があれば `diarize` が throw する。
private final class StubDiarizer: SpeakerDiarizer, @unchecked Sendable {
    struct Heard { let startSeconds: Double; let seconds: Double }

    private let lock = NSLock()
    private var heardItems: [Heard] = []
    private var origins: [UInt64] = []
    private var prepared = false
    let prepareFailure: Error?
    let startFailure: Error?
    let stallAfterFirst: Gate?
    let failAfter: Int?
    /// 入力ループを（どの経路でも）抜けたら立つ印。
    let inputLoopEnded = Flag()

    init(prepareFailure: Error? = nil, startFailure: Error? = nil, stallAfterFirst: Gate? = nil, failAfter: Int? = nil) {
        self.prepareFailure = prepareFailure
        self.startFailure = startFailure
        self.stallAfterFirst = stallAfterFirst
        self.failAfter = failAfter
    }

    var heard: [Heard] { lock.withLock { heardItems } }
    var heardEnd: Double { heard.map { $0.startSeconds + $0.seconds }.max() ?? 0 }
    var heardSeconds: Double { heard.reduce(0) { $0 + $1.seconds } }
    var receivedOrigins: [UInt64] { lock.withLock { origins } }

    func prepare() async throws {
        lock.withLock { prepared = true }
        if let prepareFailure { throw prepareFailure }
    }

    func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error> {
        lock.withLock { origins.append(origin) }
        if let startFailure { throw startFailure }
        return AsyncThrowingStream { continuation in
            let task = Task {
                defer { inputLoopEnded.raise() }
                do {
                    var count = 0
                    for try await item in audio {
                        let seconds = Double(item.buffer.frameLength) / item.buffer.format.sampleRate
                        // 時刻は、ホスト時刻の 0 からの秒（origin = 0 のとき、ファイルの音声の時刻）
                        let start = Double(AudioConvertHostTimeToNanos(item.hostTime)) / 1_000_000_000
                        lock.withLock { heardItems.append(Heard(startSeconds: start, seconds: seconds)) }
                        count += 1
                        if count == 1 {
                            continuation.yield(.segment(SpeakerSegment(start: start, end: start + seconds, slot: 0, isFinal: true)))
                            if let stallAfterFirst { await stallAfterFirst.wait() }
                        }
                        if let failAfter, count >= failAfter {
                            continuation.finish(throwing: StubFailure())
                            return
                        }
                    }
                    continuation.yield(.settled(to: heardEnd))
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// 結果を 1 回だけ置く箱。
private final class OutcomeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?
    func set(_ value: String) { lock.withLock { stored = value } }
    var value: String? { lock.withLock { stored } }
}

/// `emit` で受けたイベントの記録。
private final class Emitted: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [HelperEvent] = []
    func append(_ event: HelperEvent) { lock.withLock { items.append(event) } }
    var values: [HelperEvent] { lock.withLock { items } }
    var speakerOffs: [(start: Double, reason: SpeakerOffReason)] {
        values.compactMap { if case let .speakerOff(start, reason) = $0 { return (start, reason) } else { return nil } }
    }
}

private func writeWAV(_ dir: URL, _ name: String, seconds: Double) throws -> URL {
    let url = dir.appendingPathComponent(name)
    try Support.writeWAV(url, loudSeconds: seconds, silentSeconds: 0)
    return url
}

@Suite("録画の `相手` を話者分離にかける（FileDiarization）", .timeLimit(.minutes(1)))
struct FileDiarizationITTests {
    @Test("話者分離が止まっている間、STT は話者分離が受け取った位置を 1 つの入力ぶんより先へ進まない。止まりが解けると両方が最後まで読み切り、話者分離は同じ音声を順に（ファイル上の位置の時刻で、開始位置 from を含めて）受け取り、その区間と確定済みの位置が `相手` のイベントとして流れる")
    func readingIsLimitedToTheDiarizer() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = try writeWAV(dir, "them.wav", seconds: 30)
        let gate = Gate()
        let diarizer = StubDiarizer(stallAfterFirst: gate)
        let emitted = Emitted()
        let diarization = await FileDiarization.prepare(diarizer, from: 2) { emitted.append($0) }
        let feed = try #require(diarization.feed)
        let log = PullLog()

        let diarizing = Task { await diarization.run() }
        let transcribing = Task {
            try await drain(try await transcribeFile(at: url, with: PullingTranscriber("相手", log: log), from: 2, diarization: feed))
        }
        defer {
            gate.open()
            diarizing.cancel()
            transcribing.cancel()
        }
        try await waitUntil("話者分離が最初の入力を受け取る") { diarizer.heardEnd > 0 }
        try await Task.sleep(for: .milliseconds(500)) // 抑えが無ければ、この間に STT は 30 秒を読み切る

        let diarizerPosition = diarizer.heardEnd
        let widest = log.widest
        try #require(diarizerPosition + widest < 30) // 前提: 1 つの入力ぶんの余裕を足しても、ファイルの終わりに届かない
        #expect(log.maxEnd(of: "相手") <= diarizerPosition + widest + 0.001,
            "STT が話者分離の位置 \(diarizerPosition) 秒より先の \(log.maxEnd(of: "相手")) 秒まで読んだ")

        gate.open()
        try await transcribing.value
        await diarizing.value
        #expect(abs(log.maxEnd(of: "相手") - 30) < 0.01)
        #expect(abs(diarizer.heardEnd - 30) < 0.01)
        // 同じ音声を、取りこぼしなく順に受け取る（開始位置 2 秒から、隙間も重なりもなく 30 秒まで）
        let heard = diarizer.heard
        try #require(!heard.isEmpty)
        #expect(abs(heard[0].startSeconds - 2) < 0.001, "最初の入力はファイル上の位置 2 秒から")
        for (previous, next) in zip(heard, heard.dropFirst()) {
            #expect(abs(previous.startSeconds + previous.seconds - next.startSeconds) < 0.001, "入力が連続していない")
        }
        #expect(diarizer.receivedOrigins == [0], "原点は 0（STT と同じファイルの音声の時刻）")

        let expectedSegment = event(from: .segment(SpeakerSegment(start: 2, end: 2 + heard[0].seconds, slot: 0, isFinal: true)), track: .相手)
        let values = emitted.values
        #expect(values.first == expectedSegment)
        #expect(values.last == event(from: .settled(to: diarizer.heardEnd), track: .相手))
        #expect(emitted.speakerOffs.isEmpty)
    }

    @Test("話者分離の準備に失敗すると、開始位置 from の `speaker-off`（理由はモデルなし / 読み込みに失敗）を流し、読み手は話者分離を待たずに最後まで読み切る")
    func unavailableDiarizerSendsSpeakerOffAndReadsFreely() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = try writeWAV(dir, "them.wav", seconds: 12)
        let cases: [(error: Error, reason: SpeakerOffReason)] = [
            (SpeakerDiarizerError.modelMissing(URL(fileURLWithPath: "/nonexistent/model")), .モデルなし),
            (StubFailure(), .読み込みに失敗),
        ]
        for (error, reason) in cases {
            let emitted = Emitted()
            let diarization = await FileDiarization.prepare(StubDiarizer(prepareFailure: error), from: 4) { emitted.append($0) }
            #expect(diarization.feed == nil)
            #expect(emitted.speakerOffs.count == 1)
            #expect(emitted.speakerOffs.first?.start == 4)
            #expect(emitted.speakerOffs.first?.reason == reason)
            await diarization.run() // 使えないときは何もせず戻る
            let log = PullLog()
            try await drain(try await transcribeFile(at: url, with: PullingTranscriber("相手", log: log), from: 4, diarization: diarization.feed))
            #expect(abs(log.maxEnd(of: "相手") - 12) < 0.01)
            #expect(emitted.speakerOffs.count == 1)
            #expect(emitted.values.count == 1, "使えない話者分離は、`speaker-off` 以外のイベントを流さない")
        }
    }

    @Test("話者分離を始められないと（diarize が throw）、`speaker-off`（読み込みに失敗）を流し、抑えが外れて STT は最後まで読み切る")
    func diarizerFailingToStartLiftsTheLimit() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = try writeWAV(dir, "them.wav", seconds: 20)
        let emitted = Emitted()
        let diarization = await FileDiarization.prepare(StubDiarizer(startFailure: StubFailure()), from: 0) { emitted.append($0) }
        let log = PullLog()
        let diarizing = Task { await diarization.run() }
        defer { diarizing.cancel() }
        try await drain(try await transcribeFile(at: url, with: PullingTranscriber("相手", log: log), diarization: diarization.feed))
        await diarizing.value
        #expect(abs(log.maxEnd(of: "相手") - 20) < 0.01)
        #expect(emitted.speakerOffs.map(\.reason) == [.読み込みに失敗])
    }

    @Test("話者分離が途中で止まると、`speaker-off`（途中で停止）を 1 回だけ流し、止まった話者分離を待っていた読み手は抑えが外れて最後まで読み切る")
    func diarizerStoppingMidwayLiftsTheLimit() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = try writeWAV(dir, "them.wav", seconds: 30)
        let gate = Gate()
        // 最初の入力を受け取って止まり、止まりが解けると 1 件目の後で失敗する
        let diarizer = StubDiarizer(stallAfterFirst: gate, failAfter: 1)
        let emitted = Emitted()
        let diarization = await FileDiarization.prepare(diarizer, from: 0) { emitted.append($0) }
        let log = PullLog()
        let diarizing = Task { await diarization.run() }
        let transcribing = Task {
            try await drain(try await transcribeFile(at: url, with: PullingTranscriber("相手", log: log), diarization: diarization.feed))
        }
        defer {
            gate.open()
            diarizing.cancel()
            transcribing.cancel()
        }
        try await waitUntil("話者分離が最初の入力を受け取る") { diarizer.heardEnd > 0 }
        try await Task.sleep(for: .milliseconds(300))
        try #require(log.maxEnd(of: "相手") < 30) // 前提: 失敗前は抑えられている

        gate.open() // 話者分離が失敗する
        try await transcribing.value // 抑えが外れ、待たずに最後まで読み切る
        await diarizing.value
        #expect(abs(log.maxEnd(of: "相手") - 30) < 0.01)
        #expect(emitted.speakerOffs.map(\.reason) == [.途中で停止])
        let off = try #require(emitted.speakerOffs.first)
        #expect(off.start >= 0 && off.start <= 30)
    }

    @Test("話者分離が入力待ちのときに、文字起こしが入力を引く前に失敗しても、並べて動かす処理は期限内に元のエラーで戻り、話者分離も終わる")
    func transcriptionFailingBeforePullingEndsTheDiarizerToo() async throws {
        let diarizer = StubDiarizer()
        let diarization = await FileDiarization.prepare(diarizer, from: 0) { _ in }
        _ = try #require(diarization.feed)
        let outcome = OutcomeBox()

        let running = Task {
            do {
                try await diarization.run {
                    // 話者分離が入力待ちに入ってから、feed に触らずに失敗する
                    try await waitUntil("話者分離が diarize に入る") { diarizer.receivedOrigins == [0] }
                    try await Task.sleep(for: .milliseconds(200))
                    throw StubFailure()
                }
                outcome.set("成功")
            } catch is StubFailure {
                outcome.set("StubFailure")
            } catch {
                outcome.set("別のエラー: \(error)")
            }
        }
        defer { running.cancel() }
        try await waitUntil("並べて動かす処理が戻る") { outcome.value != nil }
        #expect(outcome.value == "StubFailure")
        try await waitUntil("話者分離の入力ループが終わる") { diarizer.inputLoopEnded.isRaised }
    }

    @Test("`--self` の 2 本は、`相手` の話者分離の速さで両方が読まれ（自分は相手の位置を越えない）、話者分離には `相手` の音声だけが渡る。止まりが解けると両方が最後まで読み切る")
    func pairIsPacedByTheirsDiarizerAndOnlyTheirsIsDiarized() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = try writeWAV(dir, "them.wav", seconds: 30)
        let mine = try writeWAV(dir, "me.wav", seconds: 20)
        let gate = Gate()
        let diarizer = StubDiarizer(stallAfterFirst: gate)
        let diarization = await FileDiarization.prepare(diarizer, from: 0) { _ in }
        let feed = try #require(diarization.feed)
        let log = PullLog()
        let server = WebSocketServer(port: 0)
        _ = try await server.start()

        let diarizing = Task { await diarization.run() }
        let relaying = Task {
            try await relayFileSession(
                theirs: FileSessionSource(url: theirs, transcriber: PullingTranscriber("相手", log: log), from: 0),
                mine: FileSessionSource(url: mine, transcriber: PullingTranscriber("自分", log: log), from: 0),
                to: server, theirsDiarization: feed)
        }
        defer {
            gate.open()
            diarizing.cancel()
            relaying.cancel()
        }
        // 成功・失敗のどちらでも待ち受けを閉じる
        defer { Task { await server.stop() } }
        try await waitUntil("話者分離が最初の入力を受け取る") { diarizer.heardEnd > 0 }
        try await Task.sleep(for: .milliseconds(500)) // 抑えが無ければ、この間に 2 本とも読み切る

        let diarizerPosition = diarizer.heardEnd
        let widest = log.widest
        try #require(diarizerPosition + 2 * widest < 20)
        // 相手は話者分離の位置まで、自分は相手の位置まで。どちらも 1 つの入力ぶんの余裕
        #expect(log.maxEnd(of: "相手") <= diarizerPosition + widest + 0.001)
        #expect(log.maxEnd(of: "自分") <= diarizerPosition + 2 * widest + 0.001,
            "自分が話者分離の位置 \(diarizerPosition) 秒より先の \(log.maxEnd(of: "自分")) 秒まで読んだ")

        gate.open()
        try await relaying.value
        await diarizing.value
        #expect(abs(log.maxEnd(of: "相手") - 30) < 0.01)
        #expect(abs(log.maxEnd(of: "自分") - 20) < 0.01)
        // 話者分離が受け取った音声の長さは `相手` の 30 秒だけ（自分の 20 秒は入っていない）
        #expect(abs(diarizer.heardSeconds - 30) < 0.01, "話者分離が受け取った音声の合計が \(diarizer.heardSeconds) 秒")
        await server.stop()
    }
}
