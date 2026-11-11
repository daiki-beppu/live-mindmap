import Foundation
import Testing
import HelperCore

@Suite("発言の語ごとの読み", .timeLimit(.minutes(1)))
struct WordsITTests {
    private func substring(_ text: String, _ word: Word) -> String {
        (text as NSString).substring(with: NSRange(location: word.utf16Offset, length: word.utf16Length))
    }

    @Test("日本語の本文を語に区切り、位置と長さで本文の範囲を指す")
    func japaneseSplitsIntoWordsWithRanges() {
        let text = "今日は会議があります"
        let words = transcriptWords(text)

        #expect(words.count >= 2)
        for word in words { #expect(substring(text, word) == word.surface) }
    }

    @Test("語は本文の先頭から順に並び、互いに重ならない")
    func wordsAreOrderedAndDisjoint() {
        let words = transcriptWords("明日の定例会議で採用について話します")

        #expect(!words.isEmpty)
        var end = 0
        for word in words {
            #expect(word.utf16Offset >= end)
            #expect(word.utf16Length > 0)
            end = word.utf16Offset + word.utf16Length
        }
    }

    @Test("ローマ字の読みが入る。漢字の語にも読みが付く")
    func romajiIsPresent() throws {
        let words = transcriptWords("会議")

        #expect(words.count == 1)
        let word = try #require(words.first)
        #expect(word.surface == "会議")
        #expect(word.romaji == "kaigi")
    }

    @Test("補助平面の文字（UTF-16 で 2 コード単位）を含む本文でも、後ろの語の位置が UTF-16 で合う")
    func astralPlaneKeepsUTF16Offsets() throws {
        let text = "𠮷野家で会議"
        let words = transcriptWords(text)

        #expect(!words.isEmpty)
        for word in words { #expect(substring(text, word) == word.surface) }
        let last = try #require(words.last)
        #expect(last.utf16Offset + last.utf16Length == (text as NSString).length)
        #expect((text as NSString).length > text.count)
    }

    @Test("空の本文は語を作らない")
    func emptyTextHasNoWords() {
        #expect(transcriptWords("").isEmpty)
    }

    @Test("読みが得られない語は romaji を空文字にして、語は落とさない")
    func wordWithoutReadingIsKept() {
        let text = "ABC 123"
        let words = transcriptWords(text)

        #expect(!words.isEmpty)
        for word in words { #expect(substring(text, word) == word.surface) }
    }
}
