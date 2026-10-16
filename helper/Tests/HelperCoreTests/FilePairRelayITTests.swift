import Foundation
import Speech
import Testing
@testable import HelperCore

// `cli recorded --self` の組み立て（relayFilePair）の IT。本番と同じ関数に、合成した WAV 2 本と台本どおりに結果を流す偽の文字にする役を渡し、
// WebSocket に流れたイベントを観測する（映像の `screen` は、映像つきの mov を渡して選択規則を確かめる）。確かめること: 保留が音声の時刻で解ける（壁時計では解けない）/
// 入力の終わりの後に届く `相手` の確定結果も `自分` の判定の文脈に入る / トラック名と重複の印がライブと同じに付く。

private typealias Support = FileAudioTestSupport

private final class Gate: @unchecked Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream(of: Void.self) }
    func open() { continuation.finish() }
    func wait() async { for await _ in stream {} }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    func raise() { lock.withLock { raised = true } }
    var isRaised: Bool { lock.withLock { raised } }
}

private struct Step {
    /// 引いた入力の終わりがこの秒に達したら、`results` を流す。
    let after: Double
    let results: [TranscriptionResult]
}

private struct ScriptedFailure: Error {}

/// 引いた入力の位置に応じて、台本どおりに結果を流す偽の役。入力が終わったら、`tailDelay` 待ってから `tail` を流して終わる
/// （実際の認識が、入力の終わりの後に残りを確定して流すことの代わり）。`pauseAfter` に達したら、`gate` が開くまで次の入力を引かない。
private final class ScriptedTranscriber: FileTranscriber, @unchecked Sendable {
    private let steps: [Step]
    private let tail: [TranscriptionResult]
    private let tailDelay: Duration
    private let pause: (after: Double, gate: Gate)?
    /// 渡されたら、これが真になった時点で結果の流れを `ScriptedFailure` で終える（入力を引いているかに関わらず）。
    private let failWhen: (@Sendable () -> Bool)?
    /// 台本の結果をすべて流し終えたら立つ。`pause` に達して止まったときも立つ。
    let reachedScript = Flag()
    private let startsLock = NSLock()
    private var _firstStart: Double?
    private var _lastEnd = 0.0
    /// 引いた最初の入力の開始位置（ファイルの秒）。1 つも引いていなければ nil。
    var firstStart: Double? { startsLock.withLock { _firstStart } }
    /// 引いた入力の終わりの最大値（ファイルの秒）。
    var lastEnd: Double { startsLock.withLock { _lastEnd } }

    init(steps: [Step] = [], tail: [TranscriptionResult] = [], tailDelay: Duration = .milliseconds(300), pause: (after: Double, gate: Gate)? = nil, failWhen: (@Sendable () -> Bool)? = nil) {
        self.steps = steps
        self.tail = tail
        self.tailDelay = tailDelay
        self.pause = pause
        self.failWhen = failWhen
    }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
        let task = Task {
            do {
                var fired = Set<Int>()
                var paused = false
                for try await input in inputs {
                    let start = try #require(input.bufferStartTime).seconds
                    let end = start + Double(input.buffer.frameLength) / input.buffer.format.sampleRate
                    startsLock.withLock {
                        if _firstStart == nil { _firstStart = start }
                        _lastEnd = max(_lastEnd, end)
                    }
                    for (index, step) in steps.enumerated() where end >= step.after && !fired.contains(index) {
                        fired.insert(index)
                        step.results.forEach { continuation.yield($0) }
                    }
                    if fired.count == steps.count, pause == nil { reachedScript.raise() }
                    if let pause, !paused, end >= pause.after {
                        paused = true
                        reachedScript.raise()
                        await pause.gate.wait()
                    }
                }
                try await Task.sleep(for: tailDelay)
                tail.forEach { continuation.yield($0) }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        let watcher = Task {
            guard let failWhen else { return }
            while !failWhen() {
                if (try? await Task.sleep(for: .milliseconds(25))) == nil { return }
            }
            continuation.finish(throwing: ScriptedFailure())
        }
        continuation.onTermination = { _ in
            task.cancel()
            watcher.cancel()
        }
        return stream
    }
}

private struct WaitTimedOut: Error, CustomStringConvertible {
    let condition: String
    var description: String { "待っていた条件が成り立たなかった: \(condition)" }
}

private let sentence = "今日は予算の話をします"
private let second = "では私から説明します"

private func final(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: true, start: start, end: end)
}

