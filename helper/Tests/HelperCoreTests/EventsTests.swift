import Foundation
import Testing
import HelperCore

// WebSocket に流すイベントの形（ADR 0002）。項目名はサーバーの Remark（server/src/core/session.ts）に合わせる。

private func decode(_ event: HelperEvent) throws -> [String: Any] {
    let json = try event.jsonString()
    let object = try JSONSerialization.jsonObject(with: Data(json.utf8))
    return try #require(object as? [String: Any])
}

// 固定の語。実際のトークナイザは通さない（純粋な運搬と JSON の形だけを確かめる。トークナイザは WordsITTests）
private let fixedWords = [
    Word(surface: "こんにちは", romaji: "konnichiwa", location: 0, length: 5),
    Word(surface: "𠮷", romaji: "", location: 5, length: 2),
]
private let fixedWordsJSON: [[String: Any]] = [
    ["surface": "こんにちは", "romaji": "konnichiwa", "location": 0, "length": 5],
    ["surface": "𠮷", "romaji": "", "location": 5, "length": 2],
]
private func wordsOf(_ json: [String: Any]) throws -> [[String: Any]] {
    try #require(json["words"] as? [[String: Any]])
}

@Suite("イベントの形")
struct EventsTests {
    @Test("確定結果は発言イベントになり、トラック・開始・終了・本文・重複の印を持つ")
    func finalResultBecomesRemark() throws {
        let result = TranscriptionResult(text: "こんにちは", isFinal: true, start: 1.5, end: 3.25)
        let event = event(from: result, track: .相手, words: { _ in fixedWords })
        #expect(event == .remark(track: .相手, start: 1.5, end: 3.25, text: "こんにちは", duplicate: false, words: fixedWords))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words"])
        #expect(json["type"] as? String == "remark")
        #expect(json["track"] as? String == "相手")
        #expect(json["start"] as? Double == 1.5)
        #expect(json["end"] as? Double == 3.25)
        #expect(json["text"] as? String == "こんにちは")
        #expect(json["duplicate"] as? Bool == false)
        #expect(NSArray(array: try wordsOf(json)).isEqual(to: fixedWordsJSON))
    }

    @Test("途中結果は発言とは別のイベントになり、トラック・開始・終了・本文・重複の印を持つ（event(from:) の印は false）")
    func volatileResultBecomesPartial() throws {
        let result = TranscriptionResult(text: "こんに", isFinal: false, start: 1.5, end: 2.0)
        let event = event(from: result, track: .相手, words: { _ in fixedWords })
        #expect(event == .partial(track: .相手, start: 1.5, end: 2.0, text: "こんに", duplicate: false, words: fixedWords))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words"])
        #expect(json["type"] as? String == "partial")
        #expect(json["track"] as? String == "相手")
        #expect(json["start"] as? Double == 1.5)
        #expect(json["end"] as? Double == 2.0)
        #expect(json["text"] as? String == "こんに")
        #expect(json["duplicate"] as? Bool == false)
        #expect(NSArray(array: try wordsOf(json)).isEqual(to: fixedWordsJSON))
    }

    @Test("途中結果の重複の印は true も JSON に載る")
    func partialDuplicateTrue() throws {
        let json = try decode(.partial(track: .自分, start: 1, end: 2, text: "こんに", duplicate: true, words: []))
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words"])
        #expect(json["type"] as? String == "partial")
        #expect(json["duplicate"] as? Bool == true)
    }

    @Test("自分のトラックも同じ形で表せる")
    func selfTrackUsesSameShape() throws {
        let remark = try decode(event(from: TranscriptionResult(text: "はい", isFinal: true, start: 0, end: 1), track: .自分, words: { _ in [] }))
        #expect(Set(remark.keys) == ["type", "track", "start", "end", "text", "duplicate", "words"])
        #expect(remark["track"] as? String == "自分")

        let partial = try decode(event(from: TranscriptionResult(text: "は", isFinal: false, start: 0, end: 1), track: .自分, words: { _ in [] }))
        #expect(Set(partial.keys) == ["type", "track", "start", "end", "text", "duplicate", "words"])
        #expect(partial["track"] as? String == "自分")
    }

    @Test("event(from:) は本文を語を作る関数に渡し、その結果を words に載せる（確定結果も途中結果も、両トラックで）")
    func eventCarriesWordsFromTheGivenFunction() throws {
        for track in [Track.相手, Track.自分] {
            for isFinal in [true, false] {
                let e = event(from: TranscriptionResult(text: "本文", isFinal: isFinal, start: 0, end: 1), track: track, words: { text in
                    [Word(surface: text, romaji: "honbun", location: 0, length: 2)]
                })
                let json = try decode(e)
                #expect(json["type"] as? String == (isFinal ? "remark" : "partial"))
                #expect(NSArray(array: try wordsOf(json)).isEqual(to: [["surface": "本文", "romaji": "honbun", "location": 0, "length": 2]]))
            }
        }
    }

    @Test("語が無い本文は、words を空の配列として載せる（キーを省かない）")
    func emptyWordsIsExplicitEmptyArray() throws {
        let json = try decode(event(from: TranscriptionResult(text: "", isFinal: true, start: 0, end: 1), track: .相手, words: { _ in [] }))
        #expect(try wordsOf(json).isEmpty)
        #expect(try HelperEvent.remark(track: .相手, start: 0, end: 1, text: "", duplicate: false, words: []).jsonString().contains("\"words\":[]"))
    }

