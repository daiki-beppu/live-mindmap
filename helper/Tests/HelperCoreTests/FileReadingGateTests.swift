import Foundation
import Testing
@testable import HelperCore

// Issue #1092: 差分更新の一時停止の間、サーバーの指示（`{"type":"reading-pause","paused":boolean,"token":string}`）で
// 録画ファイルの読み手を止める（FileReadingGate）。測る量は「これまでに読んだ一番先の位置」（invNoReadWhilePaused）。
// ファイルはテストの中で作った合成の WAV。文字にする役は偽物で、引いた入力の位置を記録する。

private let token = String(repeating: "a", count: 64)
private func message(type: String = "reading-pause", paused: Bool, token: String?) -> String {
    token.map { #"{"type":"\#(type)","paused":\#(paused),"token":"\#($0)"}"# } ?? #"{"type":"\#(type)","paused":\#(paused)}"#
}

@Suite("録画ファイルの読み手を止める指示の読み取り（FileReadingGate）")
struct FileReadingGateInstructionTests {
    @Test("トークン付きの reading-pause の指示から paused の値を読み取る")
    func readsRequestedState() {
        #expect(FileReadingGate.requestedState(in: message(paused: true, token: token), token: token) == true)
        #expect(FileReadingGate.requestedState(in: message(paused: false, token: token), token: token) == false)
    }

    @Test("トークンのない指示・違うトークンの指示・type が違う指示・paused が真偽値でない指示・壊れた JSON・空の期待トークンは読み取らない")
    func rejectsInvalidInstructions() {
        let other = String(repeating: "b", count: 64)
        #expect(FileReadingGate.requestedState(in: message(paused: true, token: nil), token: token) == nil)
        #expect(FileReadingGate.requestedState(in: message(paused: true, token: other), token: token) == nil)
        #expect(FileReadingGate.requestedState(in: message(type: "self-pause", paused: true, token: token), token: token) == nil)
        #expect(FileReadingGate.requestedState(in: #"{"type":"reading-pause","paused":"yes","token":"\#(token)"}"#, token: token) == nil)
        #expect(FileReadingGate.requestedState(in: #"{"type":"reading-pause","paused":1,"token":"\#(token)"}"#, token: token) == nil)
        #expect(FileReadingGate.requestedState(in: "not json", token: token) == nil)
        #expect(FileReadingGate.requestedState(in: message(paused: true, token: ""), token: "") == nil)
    }

    @Test("自分の休止の指示の読み取りは変わらない: self-pause の指示は読み取り、reading-pause の指示は自分の休止として読み取らない")
    func selfPauseIsUnchanged() {
        #expect(SelfPause.requestedState(in: message(type: "self-pause", paused: true, token: token), token: token) == true)
        #expect(SelfPause.requestedState(in: message(type: "reading-pause", paused: true, token: token), token: token) == nil)
    }
}

@Suite("読み手の門（FileReadingGate）", .timeLimit(.minutes(1)))
struct FileReadingGateTests {
    @Test("止めていなければ、待たずに通る")
    func opensByDefault() async throws {
        let gate = FileReadingGate()
        try await gate.waitOpen()
    }

    @Test("止めている間は通らず、止めを解くと待っていた全員が通る。同じ状態の指示を重ねても結果は同じ")
    func pauseBlocksAndResumeReleasesAll() async throws {
        let gate = FileReadingGate()
        await gate.pause()
        await gate.pause()
        let passed = GatePullLog()
        let tasks = (0..<3).map { index in
            Task {
                try await gate.waitOpen()
                passed.append(GatePulled(reader: "r\(index)", start: 0, end: 0))
            }
        }
        defer { tasks.forEach { $0.cancel() } }
        try await Task.sleep(for: .milliseconds(300))
        #expect(passed.values.isEmpty)

        await gate.resume()
        await gate.resume()
        for task in tasks { try await task.value }
        #expect(passed.values.count == 3)
        // 解いた後は、また待たずに通る
        try await gate.waitOpen()
    }

    @Test("止めて待っている間にキャンセルされると、CancellationError で待ちから抜ける（SIGTERM で終われる）")
    func cancelReleasesWaiter() async throws {
        let gate = FileReadingGate()
        await gate.pause()
        let released = GateFlag()
        let task = Task {
            do {
                try await gate.waitOpen()
            } catch is CancellationError {
                released.raise()
                throw CancellationError()
            }
        }
        try await Task.sleep(for: .milliseconds(200))
        #expect(!released.isRaised)
        task.cancel()
        try await gateWaitUntil("キャンセルで待ちが解ける") { released.isRaised }
        await #expect(throws: CancellationError.self) { try await task.value }
    }
}

extension FileReadingGateTests {
    @Test("stop すると、待っている読み手は CancellationError で抜け、以後 waitOpen は止めていなくてもすぐ CancellationError を投げる（プロセスを止めるとき）")
    func stopReleasesWaitersAndRefusesNew() async throws {
        let gate = FileReadingGate()
        await gate.pause()
        let waiter = Task { try await gate.waitOpen() }
        try await Task.sleep(for: .milliseconds(200))
        await gate.stop()
        await #expect(throws: CancellationError.self) { try await waiter.value }
        await #expect(throws: CancellationError.self) { try await gate.waitOpen() }
    }
}