private func partial(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: false, start: start, end: end)
}

private struct Received: Equatable {
    let type: String
    let track: String
    let text: String
    let duplicate: Bool
}

/// 届いたテキストフレームを集める。待ちには壁時計の期限を付ける。
private final class Inbox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Received] = []
    func append(_ item: Received) { lock.withLock { items.append(item) } }
    var values: [Received] { lock.withLock { items } }
}

/// 届いた `screen`・`partial`・`remark` を、届いた順に 1 列で記録する（`screen` は start、それ以外は track）。
private final class Arrivals: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func append(_ item: String) { lock.withLock { items.append(item) } }
    var values: [String] { lock.withLock { items } }
}

/// 届いた `screen` の start と、画像の有無。
private final class ScreenInbox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(start: Double, hasImage: Bool)] = []
    func append(start: Double, hasImage: Bool) { lock.withLock { items.append((start, hasImage)) } }
    var values: [(start: Double, hasImage: Bool)] { lock.withLock { items } }
}

private func startReceiving(_ task: URLSessionWebSocketTask, into inbox: Inbox, screens: ScreenInbox, arrivals: Arrivals) -> Task<Void, Never> {
    Task {
        while let message = try? await task.receive() {
            guard case .string(let text) = message,
                  let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let type = object["type"] as? String else { continue }
            if type == "screen", let start = object["start"] as? Double {
                screens.append(start: start, hasImage: object["image"] is String)
                arrivals.append("screen \(start)")
                continue
            }
            guard type == "remark" || type == "partial",
                  let track = object["track"] as? String, let body = object["text"] as? String,
                  let duplicate = object["duplicate"] as? Bool else { continue }
            inbox.append(Received(type: type, track: track, text: body, duplicate: duplicate))
            arrivals.append("\(type) \(track)")
        }
    }
}

