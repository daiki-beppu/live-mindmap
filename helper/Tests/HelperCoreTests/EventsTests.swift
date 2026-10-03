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

    @Test("途中結果は発言とは別のイベントになり、トラック・開始・終了・本文を持つ（重複の印は持たない）")
    func volatileResultBecomesPartial() throws {
        let result = TranscriptionResult(text: "こんに", isFinal: false, start: 1.5, end: 2.0)
        let event = event(from: result, track: .相手)
        #expect(event == .partial(track: .相手, start: 1.5, end: 2.0, text: "こんに"))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text"])
        #expect(json["type"] as? String == "partial")
        #expect(json["track"] as? String == "相手")
        #expect(json["start"] as? Double == 1.5)
        #expect(json["end"] as? Double == 2.0)
        #expect(json["text"] as? String == "こんに")
    }

    @Test("自分のトラックも同じ形で表せる")
    func selfTrackUsesSameShape() throws {
        let remark = try decode(event(from: TranscriptionResult(text: "はい", isFinal: true, start: 0, end: 1), track: .自分))
        #expect(Set(remark.keys) == ["type", "track", "start", "end", "text", "duplicate"])
        #expect(remark["track"] as? String == "自分")

        let partial = try decode(event(from: TranscriptionResult(text: "は", isFinal: false, start: 0, end: 1), track: .自分))
        #expect(Set(partial.keys) == ["type", "track", "start", "end", "text"])
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
}
