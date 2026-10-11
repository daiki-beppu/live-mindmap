import Foundation

// `readings` サブコマンド（Issue #640）。語をまとめて受け取り、語ごとのローマ字の読みを返す。
// server が利用者の足した語の読みを作るために、1 回ずつ起動する。

/// 語とその読み。出力の JSON の要素（`surface` と `romaji` だけ）。
public struct Reading: Sendable, Equatable, Codable {
    public var surface: String
    public var romaji: String

    public init(surface: String, romaji: String) {
        self.surface = surface
        self.romaji = romaji
    }
}

/// `readings` サブコマンドの引数を解釈する。引数ごとに 1 語として、渡した順のまま返す。0 語は拒否する。
public func parseReadingsArguments(_ arguments: [String]) -> Result<[String], RunArgumentsError> {
    guard !arguments.isEmpty else { return .failure(RunArgumentsError("語が必要")) }
    return .success(arguments)
}

/// 語の並びから 1 語の読みを作る。語のローマ字を順につなぐ。
/// 読みが空の語を 1 つでも含むとき、または語が 0 個のときは、部分的な読みで照合させないために nil を返す。
public func reading(from words: [Word]) -> String? {
    guard !words.isEmpty, words.allSatisfy({ !$0.romaji.isEmpty }) else { return nil }
    return words.map(\.romaji).joined()
}

/// 語ごとの読みを返す（実際のトークナイザを使う）。読みが作れない語は返さない。入力の順を保つ。
public func readings(of surfaces: [String]) -> [Reading] {
    surfaces.compactMap { surface in
        reading(from: transcriptWords(surface)).map { Reading(surface: surface, romaji: $0) }
    }
}