/// OCR を温めるための、白い 64x64 の画像。
private func blankImage() -> CGImage? {
    let context = CGContext(
        data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
    context?.setFillColor(gray: 1, alpha: 1)
    context?.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
    return context?.makeImage()
}

// Why: 上限は 30 秒。CI のランナーは混むと、すぐ終わるテストでも 12 秒かかり、10 秒の待ちでは映像の判定と OCR が間に合わなかった（#1091）。
// 条件が成り立てばすぐ抜けるので、手元の速さは変わらない。スイートの時間制限（1 分）の内に収める
private func waitUntil(_ condition: String, within limit: Duration = .seconds(30), _ check: @Sendable () -> Bool) async throws {
    let deadline = ContinuousClock.now + limit
    while !check() {
        if ContinuousClock.now >= deadline { throw WaitTimedOut(condition: condition) }
        try await Task.sleep(for: .milliseconds(25))
    }
}

private struct Rig {
    let server: WebSocketServer
    let inbox = Inbox()
    let screens = ScreenInbox()
    let arrivals = Arrivals()
    let socket: URLSessionWebSocketTask
    let receiving: Task<Void, Never>
    let theirs: URL
    let mine: URL
    let directory: URL

    /// `theirsWhiteFrom` / `mineWhiteFrom` を渡した側は、その秒から白になる映像つきの mov（`videoSeconds` 秒、既定は 4 秒）。nil の側は WAV。
    init(theirsWhiteFrom: Double? = nil, mineWhiteFrom: Double? = nil, videoSeconds: Int = 4) async throws {
        let directory = try Support.temporaryDirectory()
        self.directory = directory
        let wav = directory.appendingPathComponent("audio.wav")
        try Support.writeWAV(wav, loudSeconds: 4, silentSeconds: 0)
        func source(_ name: String, whiteFrom: Double?) async throws -> URL {
            guard let whiteFrom else {
                let url = directory.appendingPathComponent("\(name).wav")
                try Support.writeWAV(url, loudSeconds: 4, silentSeconds: 0)
                return url
            }
            let url = directory.appendingPathComponent("\(name).mov")
            try await Support.writeMovie(url, audio: wav, videoSeconds: videoSeconds, video: .slides(switchAt: whiteFrom))
            return url
        }
        theirs = try await source("them", whiteFrom: theirsWhiteFrom)
        mine = try await source("me", whiteFrom: mineWhiteFrom)
        if theirsWhiteFrom != nil || mineWhiteFrom != nil {
            // Why: 送る画面の OCR は、プロセスで最初の 1 回だけ文字認識のモデルを組み立て、負荷のある機械では 20 秒かかった。
            // 映像の判定が済むまで音声は進まないので、それが下の待ちに入ると揺れる。測る前に 1 回読ませておく
            _ = await recognizeScreenText(try #require(blankImage()))
        }
        server = WebSocketServer(port: 0)
        let port = try await server.start()
        socket = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        socket.resume()
        for _ in 0..<100 where await server.clientCount != 1 { try await Task.sleep(for: .milliseconds(50)) }
        try #require(await server.clientCount == 1)
        receiving = startReceiving(socket, into: inbox, screens: screens, arrivals: arrivals)
    }

    func relay(theirs theirsTranscriber: ScriptedTranscriber, mine mineTranscriber: ScriptedTranscriber) -> Task<Void, Error> {
        let server = server, theirs = theirs, mine = mine
        return Task {
            try await relayFilePair(theirs: theirs, mine: mine, theirsTranscriber: theirsTranscriber, mineTranscriber: mineTranscriber, to: server)
        }
    }

    /// トラックごとの開始位置（`theirsFrom`・`mineFrom` 秒）から読み始めて流す（起動し直し）。
    func relay(theirs theirsTranscriber: ScriptedTranscriber, mine mineTranscriber: ScriptedTranscriber, theirsFrom: Double, mineFrom: Double) -> Task<Void, Error> {
        let server = server, theirs = theirs, mine = mine
        return Task {
            try await relayFilePair(theirs: theirs, mine: mine, theirsTranscriber: theirsTranscriber, mineTranscriber: mineTranscriber, to: server, theirsFrom: theirsFrom, mineFrom: mineFrom)
        }
    }

    /// 映像の処理を差し替えて流す（映像を遅らせたり、止めたりするため）。
    func relay(
        theirs theirsTranscriber: ScriptedTranscriber, mine mineTranscriber: ScriptedTranscriber, relayScreen: @escaping FileScreenRelay
    ) -> Task<Void, Error> {
        let server = server, theirs = theirs, mine = mine
        return Task {
            try await relayFilePair(
                theirs: theirs, mine: mine, theirsTranscriber: theirsTranscriber, mineTranscriber: mineTranscriber, to: server,
                relayScreen: relayScreen)
        }
    }

    func stop() async {
        receiving.cancel()
        socket.cancel(with: .goingAway, reason: nil)
        await server.stop()
        try? FileManager.default.removeItem(at: directory)
    }
}

/// 成功・失敗を問わず、relay を止めて Rig を片付ける。
private func withRig(theirsWhiteFrom: Double? = nil, mineWhiteFrom: Double? = nil, videoSeconds: Int = 4, _ body: (Rig) async throws -> Void) async throws {
    let rig = try await Rig(theirsWhiteFrom: theirsWhiteFrom, mineWhiteFrom: mineWhiteFrom, videoSeconds: videoSeconds)
    do {
        try await body(rig)
    } catch {
        await rig.stop()
        throw error
    }
    await rig.stop()
}

@Suite("録画 2 本の組み立て（relayFilePair）", .timeLimit(.minutes(1)))
struct FilePairRelayITTests {
    @Test("入力の終わりの後に届く 相手 の確定結果も、保留中の 自分 の判定の文脈に入る。相手 は track 相手・印なし、自分 は track 自分・印あり")
    func theirFinalAfterEndOfInputMarksMine() async throws {
        try await withRig { rig in
            let relaying = rig.relay(
                theirs: ScriptedTranscriber(tail: [final(sentence, 1.0, 3.0)]),
                mine: ScriptedTranscriber(steps: [Step(after: 3.5, results: [final(sentence, 1.0, 3.0)])]))
            defer { relaying.cancel() }
            try await waitUntil("両方の確定結果が届く") { rig.inbox.values.count == 2 }
            try await relaying.value
            #expect(Set(rig.inbox.values.map { "\($0.track)/\($0.type)/\($0.duplicate)" }) == ["相手/remark/false", "自分/remark/true"])
        }
    }

    @Test("開始位置（from）から読み始めた 2 本は、互いを待ち続けて止まらず、どちらも開始位置から最後まで読み切る。結果の時刻はファイルの時刻のまま流れる")
    func pairStartingAtFromDoesNotStall() async throws {
        try await withRig { rig in
            let theirsTranscriber = ScriptedTranscriber(tail: [final(sentence, 2.5, 3.5)])
            let mineTranscriber = ScriptedTranscriber(steps: [Step(after: 3.5, results: [final(second, 3.0, 3.9)])])
            let relaying = rig.relay(theirs: theirsTranscriber, mine: mineTranscriber, theirsFrom: 2.0, mineFrom: 2.0)
            defer { relaying.cancel() }
            try await waitUntil("両方の確定結果が届く") { rig.inbox.values.count == 2 }
            try await relaying.value
            // 0 秒から読み直していない。2 本とも 2 秒から 4 秒の最後まで読む
            #expect(abs(try #require(theirsTranscriber.firstStart) - 2.0) < 0.001)
            #expect(abs(try #require(mineTranscriber.firstStart) - 2.0) < 0.001)
            #expect(abs(theirsTranscriber.lastEnd - 4.0) < 0.01)
            #expect(abs(mineTranscriber.lastEnd - 4.0) < 0.01)
            #expect(Set(rig.inbox.values.map { "\($0.track)/\($0.type)/\($0.text)" }) == ["相手/remark/\(sentence)", "自分/remark/\(second)"])
        }
    }

    @Test("トラックごとの開始位置（相手 3.0・自分 1.0）から、それぞれの位置で読み始め、互いを待って止まらず最後まで読み切る。映像は大きい方（3.0）から読む")
    func pairWithDifferentFromReadsEachTrackFromItsOwnPosition() async throws {
        try await withRig(theirsWhiteFrom: 3.0) { rig in
            let theirsTranscriber = ScriptedTranscriber(tail: [final(sentence, 3.2, 3.8)])
            let mineTranscriber = ScriptedTranscriber(steps: [Step(after: 3.5, results: [final(second, 1.2, 1.8)])])
            let relaying = rig.relay(theirs: theirsTranscriber, mine: mineTranscriber, theirsFrom: 3.0, mineFrom: 1.0)
            defer { relaying.cancel() }
            try await waitUntil("両方の確定結果が届く") { rig.inbox.values.count == 2 }
            try await relaying.value
            #expect(abs(try #require(theirsTranscriber.firstStart) - 3.0) < 0.001)
            #expect(abs(try #require(mineTranscriber.firstStart) - 1.0) < 0.001)
            #expect(abs(theirsTranscriber.lastEnd - 4.0) < 0.01)
            #expect(abs(mineTranscriber.lastEnd - 4.0) < 0.01)
            try await waitUntil("screen が届く") { !rig.screens.values.isEmpty }
            try await Task.sleep(for: .milliseconds(200))
            #expect(rig.screens.values.allSatisfy { $0.start >= 3.0 - 0.001 })
        }
    }

    @Test("映像つきの 2 本を正の開始位置（2.0）から読むと、開始位置以降の screen だけが届き、音声と映像は止まらずに最後まで読み切る")
    func pairWithVideoStartingAtPositiveFrom() async throws {
        // 変化は 1 秒後のフレームで判定されるので、3.0 の変化を判定できるよう映像は 5 秒にする
        try await withRig(theirsWhiteFrom: 3.0, videoSeconds: 5) { rig in
            let theirsTranscriber = ScriptedTranscriber()
            let mineTranscriber = ScriptedTranscriber()
            let relaying = rig.relay(theirs: theirsTranscriber, mine: mineTranscriber, theirsFrom: 2.0, mineFrom: 2.0)
            defer { relaying.cancel() }
            try await relaying.value
            try await waitUntil("3.0 の変化の screen が届く") { rig.screens.values.contains { abs($0.start - 3.0) < 0.001 } }
            try await Task.sleep(for: .milliseconds(200))
            #expect(!rig.screens.values.isEmpty)
            #expect(rig.screens.values.allSatisfy { $0.start >= 2.0 - 0.001 })
            #expect(abs(theirsTranscriber.lastEnd - 4.0) < 0.01)
            #expect(abs(mineTranscriber.lastEnd - 4.0) < 0.01)
        }
    }

    @Test("開始位置がサンプルの区切りの間（切り上がる小数）でも、2 本は互いを待って止まらず最後まで読み切る")
    func pairStartingAtFractionalFromDoesNotStall() async throws {
        try await withRig { rig in
            let theirsTranscriber = ScriptedTranscriber(tail: [final(sentence, 2.5, 3.5)])
            let mineTranscriber = ScriptedTranscriber(steps: [Step(after: 3.5, results: [final(second, 3.0, 3.9)])])
            let relaying = rig.relay(theirs: theirsTranscriber, mine: mineTranscriber, theirsFrom: 2.00002, mineFrom: 2.00002)
            defer { relaying.cancel() }
            try await waitUntil("両方の確定結果が届く") { rig.inbox.values.count == 2 }
            try await relaying.value
            #expect(abs(theirsTranscriber.lastEnd - 4.0) < 0.01)
            #expect(abs(mineTranscriber.lastEnd - 4.0) < 0.01)
        }
    }

    @Test("相手 と重ならない 自分 の確定結果には、印が付かない（track は 自分）")
    func nonOverlappingMineIsNotMarked() async throws {
        try await withRig { rig in
            let relaying = rig.relay(
                theirs: ScriptedTranscriber(tail: [final(sentence, 1.0, 3.0)]),
                mine: ScriptedTranscriber(steps: [Step(after: 3.5, results: [final(sentence, 1.0, 3.0), final(second, 3.2, 3.9)])]))
            defer { relaying.cancel() }
            try await waitUntil("3 件の確定結果が届く") { rig.inbox.values.count == 3 }
            try await relaying.value
            let second = rig.inbox.values.filter { $0.text == "では私から説明します" }
            #expect(second == [Received(type: "remark", track: "自分", text: "では私から説明します", duplicate: false)])
        }
    }

    @Test("保留（1 秒）は音声の時刻で解ける。結果の流れが開いたままでも、読み手が進んで時計が 1 秒進むと、自分 の途中結果が印なしで流れる")
    func partialHoldReleasesWhenAudioClockAdvances() async throws {
        try await withRig { rig in
            let gate = Gate()
            // 両方の結果の流れは、入力の終わりの後も 5 秒開いたままにする（流れの終了で保留が解けたのではないことを分ける）
            let theirs = ScriptedTranscriber(tailDelay: .seconds(5), pause: (after: 1.6, gate: gate))
            let mine = ScriptedTranscriber(steps: [Step(after: 1.6, results: [partial("では私から", 0.5, 1.5)])], tailDelay: .seconds(5))
            let relaying = rig.relay(theirs: theirs, mine: mine)
            defer { relaying.cancel(); gate.open() }
            // 相手 が止まり、自分 の途中結果が流れたことを確かめてから、保留中であることを見る
            try await waitUntil("相手 が止まり、自分 の途中結果が流れる") { theirs.reachedScript.isRaised && mine.reachedScript.isRaised }
            try await Task.sleep(for: .milliseconds(300))
            #expect(rig.inbox.values.isEmpty)

            gate.open()
            try await waitUntil("流れが終わる前に 自分 の途中結果が届く", within: .seconds(3)) { !rig.inbox.values.isEmpty }
            #expect(rig.inbox.values == [Received(type: "partial", track: "自分", text: "では私から", duplicate: false)])
        }
    }

    @Test("読んだ位置が進まない間は、壁時計で 1 秒を過ぎても 自分 の途中結果は流れない（保留を壁時計で測らない）")
    func partialHoldIsNotReleasedByWallClock() async throws {
        try await withRig { rig in
            let gate = Gate()
            let theirs = ScriptedTranscriber(pause: (after: 1.6, gate: gate))
            let mine = ScriptedTranscriber(steps: [Step(after: 1.6, results: [partial("では私から", 0.5, 1.5)])])
            let relaying = rig.relay(theirs: theirs, mine: mine)
            defer { relaying.cancel(); gate.open() }
            try await waitUntil("相手 が止まり、自分 の途中結果が流れる") { theirs.reachedScript.isRaised && mine.reachedScript.isRaised }
            try await Task.sleep(for: .milliseconds(1300))

            #expect(rig.inbox.values.isEmpty, "壁時計の経過で保留が解けた: \(rig.inbox.values)")
        }
    }

    /// 映像の選択規則。`relayFilePair` が戻った後に届いた `screen` の start を見る。画面全体の変化は 1 秒間比べる対象から外れるので、
    /// 白に変わった秒の 1 秒後に判定され、start は変化した時刻になる。
    private func screenStarts(theirsWhiteFrom: Double?, mineWhiteFrom: Double?) async throws -> [Double] {
        var starts: [Double] = []
        try await withRig(theirsWhiteFrom: theirsWhiteFrom, mineWhiteFrom: mineWhiteFrom) { rig in
            try await rig.relay(theirs: ScriptedTranscriber(), mine: ScriptedTranscriber()).value
            // relay が戻った時点で server.broadcast は済んでいる。届くのを待つ（映像がなければ待たずに 0 件）
            if theirsWhiteFrom != nil || mineWhiteFrom != nil {
                try await waitUntil("screen が届く") { rig.screens.values.count >= 2 }
            }
            try await Task.sleep(for: .milliseconds(200))
            #expect(rig.screens.values.allSatisfy { $0.hasImage })
            starts = rig.screens.values.map(\.start)
        }
        return starts
    }

    @Test("メインだけに映像があるとき、メインの映像の変化が screen として流れる")
    func screenFromTheirsOnly() async throws {
        #expect(try await screenStarts(theirsWhiteFrom: 1.0, mineWhiteFrom: nil) == [0.0, 1.0])
    }

    @Test("自分用だけに映像があるとき、自分用の映像の変化が screen として流れる")
    func screenFromMineOnly() async throws {
        #expect(try await screenStarts(theirsWhiteFrom: nil, mineWhiteFrom: 2.0) == [0.0, 2.0])
    }

    @Test("両方に映像があるとき、メインの映像を使う（自分用の変化は流れない）")
    func screenPrefersTheirs() async throws {
        #expect(try await screenStarts(theirsWhiteFrom: 1.0, mineWhiteFrom: 2.0) == [0.0, 1.0])
    }

    @Test("どちらにも映像がないとき、screen は流れない")
    func noScreenWithoutVideo() async throws {
        #expect(try await screenStarts(theirsWhiteFrom: nil, mineWhiteFrom: nil).isEmpty)
    }

    @Test("映像の判定が済むまで、音声の結果は流れない。映像を遅らせても、screen（start = 1.0）は end が 1.5 を超える 相手・自分 の remark より先に届く")
    func screenPrecedesLaterRemarksWhenVideoIsDelayed() async throws {
        try await withRig(theirsWhiteFrom: 1.0) { rig in
            let gate = Gate()
            let server = rig.server
            // 画面の変化（1.0 秒）は 2.0 秒のフレームで判定される。判定の時刻まで音声の入力を渡さない
            let relaying = rig.relay(
                theirs: ScriptedTranscriber(steps: [Step(after: 1.5, results: [final(sentence, 1.1, 1.5)])]),
                mine: ScriptedTranscriber(steps: [Step(after: 1.6, results: [final(second, 1.2, 1.6)])]),
                relayScreen: { video, progress in
                    await gate.wait()
                    await relayFileScreen(from: video, to: server, progress: progress)
                })
            defer { relaying.cancel(); gate.open() }
            try await Task.sleep(for: .milliseconds(500))
            #expect(rig.arrivals.values.isEmpty, "映像が止まっている間に音声の結果が流れた: \(rig.arrivals.values)")

            gate.open()
            try await waitUntil("screen 2 件と remark 2 件が届く") { rig.arrivals.values.count >= 4 }
            try await relaying.value
            let arrivals = rig.arrivals.values
            #expect(Array(arrivals.prefix(2)) == ["screen 0.0", "screen 1.0"], "\(arrivals)")
            #expect(Set(arrivals.suffix(2)) == ["remark 相手", "remark 自分"], "\(arrivals)")
        }
    }

    @Test("映像の読み出し中に音声の認識が失敗すると、映像を最後まで読まずに音声のエラーで戻り、戻った後は screen が増えない")
    func audioFailureCancelsVideoReadingAndStopsScreens() async throws {
        // 長い映像（300 秒、295 秒で白）。最初の screen（start 0）が届いた後に音声を失敗させる
        try await withRig(theirsWhiteFrom: 295, videoSeconds: 300) { rig in
            let screens = rig.screens
            let relaying = rig.relay(
                theirs: ScriptedTranscriber(failWhen: { !screens.values.isEmpty }),
                mine: ScriptedTranscriber())
            defer { relaying.cancel() }
            let returned = Flag()
            let watcher = Task { _ = await relaying.result; returned.raise() }
            defer { watcher.cancel() }
            try await waitUntil("音声の失敗で relayFilePair が戻る") { returned.isRaised }

            guard case .failure(let error) = await relaying.result else {
                Issue.record("音声が失敗したのに正常に戻った")
                return
            }
            #expect(error is ScriptedFailure, "音声のエラーではないエラーで戻った: \(error)")
            try await Task.sleep(for: .milliseconds(500))
            #expect(rig.screens.values.map(\.start) == [0.0], "戻った後も映像が読まれ続けた: \(rig.screens.values.map(\.start))")
        }
    }
}
