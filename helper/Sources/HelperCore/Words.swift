import Foundation

/// 発言の本文の 1 語。`remark` / `partial` の `words` の要素（server/src/core/words.ts の `Word` と同じ項目名と単位）。
/// `location` / `length` は本文の UTF-16 コード単位（NSString の範囲）。`start` / `end`（秒）とは別物。
public struct Word: Sendable, Equatable, Encodable {
    /// 本文中の表記。
    public var surface: String
    /// `kCFStringTokenizerAttributeLatinTranscription` によるローマ字の読み。読みが無い語は空文字。
    public var romaji: String
    public var location: Int
    public var length: Int

    public init(surface: String, romaji: String, location: Int, length: Int) {
        self.surface = surface
        self.romaji = romaji
        self.location = location
        self.length = length
    }
}

/// 本文を CFStringTokenizer（`ja`、語の境界）で語に区切る。補正はしない。
public func transcriptWords(_ text: String) -> [Word] {
    let cfText = text as CFString
    let length = CFStringGetLength(cfText)
    guard length > 0 else { return [] }
    let tokenizer = CFStringTokenizerCreate(
        nil, cfText, CFRange(location: 0, length: length),
        kCFStringTokenizerUnitWordBoundary, Locale(identifier: "ja") as CFLocale)
    let nsText = text as NSString
    var words: [Word] = []
    while CFStringTokenizerAdvanceToNextToken(tokenizer) != [] {
        let range = CFStringTokenizerGetCurrentTokenRange(tokenizer)
        let romaji = CFStringTokenizerCopyCurrentTokenAttribute(tokenizer, kCFStringTokenizerAttributeLatinTranscription) as? String
        words.append(Word(
            surface: nsText.substring(with: NSRange(location: range.location, length: range.length)),
            romaji: romaji ?? "", location: range.location, length: range.length))
    }
    return words
}
