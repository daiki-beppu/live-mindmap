import AVFoundation
import Foundation
import Speech
import Testing
@testable import HelperCore

// 2 本のファイルの読み手を、同じ音声の時刻に揃える（FileReadingAlignment。`cli recorded --self`）の IT。
// ファイルはテストの中で作った合成の WAV。文字にする役は偽物で、引いた入力の位置を記録し、引き方（速さ・止まり）をテストが決める。
// 確かめること: 先に進む読み手は、もう一方の読み終えた位置を超えて先へ進まない / 終わった読み手は待たせない /
// 待ちはキャンセルに応じる / 揃えた位置が時計（now・sleep）になる / 揃える相手が無ければ今までと同じ。

private typealias Support = FileAudioTestSupport

/// 引いた入力の位置の記録。1 件 = ある読み手が受け取った 1 つの入力（開始・終了の秒）。
private struct Pulled: Equatable {
    let reader: String
    let start: Double
    let end: Double
}

private final class PullLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Pulled] = []
    func append(_ item: Pulled) { lock.withLock { items.append(item) } }
    var values: [Pulled] { lock.withLock { items } }
    func ends(of reader: String) -> [Double] { values.filter { $0.reader == reader }.map(\.end) }
    func maxEnd(of reader: String) -> Double { ends(of: reader).max() ?? 0 }
}

/// 渡された音声を引くたびに `afterPull` を呼ぶ偽の役。`afterPull` が止まっている間、その読み手は次の入力を引かない。
private final class PacedFileTranscriber: FileTranscriber, @unchecked Sendable {
    private let name: String
    private let log: PullLog
    private let afterPull: @Sendable (Pulled) async throws -> Void

    init(_ name: String, log: PullLog, afterPull: @escaping @Sendable (Pulled) async throws -> Void = { _ in }) {
        self.name = name
        self.log = log
        self.afterPull = afterPull
    }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        for try await input in inputs {
            let start = try #require(input.bufferStartTime).seconds
            let end = start + Double(input.buffer.frameLength) / input.buffer.format.sampleRate
            let pulled = Pulled(reader: name, start: start, end: end)
            log.append(pulled)
            try await afterPull(pulled)
        }
        return AsyncThrowingStream { $0.finish() }
    }
}