    @Test("words の JSON 要素は surface・romaji・location・length だけを持ち、位置と長さは数値")
    func wordJSONShape() throws {
        let json = try decode(.remark(track: .相手, start: 0, end: 1, text: "x", duplicate: false, words: [Word(surface: "x", romaji: "", location: 3, length: 1)]))
        let word = try #require(try wordsOf(json).first)
        #expect(Set(word.keys) == ["surface", "romaji", "location", "length"])
        #expect(word["location"] as? Int == 3)
        #expect(word["length"] as? Int == 1)
        #expect(word["romaji"] as? String == "")
    }

    @Test("words が違えばイベントも違う")
    func wordsParticipateInEquality() {
        let a = HelperEvent.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: [])
        let b = HelperEvent.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: fixedWords)
        #expect(a != b)
    }

    @Test("トラックの値はサーバーの Track と同じ文字列")
    func trackRawValues() {
        #expect(Track.自分.rawValue == "自分")
        #expect(Track.相手.rawValue == "相手")
    }

    @Test("発言イベントはヘルパーで id を振らない")
    func remarkHasNoId() throws {
        let json = try decode(.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: []))
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

    // Issue #278: 共有画面の変化。start は origin と同じ原点からの秒、image は JPEG の base64（ウィンドウが無くなったら null）
    @Test("screen は type・start・image を持ち、image は JPEG の base64 文字列のまま積む")
    func screenCarriesStartAndImage() throws {
        let json = try decode(.screen(start: 12.5, image: "/9j/4AAQSkZJRg=="))
        #expect(Set(json.keys) == ["type", "start", "image"])
        #expect(json["type"] as? String == "screen")
        #expect(json["start"] as? Double == 12.5)
        #expect(json["image"] as? String == "/9j/4AAQSkZJRg==")
    }

    @Test("ウィンドウが無くなった screen は image を JSON の null として明示する（キーを省かない）")
    func screenWithoutImageWritesExplicitNull() throws {
        let json = try decode(.screen(start: 3, image: nil))
        #expect(Set(json.keys) == ["type", "start", "image"])
        #expect(json["type"] as? String == "screen")
        #expect(json["start"] as? Double == 3)
        #expect(json["image"] is NSNull)
        #expect(try HelperEvent.screen(start: 3, image: nil).jsonString().contains("\"image\":null"))
    }

    @Test("screen の値が等しければイベントも等しい")
    func screenEquality() {
        #expect(HelperEvent.screen(start: 1, image: "AA==") == HelperEvent.screen(start: 1, image: "AA=="))
        #expect(HelperEvent.screen(start: 1, image: "AA==") != HelperEvent.screen(start: 2, image: "AA=="))
        #expect(HelperEvent.screen(start: 1, image: "AA==") != HelperEvent.screen(start: 1, image: nil))
    }

    // Issue #280: 画面収録の許可が無いときの screen-off。start は origin と同じ原点からの秒
    @Test("screen-off は type・start・reason を持ち、reason は「許可なし」")
    func screenOffCarriesStartAndReason() throws {
        let json = try decode(.screenOff(start: 4.5, reason: .許可なし))
        #expect(Set(json.keys) == ["type", "start", "reason"])
        #expect(json["type"] as? String == "screen-off")
        #expect(json["start"] as? Double == 4.5)
        #expect(json["reason"] as? String == "許可なし")
    }

    @Test("screen-off の JSON 文字列は固定のキー順で、同じイベントは常に同じ文字列になる")
    func screenOffJSONString() throws {
        #expect(try HelperEvent.screenOff(start: 0, reason: .許可なし).jsonString() == "{\"reason\":\"許可なし\",\"start\":0,\"type\":\"screen-off\"}")
    }

    // Issue #863: タップに音声が届かないときの tap-silent。start は origin と同じ原点からの秒
    @Test("tap-silent は type と start だけを持つ")
    func tapSilentCarriesStart() throws {
        let json = try decode(.tapSilent(start: 10.5))
        #expect(Set(json.keys) == ["type", "start"])
        #expect(json["type"] as? String == "tap-silent")
        #expect(json["start"] as? Double == 10.5)
    }

    @Test("tap-silent の JSON 文字列は固定のキー順")
    func tapSilentJSONString() throws {
        #expect(try HelperEvent.tapSilent(start: 10.5).jsonString() == "{\"start\":10.5,\"type\":\"tap-silent\"}")
    }

    @Test("screen-off の値が等しければイベントも等しい。screen とは区別される")
    func screenOffEquality() {
        #expect(HelperEvent.screenOff(start: 1, reason: .許可なし) == HelperEvent.screenOff(start: 1, reason: .許可なし))
        #expect(HelperEvent.screenOff(start: 1, reason: .許可なし) != HelperEvent.screenOff(start: 2, reason: .許可なし))
        #expect(HelperEvent.screenOff(start: 1, reason: .許可なし) != HelperEvent.screen(start: 1, image: nil))
    }
}
