import Foundation
import Testing
@testable import HelperCore

private let token = String(repeating: "a", count: 64)
private func message(paused: Bool, token: String?) -> String {
    token.map { #"{"type":"self-pause","paused":\#(paused),"token":"\#($0)"}"# } ?? #"{"type":"self-pause","paused":\#(paused)}"#
}

@Suite("自分の休止の指示と状態")
struct SelfPauseTests {
    @Test("SCN-U3-P1: 起動時のトークン付きの指示から paused の値を読み取る")
    func readsRequestedState() {
        #expect(SelfPause.requestedState(in: message(paused: true, token: token), token: token) == true)
        #expect(SelfPause.requestedState(in: message(paused: false, token: token), token: token) == false)
    }

    @Test("SCN-U3-N1: トークンのない指示・違うトークンの指示は読み取らない")
    func rejectsMissingOrWrongToken() {
        let other = String(repeating: "b", count: 64)
        #expect(SelfPause.requestedState(in: message(paused: false, token: nil), token: token) == nil)
        #expect(SelfPause.requestedState(in: message(paused: false, token: other), token: token) == nil)
    }

    @Test("SCN-U3-N2: トークンの型や長さが違う指示は読み取らない")
    func rejectsMalformedToken() {
        for text in [
            #"{"type":"self-pause","paused":true,"token":123}"#,
            #"{"type":"self-pause","paused":true,"token":""}"#,
            #"{"type":"self-pause","paused":true,"token":"\#(String(repeating: "a", count: 63))"}"#,
            #"{"type":"self-pause","paused":true,"token":"\#(String(repeating: "a", count: 65))"}"#,
        ] {
            #expect(SelfPause.requestedState(in: text, token: token) == nil)
        }
    }

    @Test("期待するトークンが空のときは、空のトークンの指示も受け付けない")
    func emptyExpectedTokenAcceptsNothing() {
        #expect(SelfPause.requestedState(in: #"{"type":"self-pause","paused":true,"token":""}"#, token: "") == nil)
    }

    @Test("壊れた JSON・知らない type・paused が真偽値でない指示は読み取らない（無視できるように nil）",
          arguments: [
              "", "not json", "[]", "{}",
              #"{"type":"other","paused":true,"token":"\#(token)"}"#,
              #"{"type":"self-pause","token":"\#(token)"}"#,
              #"{"type":"self-pause","paused":"true","token":"\#(token)"}"#,
              #"{"type":"self-pause","paused":1,"token":"\#(token)"}"#,
              #"{"type":"self-pause","paused":null,"token":"\#(token)"}"#,
          ])
    func ignoresInvalidRequests(message: String) {
        #expect(SelfPause.requestedState(in: message, token: token) == nil)
    }

    @Test("request は状態が変わったときだけ true を返し、同じ状態の指示は何も変えない")
    func requestReportsChangeOnly() {
        let state = SelfPause(paused: false)
        #expect(state.request(false, at: 10) == false)
        #expect(state.request(true, at: 20) == true)
        #expect(state.request(true, at: 30) == false)
        #expect(state.request(false, at: 40) == true)
        #expect(state.resolve(at: 15) == (false, false))
        #expect(state.resolve(at: 35) == (true, true))
        #expect(state.resolve(at: 45) == (false, false))
    }

    @Test("取得時刻が境界より前なら境界を取り出さず、境界以後なら反映する")
    func resolvesByAcquisitionTime() {
        let state = SelfPause(paused: false)
        _ = state.request(true, at: 150)
        #expect(state.resolve(at: 100) == (false, false))
        #expect(state.resolve(at: 150) == (true, true))
        #expect(state.resolve(at: 200) == (true, false))
    }

    @Test("音を挟まずに休止と再開が届いても、休止に入ったことを知らせる")
    func pauseAndResumeWithoutAudioReportsEnteredPause() {
        let state = SelfPause(paused: false)
        _ = state.request(true, at: 150)
        _ = state.request(false, at: 160)
        #expect(state.resolve(at: 300) == (false, true))
    }

    @Test("休止した状態で始められる（起動し直しで休止が続く）")
    func startsPaused() {
        let state = SelfPause(paused: true)
        #expect(state.resolve(at: 1) == (true, false))
        #expect(state.request(true, at: 2) == false)
        #expect(state.request(false, at: 3) == true)
        #expect(state.resolve(at: 4) == (false, false))
    }
}

@Suite("自分の休止の指示の処理と起動時の通知")
struct SelfPauseServingTests {
    private final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [Bool] = []
        func append(_ paused: Bool) { lock.withLock { storage.append(paused) } }
        var values: [Bool] { lock.withLock { storage } }
    }

    private final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [HelperEvent] = []
        func append(_ event: HelperEvent) { lock.withLock { storage.append(event) } }
        var values: [HelperEvent] { lock.withLock { storage } }
    }

    @Test("認証できた指示だけを、届いた順に渡す。壊れた指示・認証のない指示・違うトークンの指示は渡さない")
    func servesOnlyAuthenticatedRequestsInOrder() async {
        let (messages, continuation) = AsyncStream.makeStream(of: String.self)
        for text in [
            message(paused: false, token: token), message(paused: true, token: token), message(paused: true, token: token),
            "not json", message(paused: false, token: token),
            message(paused: true, token: nil), message(paused: true, token: String(repeating: "b", count: 64)),
        ] { continuation.yield(text) }
        continuation.finish()
        let requests = Requests()
        await serveSelfPauseRequests(messages, token: token) { requests.append($0) }
        #expect(requests.values == [false, true, true, false])
    }

    @Test("起動時に、始めの休止の状態（paused と理由）と送り直す状態を 1 回ずつ通知する。時刻は origin からの秒")
    func announcesInitialState() async {
        let events = Events()
        let rule = SelfPauseRule(app: "x", ownPID: 1)
        await announceSelfPause(rule, at: 7, origin: 7, emit: { events.append($0) })
        #expect(events.values == [.selfPause(.resumed(.undetermined), start: 0), .selfPauseState(.initial)])
    }

    @Test("手動の休止を引き継いで始めたときは、paused=true・理由は手動を通知する")
    func announcesRestoredManualPause() async {
        let events = Events()
        let carry = SelfPauseCarryOver(manual: .pause, basis: .using, lastKnown: .using, idleFor: 0)
        let rule = SelfPauseRule(app: "x", ownPID: 1, restoring: carry)
        await announceSelfPause(rule, at: 7, origin: 7, emit: { events.append($0) })
        #expect(events.values == [.selfPause(.paused(.manual), start: 0), .selfPauseState(carry)])
    }
}
