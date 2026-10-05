import Foundation
import Testing
import HelperCore

// WebSocket に流すイベントの形（ADR 0002）。項目名はサーバーの Remark（server/src/core/session.ts）に合わせる。

private func decode(_ event: HelperEvent) throws -> [String: Any] {
    let json = try event.jsonString()
    let object = try JSONSerialization.jsonObject(with: Data(json.utf8))
    return try #require(object as? [String: Any])
}

@Suite("イベントの形")
struct EventsTests {
    @Test("確定結果は発言イベントになり、トラック・開始・終了・本文・重複の印を持つ")
    func finalResultBecomesRemark() throws {
        let result = TranscriptionResult(text: "こんにちは", isFinal: true, start: 1.5, end: 3.25)
        let event = event(from: result, track: .相手)
        #expect(event == .remark(track: .相手, start: 1.5, end: 3.25, text: "こんにちは", duplicate: false))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate"])
        #expect(json["type"] as? String == "remark")
        #expect(json["track"] as? String == "相手")
        #expect(json["start"] as? Double == 1.5)
        #expect(json["end"] as? Double == 3.25)
        #expect(json["text"] as? String == "こんにちは")
        #expect(json["duplicate"] as? Bool == false)
    }

    @Test("途中結果は発言とは別のイベントになり、トラック・開始・終了・本文・重複の印を持つ（event(from:) の印は false）")
    func volatileResultBecomesPartial() throws {
        let result = TranscriptionResult(text: "こんに", isFinal: false, start: 1.5, end: 2.0)
        let event = event(from: result, track: .相手)
        #expect(event == .partial(track: .相手, start: 1.5, end: 2.0, text: "こんに", duplicate: false))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate"])
        #expect(json["type"] as? String == "partial")
        #expect(json["track"] as? String == "相手")
        #expect(json["start"] as? Double == 1.5)
        #expect(json["end"] as? Double == 2.0)
        #expect(json["text"] as? String == "こんに")
        #expect(json["duplicate"] as? Bool == false)
    }

    @Test("途中結果の重複の印は true も JSON に載る")
    func partialDuplicateTrue() throws {
        let json = try decode(.partial(track: .自分, start: 1, end: 2, text: "こんに", duplicate: true))
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate"])
        #expect(json["type"] as? String == "partial")
        #expect(json["duplicate"] as? Bool == true)
    }

    @Test("自分のトラックも同じ形で表せる")
    func selfTrackUsesSameShape() throws {
        let remark = try decode(event(from: TranscriptionResult(text: "はい", isFinal: true, start: 0, end: 1), track: .自分))
        #expect(Set(remark.keys) == ["type", "track", "start", "end", "text", "duplicate"])
        #expect(remark["track"] as? String == "自分")

        let partial = try decode(event(from: TranscriptionResult(text: "は", isFinal: false, start: 0, end: 1), track: .自分))
        #expect(Set(partial.keys) == ["type", "track", "start", "end", "text", "duplicate"])
        #expect(partial["track"] as? String == "自分")
    }

    @Test("トラックの値はサーバーの Track と同じ文字列")
    func trackRawValues() {
        #expect(Track.自分.rawValue == "自分")
        #expect(Track.相手.rawValue == "相手")
    }

    @Test("発言イベントはヘルパーで id を振らない")
    func remarkHasNoId() throws {
        let json = try decode(.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false))
        #expect(json["id"] == nil)
    }

    // Issue #161: 原点（host time）の通知。64 bit の値は JSON の number では桁が落ちるので、文字列として積む（要件 #22）
    @Test("origin は hostTime を持つ。JSON では文字列として積み、2^53 を超える値でも桁が落ちない")
    func originCarriesHostTimeAsString() throws {
        let event = HelperEvent.origin(hostTime: 9_007_199_254_740_993)
        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "hostTime"])
        #expect(json["type"] as? String == "origin")
        #expect(json["hostTime"] as? String == "9007199254740993")
    }

    @Test("origin の値が等しければイベントも等しい")
    func originEquality() {
        #expect(HelperEvent.origin(hostTime: 42) == HelperEvent.origin(hostTime: 42))
        #expect(HelperEvent.origin(hostTime: 1) != HelperEvent.origin(hostTime: 2))
    }
}
