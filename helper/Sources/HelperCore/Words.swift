import Foundation

public struct Word: Sendable, Equatable, Encodable {
    public var surface: String
    public var romaji: String
    public var utf16Offset: Int
    public var utf16Length: Int

    private enum CodingKeys: String, CodingKey {
        case surface, romaji
        case utf16Offset = "location"
        case utf16Length = "length"
    }

    public init(surface: String, romaji: String, utf16Offset: Int, utf16Length: Int) {
        self.surface = surface
        self.romaji = romaji
        self.utf16Offset = utf16Offset
        self.utf16Length = utf16Length
    }
}

public struct WordTime: Sendable, Equatable, Encodable {
    public var utf16Offset: Int
    public var utf16Length: Int
    public var start: Double
    public var end: Double

    private enum CodingKeys: String, CodingKey {
        case utf16Offset = "location"
        case utf16Length = "length"
        case start, end
    }

    public init(utf16Offset: Int, utf16Length: Int, start: Double, end: Double) {
        self.utf16Offset = utf16Offset
        self.utf16Length = utf16Length
        self.start = start
        self.end = end
    }
}

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
            romaji: romaji ?? "", utf16Offset: range.location, utf16Length: range.length))
    }
    return words
}
