import Testing
@testable import HelperCore

// Issue #1069: server から helper への休止の指示（`{"type":"self-pause","paused":boolean,"token":string}`）の読み取りと認証、
// 休止の境界（同じ状態の指示は何も変えない。取得時刻で休止中かを決める）。音の流れの側の振る舞いは RunAudioTests が確かめる。

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
        // 同じ状態の指示は境界を足さない: 25 の時点では休止中、35 でも休止中（30 の指示は何も変えていない）、45 で再開
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
