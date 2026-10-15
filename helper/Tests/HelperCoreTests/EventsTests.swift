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
        #expect(event == .remark(track: .相手, start: 1.5, end: 3.25, text: "こんにちは", duplicate: false, words: fixedWords, wordTimes: []))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words", "wordTimes"])
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
        #expect(event == .partial(track: .相手, start: 1.5, end: 2.0, text: "こんに", duplicate: false, words: fixedWords, wordTimes: []))

        let json = try decode(event)
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words", "wordTimes"])
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
        let json = try decode(.partial(track: .自分, start: 1, end: 2, text: "こんに", duplicate: true, words: [], wordTimes: []))
        #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words", "wordTimes"])
        #expect(json["type"] as? String == "partial")
        #expect(json["duplicate"] as? Bool == true)
    }

    @Test("自分のトラックも同じ形で表せる")
    func selfTrackUsesSameShape() throws {
        let remark = try decode(event(from: TranscriptionResult(text: "はい", isFinal: true, start: 0, end: 1), track: .自分, words: { _ in [] }))
        #expect(Set(remark.keys) == ["type", "track", "start", "end", "text", "duplicate", "words", "wordTimes"])
        #expect(remark["track"] as? String == "自分")

        let partial = try decode(event(from: TranscriptionResult(text: "は", isFinal: false, start: 0, end: 1), track: .自分, words: { _ in [] }))
        #expect(Set(partial.keys) == ["type", "track", "start", "end", "text", "duplicate", "words", "wordTimes"])
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
        #expect(try HelperEvent.remark(track: .相手, start: 0, end: 1, text: "", duplicate: false, words: [], wordTimes: []).jsonString().contains("\"words\":[]"))
    }

    @Test("words の JSON 要素は surface・romaji・location・length だけを持ち、位置と長さは数値")
    func wordJSONShape() throws {
        let json = try decode(.remark(track: .相手, start: 0, end: 1, text: "x", duplicate: false, words: [Word(surface: "x", romaji: "", location: 3, length: 1)], wordTimes: []))
        let word = try #require(try wordsOf(json).first)
        #expect(Set(word.keys) == ["surface", "romaji", "location", "length"])
        #expect(word["location"] as? Int == 3)
        #expect(word["length"] as? Int == 1)
        #expect(word["romaji"] as? String == "")
    }

    @Test("words が違えばイベントも違う")
    func wordsParticipateInEquality() {
        let a = HelperEvent.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: [], wordTimes: [])
        let b = HelperEvent.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: fixedWords, wordTimes: [])
        #expect(a != b)
    }

    // Issue #1019: 語ごとの区間。STT の run ごとの区間を、本文の UTF-16 位置と会議の原点基準の秒で載せる
    private static let fixedWordTimes = [
        WordTime(location: 0, length: 5, start: 1.5, end: 2.25),
        WordTime(location: 5, length: 2, start: 2.25, end: 3),
    ]
    private static let fixedWordTimesJSON: [[String: Any]] = [
        ["location": 0, "length": 5, "start": 1.5, "end": 2.25],
        ["location": 5, "length": 2, "start": 2.25, "end": 3.0],
    ]

    @Test("event(from:) は結果の語の区間を wordTimes に載せる（トラック × 確定/途中 × 重複の印で、同じ形）")
    func eventCarriesWordTimesOnEveryTrackAndKind() throws {
        for track in [Track.相手, Track.自分] {
            for isFinal in [true, false] {
                for duplicate in [false, true] {
                    let result = TranscriptionResult(text: "こんにちは𠮷", isFinal: isFinal, start: 1.5, end: 3, wordTimes: Self.fixedWordTimes)
                    let json = try decode(event(from: result, track: track, duplicate: duplicate, words: { _ in fixedWords }))
                    #expect(Set(json.keys) == ["type", "track", "start", "end", "text", "duplicate", "words", "wordTimes"])
                    #expect(json["type"] as? String == (isFinal ? "remark" : "partial"))
                    #expect(json["track"] as? String == track.rawValue)
                    #expect(json["duplicate"] as? Bool == duplicate)
                    let wordTimes = try #require(json["wordTimes"] as? [[String: Any]])
                    #expect(NSArray(array: wordTimes).isEqual(to: Self.fixedWordTimesJSON))
                    for item in wordTimes { #expect(Set(item.keys) == ["location", "length", "start", "end"]) }
                }
            }
        }
    }

    @Test("語の区間の無い結果は、wordTimes を空の配列として載せる（キーを省かない）。TranscriptionResult の既定は空")
    func missingWordTimesIsExplicitEmptyArray() throws {
        let result = TranscriptionResult(text: "はい", isFinal: true, start: 0, end: 1)
        #expect(result.wordTimes.isEmpty)
        for track in [Track.相手, Track.自分] {
            let json = try decode(event(from: result, track: track, words: { _ in [] }))
            #expect(try #require(json["wordTimes"] as? [Any]).isEmpty)
        }
    }

    @Test("event(from:) の duplicate の既定は false")
    func duplicateDefaultsToFalse() throws {
        let json = try decode(event(from: TranscriptionResult(text: "はい", isFinal: false, start: 0, end: 1), track: .自分, words: { _ in [] }))
        #expect(json["duplicate"] as? Bool == false)
    }

    @Test("wordTimes が違えばイベントも違う")
    func wordTimesParticipateInEquality() {
        let a = HelperEvent.partial(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: [], wordTimes: [])
        let b = HelperEvent.partial(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: [], wordTimes: Self.fixedWordTimes)
        #expect(a != b)
    }

    @Test("トラックの値はサーバーの Track と同じ文字列")
    func trackRawValues() {
        #expect(Track.自分.rawValue == "自分")
        #expect(Track.相手.rawValue == "相手")
    }

    @Test("発言イベントはヘルパーで id を振らない")
    func remarkHasNoId() throws {
        let json = try decode(.remark(track: .相手, start: 0, end: 1, text: "a", duplicate: false, words: [], wordTimes: []))
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
        let json = try decode(.screen(start: 12.5, image: "/9j/4AAQSkZJRg==", lines: nil))
        #expect(Set(json.keys) == ["type", "start", "image"])
        #expect(json["type"] as? String == "screen")
        #expect(json["start"] as? Double == 12.5)
        #expect(json["image"] as? String == "/9j/4AAQSkZJRg==")
    }

    // Issue #643: 送る画面には Vision で読んだ行を lines（文字列の配列）として載せる
    @Test("lines つきの screen は type・start・image・lines を持ち、lines は文字列の配列のまま積む")
    func screenCarriesLines() throws {
        let json = try decode(.screen(start: 12.5, image: "/9j/4AAQSkZJRg==", lines: ["港南店", "Zendesk"]))
        #expect(Set(json.keys) == ["type", "start", "image", "lines"])
        #expect(json["image"] as? String == "/9j/4AAQSkZJRg==")
        #expect(json["lines"] as? [String] == ["港南店", "Zendesk"])
    }

    @Test("OCR が失敗した screen は lines を空の配列として明示する（キーを省かない）")
    func screenWithEmptyLinesWritesEmptyArray() throws {
        let json = try decode(.screen(start: 1, image: "AA==", lines: []))
        #expect(Set(json.keys) == ["type", "start", "image", "lines"])
        #expect((json["lines"] as? [Any])?.isEmpty == true)
        #expect(try HelperEvent.screen(start: 1, image: "AA==", lines: []).jsonString().contains("\"lines\":[]"))
    }

    @Test("画像が null の screen には lines キーを付けない")
    func screenWithNullImageHasNoLinesKey() throws {
        let json = try decode(.screen(start: 3, image: nil, lines: nil))
        #expect(Set(json.keys) == ["type", "start", "image"])
        #expect(json["image"] is NSNull)
    }

    @Test("lines が違えば screen は等しくない")
    func screenEqualityConsidersLines() {
        #expect(HelperEvent.screen(start: 1, image: "AA==", lines: ["a"]) == HelperEvent.screen(start: 1, image: "AA==", lines: ["a"]))
        #expect(HelperEvent.screen(start: 1, image: "AA==", lines: ["a"]) != HelperEvent.screen(start: 1, image: "AA==", lines: ["b"]))
        #expect(HelperEvent.screen(start: 1, image: "AA==", lines: []) != HelperEvent.screen(start: 1, image: "AA==", lines: nil))
    }

    @Test("ウィンドウが無くなった screen は image を JSON の null として明示する（キーを省かない）")
    func screenWithoutImageWritesExplicitNull() throws {
        let json = try decode(.screen(start: 3, image: nil, lines: nil))
        #expect(Set(json.keys) == ["type", "start", "image"])
        #expect(json["type"] as? String == "screen")
        #expect(json["start"] as? Double == 3)
        #expect(json["image"] is NSNull)
        #expect(try HelperEvent.screen(start: 3, image: nil, lines: nil).jsonString().contains("\"image\":null"))
    }

    @Test("screen の値が等しければイベントも等しい")
    func screenEquality() {
        #expect(HelperEvent.screen(start: 1, image: "AA==", lines: nil) == HelperEvent.screen(start: 1, image: "AA==", lines: nil))
        #expect(HelperEvent.screen(start: 1, image: "AA==", lines: nil) != HelperEvent.screen(start: 2, image: "AA==", lines: nil))
        #expect(HelperEvent.screen(start: 1, image: "AA==", lines: nil) != HelperEvent.screen(start: 1, image: nil, lines: nil))
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
        #expect(HelperEvent.screenOff(start: 1, reason: .許可なし) != HelperEvent.screen(start: 1, image: nil, lines: nil))
    }

    // Issue #1069・#1071: 自分の休止の状態が変わるたびに流すイベント。reason は手動・自動・判定できないのどれか。start は origin からの秒
    @Test("self-pause は paused・reason・start を持ち、休止にも再開にも同じ形で使える")
    func selfPauseEventShape() throws {
        for paused in [true, false] {
            let json = try decode(.selfPause(paused: paused, reason: .manual, start: 12.5))
            #expect(Set(json.keys) == ["type", "paused", "reason", "start"])
            #expect(json["type"] as? String == "self-pause")
            #expect(json["paused"] as? Bool == paused)
            #expect(json["reason"] as? String == "手動")
            #expect(json["start"] as? Double == 12.5)
        }
    }

    @Test("self-pause の reason は、手動・自動・判定できないがそれぞれの文字列で出る")
    func selfPauseReasonValues() throws {
        for (reason, text) in [(SelfPauseReason.manual, "手動"), (.automatic, "自動"), (.undetermined, "判定できない")] {
            #expect(try decode(.selfPause(paused: true, reason: reason, start: 1))["reason"] as? String == text)
        }
        #expect(try HelperEvent.selfPause(paused: true, reason: .automatic, start: 12.5).jsonString()
            == "{\"paused\":true,\"reason\":\"自動\",\"start\":12.5,\"type\":\"self-pause\"}")
    }

    @Test("self-pause-state は手動・基準・最後に読めた値・待ちの進み具合だけを持つ。server が起動し直しで送り直すため")
    func selfPauseStateEventShape() throws {
        let state = SelfPauseCarryOver(manual: .pause, basis: .using, lastKnown: .idle, idleFor: 1.5)
        let json = try decode(.selfPauseState(state))
        #expect(Set(json.keys) == ["type", "manual", "basis", "lastKnown", "idleFor"])
        #expect(json["type"] as? String == "self-pause-state")
        #expect(json["manual"] as? String == "pause")
        #expect(json["basis"] as? String == "using")
        #expect(json["lastKnown"] as? String == "idle")
        #expect(json["idleFor"] as? Double == 1.5)
        #expect(try HelperEvent.selfPauseState(.initial).jsonString()
            == "{\"basis\":\"unknown\",\"idleFor\":0,\"lastKnown\":\"unknown\",\"manual\":\"none\",\"type\":\"self-pause-state\"}")
    }

    // Issue #1020: 話者の区間。STT とは別のイベントで、仮と確定は final で見分ける。slot は Sortformer の出力の番号
    @Test("speaker は type・track・start・end・slot・final だけを持つ")
    func speakerCarriesSegmentFields() throws {
        let json = try decode(.speaker(track: .相手, start: 1.5, end: 2.75, slot: 2, isFinal: true))
        #expect(Set(json.keys) == ["type", "track", "start", "end", "slot", "final"])
        #expect(json["type"] as? String == "speaker")
        #expect(json["track"] as? String == "相手")
        #expect(json["start"] as? Double == 1.5)
        #expect(json["end"] as? Double == 2.75)
        #expect(json["slot"] as? Int == 2)
        #expect(json["final"] as? Bool == true)
    }

    @Test("speaker の final は、仮なら false・確定なら true")
    func speakerFinalFlag() throws {
        let tentative = try decode(.speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: false))
        let confirmed = try decode(.speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true))
        #expect(tentative["final"] as? Bool == false)
        #expect(confirmed["final"] as? Bool == true)
    }

    @Test("speaker の JSON 文字列は固定のキー順")
    func speakerJSONString() throws {
        #expect(
            try HelperEvent.speaker(track: .相手, start: 0.5, end: 1.5, slot: 3, isFinal: false).jsonString()
                == "{\"end\":1.5,\"final\":false,\"slot\":3,\"start\":0.5,\"track\":\"相手\",\"type\":\"speaker\"}")
    }

    @Test("話者の区間はトラックを添えて speaker イベントになる。仮・確定・枠・時刻はそのまま運ぶ")
    func segmentBecomesSpeakerEvent() {
        let confirmed = SpeakerSegment(start: 1, end: 2.5, slot: 1, isFinal: true)
        let tentative = SpeakerSegment(start: 2.5, end: 3, slot: 0, isFinal: false)
        #expect(event(from: confirmed, track: .相手) == .speaker(track: .相手, start: 1, end: 2.5, slot: 1, isFinal: true))
        #expect(event(from: tentative, track: .相手) == .speaker(track: .相手, start: 2.5, end: 3, slot: 0, isFinal: false))
    }

    @Test("speaker-settled は type・track・to だけを持ち、JSON 文字列は固定のキー順")
    func speakerSettledCarriesPosition() throws {
        let json = try decode(.speakerSettled(track: .相手, to: 14.5))
        #expect(Set(json.keys) == ["type", "track", "to"])
        #expect(json["type"] as? String == "speaker-settled")
        #expect(json["track"] as? String == "相手")
        #expect(json["to"] as? Double == 14.5)
        #expect(try HelperEvent.speakerSettled(track: .相手, to: 14.5).jsonString() == "{\"to\":14.5,\"track\":\"相手\",\"type\":\"speaker-settled\"}")
    }

    @Test("話者分離の流れの 1 件は、区間なら speaker、確定済みの位置なら speaker-settled になる")
    func diarizationItemBecomesEvent() {
        let segment = SpeakerSegment(start: 1, end: 2.5, slot: 1, isFinal: true)
        #expect(event(from: .segment(segment), track: .相手) == .speaker(track: .相手, start: 1, end: 2.5, slot: 1, isFinal: true))
        #expect(event(from: .settled(to: 3), track: .相手) == .speakerSettled(track: .相手, to: 3))
    }

    @Test("speaker-off は type・start・reason だけを持ち、reason は原因の 3 語のどれか")
    func speakerOffCarriesStartAndReason() throws {
        for (reason, text) in [
            (SpeakerOffReason.モデルなし, "モデルなし"), (.読み込みに失敗, "読み込みに失敗"), (.途中で停止, "途中で停止"),
        ] {
            let json = try decode(.speakerOff(start: 4.5, reason: reason))
            #expect(Set(json.keys) == ["type", "start", "reason"])
            #expect(json["type"] as? String == "speaker-off")
            #expect(json["start"] as? Double == 4.5)
            #expect(json["reason"] as? String == text)
        }
    }

    @Test("speaker-off の JSON 文字列は固定のキー順")
    func speakerOffJSONString() throws {
        #expect(
            try HelperEvent.speakerOff(start: 0, reason: .モデルなし).jsonString()
                == "{\"reason\":\"モデルなし\",\"start\":0,\"type\":\"speaker-off\"}")
    }

    @Test("speaker と speaker-off は値が等しければ等しく、互いに区別される")
    func speakerEventEquality() {
        #expect(HelperEvent.speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true) == .speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true))
        #expect(HelperEvent.speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true) != .speaker(track: .相手, start: 0, end: 1, slot: 1, isFinal: true))
        #expect(HelperEvent.speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true) != .speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: false))
        #expect(HelperEvent.speakerOff(start: 1, reason: .モデルなし) != HelperEvent.speakerOff(start: 1, reason: .途中で停止))
        #expect(HelperEvent.speakerOff(start: 1, reason: .モデルなし) != HelperEvent.screenOff(start: 1, reason: .許可なし))
    }
}
