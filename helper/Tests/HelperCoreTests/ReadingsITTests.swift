import Foundation
import Testing
@testable import HelperCore

// 語ごとのローマ字の読み（Issue #640）。実際の CFStringTokenizer（ja）を通す。
// 期待値は実際のトークナイザの出力（macOS 上で確認した値）。

@Suite("語ごとの読み（readings(of:)）")
struct ReadingsITTests {
    @Test("漢字の語にローマ字の読みが付き、語ごとに入力の順で返る")
    func kanjiWords() {
        let result = readings(of: ["会議", "港南店", "野々村"])
        #expect(result == [
            Reading(surface: "会議", romaji: "kaigi"),
            Reading(surface: "港南店", romaji: "kounanten"),
            Reading(surface: "野々村", romaji: "nonomura"),
        ])
    }

    @Test("トークナイザが語を分けても、1 語の読みは語の読みをつないだ 1 つの値になる")
    func joinsTokens() {
        // 「江南店」は 江南 / 店 の 2 語に区切られる
        #expect(readings(of: ["江南店"]) == [Reading(surface: "江南店", romaji: "kounanten")])
    }

    @Test("小さいカナの読みは、トークナイザの返す形（~ を含む）のまま返す。整えるのは server の照合")
    func smallKanaIsLeftToServer() {
        #expect(readings(of: ["トゥイッチ"]) == [Reading(surface: "トゥイッチ", romaji: "to~uitchi")])
    }

    @Test("読みが作れない語（空の語）は返さない。ほかの語は返す")
    func skipsUnreadable() {
        let result = readings(of: ["", "会議"])
        #expect(result == [Reading(surface: "会議", romaji: "kaigi")])
    }
}
