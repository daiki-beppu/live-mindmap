import Foundation
import Testing
@testable import HelperCore

// 語ごとの読み（Issue #640）の純粋な部分。語の並びからの読みの作り方と、出力の JSON の形。
// 実際のトークナイザを通すものは ReadingsITTests に置く。

@Suite("語の読みの組み立て（reading(from:)）")
struct ReadingsTests {
    private func word(_ surface: String, _ romaji: String, _ location: Int = 0) -> Word {
        Word(surface: surface, romaji: romaji, location: location, length: surface.utf16.count)
    }

    @Test("語のローマ字を順につないだものが、その語の読みになる")
    func concatenates() {
        let words = [word("江南", "kounan"), word("店", "ten", 2)]
        #expect(reading(from: words) == "kounanten")
    }

    @Test("語が 1 つだけなら、その語の読みそのもの")
    func single() {
        #expect(reading(from: [word("会議", "kaigi")]) == "kaigi")
    }

    @Test("読みが空の語を 1 つでも含めば、部分的な読みを返さず nil にする")
    func emptyRomajiMakesNil() {
        let words = [word("全", "zen"), word("？？", "", 1), word("デスク", "desuku", 3)]
        #expect(reading(from: words) == nil)
    }

    @Test("語が 0 個なら nil")
    func noWords() {
        #expect(reading(from: []) == nil)
    }

    @Test("出力の JSON は surface と romaji の 2 項目だけ")
    func encodesSurfaceAndRomaji() throws {
        let data = try JSONEncoder().encode(Reading(surface: "会議", romaji: "kaigi"))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(object == ["surface": "会議", "romaji": "kaigi"])
    }
}
