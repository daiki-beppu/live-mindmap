import Foundation

public struct Reading: Sendable, Equatable, Codable {
    public var surface: String
    public var romaji: String

    public init(surface: String, romaji: String) {
        self.surface = surface
        self.romaji = romaji
    }
}

public func parseReadingsArguments(_ arguments: [String]) -> Result<[String], RunArgumentsError> {
    guard !arguments.isEmpty else { return .failure(RunArgumentsError("語が必要")) }
    return .success(arguments)
}

public func reading(from words: [Word]) -> String? {
    guard !words.isEmpty, words.allSatisfy({ !$0.romaji.isEmpty }) else { return nil }
    return words.map(\.romaji).joined()
}

public func readings(of surfaces: [String]) -> [Reading] {
    surfaces.compactMap { surface in
        reading(from: transcriptWords(surface)).map { Reading(surface: surface, romaji: $0) }
    }
}