private func drain(_ stream: AsyncThrowingStream<TranscriptionResult, Error>) async throws {
    for try await _ in stream {}
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

private struct WaitTimedOut: Error, CustomStringConvertible {
    let condition: String
    var description: String { "待っていた条件が成り立たなかった: \(condition)" }
}

/// 条件が成り立つまで、壁時計の期限（10 秒）まで待つ。期限が切れたら、待っていた条件を示して throw する。
private func waitUntil(_ condition: String, _ check: @Sendable () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while !check() {
        if ContinuousClock.now >= deadline { throw WaitTimedOut(condition: condition) }
        try await Task.sleep(for: .milliseconds(25))
    }
}

private func writeWAVs(in dir: URL, theirsSeconds: Double, mineSeconds: Double) throws -> (theirs: URL, mine: URL) {
    let theirs = dir.appendingPathComponent("them.wav")
    let mine = dir.appendingPathComponent("me.wav")
    try Support.writeWAV(theirs, loudSeconds: theirsSeconds, silentSeconds: 0)
    try Support.writeWAV(mine, loudSeconds: mineSeconds, silentSeconds: 0)
    return (theirs, mine)
}

@Suite("2 本の読み手を音声の時刻に揃える（FileReadingAlignment）", .timeLimit(.minutes(1)))
struct FileReadingAlignmentITTests {
    @Test("一方が止まっている間、もう一方は止まっている側の読み終えた位置を 1 つの入力ぶんより先へ進まない。止まりが解けると、両方が最後まで読み切る")
    func leaderWaitsForLaggingReader() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: 30, mineSeconds: 30)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader()
        let mineReader = await alignment.addReader()
        let log = PullLog()
        let gate = Gate()
        let slowGotFirst = Flag()
        // 自分は最初の入力を引いたところで止まる。相手はひたすら引く。
        let slow = PacedFileTranscriber("自分", log: log) { _ in
            slowGotFirst.raise()
            await gate.wait()
        }
        let fast = PacedFileTranscriber("相手", log: log)

        let slowTask = Task { try await drain(try await transcribeFile(at: mine, with: slow, alignment: mineReader)) }
        let fastTask = Task { try await drain(try await transcribeFile(at: theirs, with: fast, alignment: theirsReader)) }
        // 途中で失敗しても、待っているタスクを残さない（正常終了後は何もしない）
        defer {
            gate.open()
            slowTask.cancel()
            fastTask.cancel()
        }
        try await waitUntil("遅い側が最初の入力を受け取る") { slowGotFirst.isRaised }
        try await Task.sleep(for: .milliseconds(500)) // 揃える処理が無ければ、この間に相手は 30 秒を読み切る

        let slowPosition = log.maxEnd(of: "自分")
        // 速い側が止まっている側の位置まで進むのを待つ（負荷で読み出しが遅れても、検証の前提を満たす）
        try await waitUntil("速い側が遅い側の位置まで読む") { log.maxEnd(of: "相手") >= slowPosition }
        let fastPosition = log.maxEnd(of: "相手")
        let widest = log.values.map { $0.end - $0.start }.max() ?? 0
        try #require(slowPosition > 0)
        try #require(slowPosition + widest < 30) // 前提: 1 つの入力ぶんの余裕を足しても、ファイルの終わりに届かない
        #expect(fastPosition >= slowPosition) // 止まっている側の位置までは、待たずに進める
        #expect(fastPosition <= slowPosition + widest, "先へ進む側が、止まっている側の位置 \(slowPosition) 秒より \(fastPosition - slowPosition) 秒先まで読んだ")
        // 揃えた位置（時計）は、止まっている側の位置
        #expect(abs(await alignment.now() - slowPosition) < 0.001)

        gate.open()
        try await slowTask.value
        try await fastTask.value
        #expect(abs(log.maxEnd(of: "自分") - 30) < 0.01)
        #expect(abs(log.maxEnd(of: "相手") - 30) < 0.01)
    }

    @Test("開始位置（from）から読み始める読み手は、位置が 0 のままではなく開始位置から始まる。2 本とも開始位置から始めると、互いを待ち続けて止まらず、どちらも開始位置から最後まで読み切る")
    func readersStartingAtFromDoNotStall() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: 20, mineSeconds: 20)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader(from: 10)
        let mineReader = await alignment.addReader(from: 10)
        // 読み始める前の時計は開始位置（0 だと、互いに 10 秒の位置の入力を待ち続けて止まる）
        #expect(abs(await alignment.now() - 10) < 0.001)
        let log = PullLog()
        let theirsDone = Flag()
        let mineDone = Flag()

        let theirsTask = Task {
            try await drain(try await transcribeFile(at: theirs, with: PacedFileTranscriber("相手", log: log), alignment: theirsReader, from: 10))
            theirsDone.raise()
        }
        let mineTask = Task {
            try await drain(try await transcribeFile(at: mine, with: PacedFileTranscriber("自分", log: log), alignment: mineReader, from: 10))
            mineDone.raise()
        }
        defer {
            theirsTask.cancel()
            mineTask.cancel()
        }
        try await waitUntil("2 本とも読み切る") { theirsDone.isRaised && mineDone.isRaised }

        for reader in ["相手", "自分"] {
            let starts = log.values.filter { $0.reader == reader }.map(\.start)
            #expect(abs((starts.min() ?? -1) - 10) < 0.001, "\(reader) は開始位置の 10 秒から読み始める")
            #expect(abs(log.maxEnd(of: reader) - 20) < 0.01)
        }
    }

    @Test("速さの違う 2 本を並べて引いても、どの時点でも 2 本の読み終えた位置の差は 1 つの入力ぶんを超えない。両方とも最後まで読み切る")
    func readersStayWithinOneBufferOfEachOther() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: 20, mineSeconds: 20)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader()
        let mineReader = await alignment.addReader()
        let log = PullLog()
        let slow = PacedFileTranscriber("自分", log: log) { _ in try await Task.sleep(for: .milliseconds(10)) }
        let fast = PacedFileTranscriber("相手", log: log)

        async let slowRun: Void = drain(try await transcribeFile(at: mine, with: slow, alignment: mineReader))
        async let fastRun: Void = drain(try await transcribeFile(at: theirs, with: fast, alignment: theirsReader))
        try await slowRun
        try await fastRun

        let all = log.values
        let widest = all.map { $0.end - $0.start }.max() ?? 0
        // 受け取った入力の開始位置は、もう一方が記録した位置（記録は受け取りの後なので、直前の 1 件ぶんの遅れを許す）を超えない
        var seenEnd: [String: Double] = ["相手": 0, "自分": 0]
        for pulled in all {
            let other = pulled.reader == "相手" ? "自分" : "相手"
            let otherDone = (seenEnd[other] ?? 0) >= 20 - 0.001
            #expect(otherDone || pulled.start <= (seenEnd[other] ?? 0) + widest + 0.001,
                "\(pulled.reader) が \(pulled.start) 秒から読んだ時点で、\(other) は \(seenEnd[other] ?? 0) 秒までしか読んでいない")
            seenEnd[pulled.reader] = max(seenEnd[pulled.reader] ?? 0, pulled.end)
        }
        #expect(abs(log.maxEnd(of: "相手") - 20) < 0.01)
        #expect(abs(log.maxEnd(of: "自分") - 20) < 0.01)
    }

    @Test("短い方が先に読み終えたら、長い方は待たずに最後まで読み切る（どちらの側が短くても）")
    func finishedReaderDoesNotBlockTheOther() async throws {
        for theirsIsShort in [true, false] {
            let dir = try Support.temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: dir) }
            let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: theirsIsShort ? 1 : 12, mineSeconds: theirsIsShort ? 12 : 1)
            let alignment = FileReadingAlignment()
            let theirsReader = await alignment.addReader()
            let mineReader = await alignment.addReader()
            let log = PullLog()

            async let theirsRun: Void = drain(try await transcribeFile(at: theirs, with: PacedFileTranscriber("相手", log: log), alignment: theirsReader))
            async let mineRun: Void = drain(try await transcribeFile(at: mine, with: PacedFileTranscriber("自分", log: log), alignment: mineReader))
            try await theirsRun
            try await mineRun

            #expect(abs(log.maxEnd(of: "相手") - (theirsIsShort ? 1 : 12)) < 0.01)
            #expect(abs(log.maxEnd(of: "自分") - (theirsIsShort ? 12 : 1)) < 0.01)
        }
    }

    @Test("揃える相手を待っている読み手は、キャンセルされるとすぐ CancellationError で終わる（待ち続けない）")
    func waitingReaderRespondsToCancellation() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: 30, mineSeconds: 30)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader()
        let mineReader = await alignment.addReader()
        let log = PullLog()
        let gate = Gate()
        let slowGotFirst = Flag()
        let slow = PacedFileTranscriber("自分", log: log) { _ in
            slowGotFirst.raise()
            await gate.wait()
        }
        let slowTask = Task { try await drain(try await transcribeFile(at: mine, with: slow, alignment: mineReader)) }
        defer { gate.open() }
        let waiting = Task { try await drain(try await transcribeFile(at: theirs, with: PacedFileTranscriber("相手", log: log), alignment: theirsReader)) }
        defer { waiting.cancel(); slowTask.cancel() }
        try await waitUntil("遅い側が最初の入力を受け取る") { slowGotFirst.isRaised }
        try await Task.sleep(for: .milliseconds(300)) // 相手が自分を待つ状態になる

        waiting.cancel()
        let ended = Flag()
        let watcher = Task { _ = await waiting.result; ended.raise() }
        try await waitUntil("待っていた読み手が終わる") { ended.isRaised }
        #expect(ended.isRaised, "キャンセルしても待ちが解けない")
        if case .failure(let error) = await waiting.result {
            #expect(error is CancellationError)
        } else {
            Issue.record("キャンセルされた読み手が正常に終わった")
        }
        watcher.cancel()
        slowTask.cancel()
    }

    @Test("揃えた位置が時計になる: sleep は、読み手が進むまで戻らない（壁時計では戻らない）。進むと、呼んだ時点の位置 + 指定の長さ以上で戻る")
    func sleepWaitsForReadingPosition() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: 4, mineSeconds: 4)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader()
        let mineReader = await alignment.addReader()

        let woke = Flag()
        let sleeper = Task { () -> Double in
            try await alignment.sleep(.seconds(1))
            woke.raise()
            return await alignment.now()
        }
        try await Task.sleep(for: .milliseconds(1300)) // 壁時計では 1 秒を過ぎるが、読み手はまだ 1 つも動いていない
        #expect(!woke.isRaised)
        #expect(await alignment.now() == 0)

        let log = PullLog()
        async let theirsRun: Void = drain(try await transcribeFile(at: theirs, with: PacedFileTranscriber("相手", log: log), alignment: theirsReader))
        async let mineRun: Void = drain(try await transcribeFile(at: mine, with: PacedFileTranscriber("自分", log: log), alignment: mineReader))
        try await theirsRun
        try await mineRun

        let positionAtWake = try await sleeper.value
        #expect(positionAtWake >= 1)
    }

    @Test("全部の読み手が読み終えても sleep は戻らない（入力の終わりの後にも結果は届く）。now は最後の位置になり、close() で戻る。close() の後に呼ぶ sleep もすぐ戻る")
    func sleepWaitsForCloseAfterAllReadersFinished() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, mine) = try writeWAVs(in: dir, theirsSeconds: 2, mineSeconds: 3)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader()
        let mineReader = await alignment.addReader()
        let woke = Flag()
        let sleeper = Task { try await alignment.sleep(.seconds(100)); woke.raise() }

        let log = PullLog()
        async let theirsRun: Void = drain(try await transcribeFile(at: theirs, with: PacedFileTranscriber("相手", log: log), alignment: theirsReader))
        async let mineRun: Void = drain(try await transcribeFile(at: mine, with: PacedFileTranscriber("自分", log: log), alignment: mineReader))
        try await theirsRun
        try await mineRun

        try await Task.sleep(for: .milliseconds(300))
        #expect(!woke.isRaised, "全部の読み手が読み終えただけで sleep が戻った")
        #expect(abs(await alignment.now() - 3) < 0.01)

        await alignment.close()
        try await waitUntil("close() で待っていた sleep が戻る") { woke.isRaised }
        try await sleeper.value
        try await alignment.sleep(.seconds(100)) // 閉じた後の sleep は、待たずに戻る
    }

    @Test("sleep は待っている間にキャンセルされると、CancellationError で戻る")
    func sleepRespondsToCancellation() async throws {
        let alignment = FileReadingAlignment()
        _ = await alignment.addReader()
        let sleeper = Task { try await alignment.sleep(.seconds(100)) }
        try await Task.sleep(for: .milliseconds(100))

        sleeper.cancel()

        let ended = Flag()
        let watcher = Task { _ = await sleeper.result; ended.raise() }
        try await waitUntil("待っていた読み手が終わる") { ended.isRaised }
        #expect(ended.isRaised, "キャンセルしても sleep が戻らない")
        if case .failure(let error) = await sleeper.result {
            #expect(error is CancellationError)
        } else {
            Issue.record("キャンセルされた sleep が正常に戻った")
        }
        watcher.cancel()
    }

    @Test("揃える相手が無い（alignment を渡さない）ときは、今までと同じ。1 本は待たずに最後まで読み切る")
    func withoutAlignmentReadsStraightThrough() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let (theirs, _) = try writeWAVs(in: dir, theirsSeconds: 6, mineSeconds: 1)
        let log = PullLog()

        try await drain(try await transcribeFile(at: theirs, with: PacedFileTranscriber("相手", log: log)))

        #expect(abs(log.maxEnd(of: "相手") - 6) < 0.01)
    }

    @Test("映像の判定の進みを待つ読み手は、advance で足りるまで戻らず、finish で戻る。映像が無い・終わっていれば待たない")
    func waitScreenWaitsForAdvanceOrFinish() async throws {
        let alignment = FileReadingAlignment()
        let reader = await alignment.addReader()
        try await reader.waitScreen(through: 5) // 映像を足していない: 待たない

        let screen = await alignment.addScreen()
        let passed = Flag()
        let waiting = Task { try await reader.waitScreen(through: 2); passed.raise() }
        defer { waiting.cancel() }
        try await Task.sleep(for: .milliseconds(200))
        #expect(!passed.isRaised)

        await screen.advance(to: 1.5)
        try await Task.sleep(for: .milliseconds(200))
        #expect(!passed.isRaised, "進みが足りないのに戻った")

        await screen.advance(to: 2)
        try await waitUntil("進みが足りて戻る") { passed.isRaised }

        let finishedWait = Task { try await reader.waitScreen(through: 100) }
        defer { finishedWait.cancel() }
        try await Task.sleep(for: .milliseconds(100))
        await screen.finish()
        try await finishedWait.value // 映像が終わった: 待たない
        try await reader.waitScreen(through: 200)
        #expect(await alignment.now() == 0) // 映像の進みは時計に入らない
    }

    @Test("映像の進みを待っている読み手は、キャンセルされるとすぐ CancellationError で終わる")
    func waitScreenRespondsToCancellation() async throws {
        let alignment = FileReadingAlignment()
        let reader = await alignment.addReader()
        _ = await alignment.addScreen()
        let waiting = Task { try await reader.waitScreen(through: 1) }
        try await Task.sleep(for: .milliseconds(100))

        waiting.cancel()
        let ended = Flag()
        let watcher = Task { _ = await waiting.result; ended.raise() }
        defer { watcher.cancel() }
        try await waitUntil("待っていた読み手が終わる") { ended.isRaised }
        if case .failure(let error) = await waiting.result {
            #expect(error is CancellationError)
        } else {
            Issue.record("キャンセルされた待ちが正常に戻った")
        }
    }
}
