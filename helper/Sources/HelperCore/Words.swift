import Foundation

public struct Word: Sendable, Equatable, Encodable {
    public var surface: String
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

public struct WordTime: Sendable, Equatable, Encodable {
    public var location: Int
    public var length: Int
    public var start: Double
    public var end: Double

    public init(location: Int, length: Int, start: Double, end: Double) {
        self.location = location
        self.length = length
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
            romaji: romaji ?? "", location: range.location, length: range.length))
    }
    return words
}
