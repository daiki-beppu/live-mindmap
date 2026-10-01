import Foundation

/// 発言のトラック。値はサーバーの `Track`（server/src/core/session.ts）と同じ文字列。
public enum Track: String, Sendable, Equatable {
    case 自分
    case 相手
}

/// STT が返す 1 件の結果。`isFinal` が true なら確定結果、false なら途中結果。
/// `start` / `end` は、`run` が音声取得を始める直前を 0 とする、2 トラック共通の秒数。
public struct TranscriptionResult: Sendable, Equatable {
    public var text: String
    public var isFinal: Bool
    public var start: Double
    public var end: Double

    public init(text: String, isFinal: Bool, start: Double, end: Double) {
        self.text = text
        self.isFinal = isFinal
        self.start = start
        self.end = end
    }
}

/// WebSocket に流すイベント。確定結果は `remark`、途中結果は別の `partial`。
/// `id` はサーバーが採番するので、ここでは持たない。
public enum HelperEvent: Sendable, Equatable {
    case remark(track: Track, start: Double, end: Double, text: String, duplicate: Bool)
    case partial(track: Track, text: String)

    /// WebSocket のテキストフレームに載せる JSON 文字列。
    public func jsonString() throws -> String {
        // キーの順序を固定する（同じイベントは常に同じ文字列になる）。
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(self)
        guard let json = String(data: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(self, .init(codingPath: [], debugDescription: "UTF-8 に変換できない"))
        }
        return json
    }
}

extension HelperEvent: Encodable {
    private enum CodingKeys: String, CodingKey {
        case type, track, start, end, text, duplicate
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .remark(track, start, end, text, duplicate):
            try container.encode("remark", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(text, forKey: .text)
            try container.encode(duplicate, forKey: .duplicate)
        case let .partial(track, text):
            try container.encode("partial", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(text, forKey: .text)
        }
    }
}

/// STT の結果をイベントにする。重複の判定はヘルパーでは行わないので、`duplicate` は常に false。
public func event(from result: TranscriptionResult, track: Track) -> HelperEvent {
    if result.isFinal {
        return .remark(track: track, start: result.start, end: result.end, text: result.text, duplicate: false)
    }
    return .partial(track: track, text: result.text)
}
