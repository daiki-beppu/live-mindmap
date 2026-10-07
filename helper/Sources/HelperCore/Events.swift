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

/// WebSocket に流すイベント。確定結果は `remark`、途中結果は別の `partial`。どちらも `duplicate` を持つ。
/// `id` はサーバーが採番するので、ここでは持たない。
public enum HelperEvent: Sendable, Equatable {
    case remark(track: Track, start: Double, end: Double, text: String, duplicate: Bool)
    case partial(track: Track, start: Double, end: Double, text: String, duplicate: Bool)
    /// 2 トラック共通の時刻の基準（`AudioGetCurrentHostTime()` の値）の通知。ヘルパー起動につき 1 回だけ流す（Issue #161）。
    case origin(hostTime: UInt64)
    /// 共有画面の変化（Issue #278）。`start` は `origin` と同じ原点からの秒。
    /// `image` は JPEG の base64。映していたウィンドウが無くなったときは nil で、JSON では `null` を明示する。
    case screen(start: Double, image: String?)

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
        case type, track, start, end, text, duplicate, hostTime, image
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
        case let .partial(track, start, end, text, duplicate):
            try container.encode("partial", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(text, forKey: .text)
            try container.encode(duplicate, forKey: .duplicate)
        case let .origin(hostTime):
            try container.encode("origin", forKey: .type)
            // 64 bit の値は JSON の number では桁が落ちるので、文字列として積む。
            try container.encode(String(hostTime), forKey: .hostTime)
        case let .screen(start, image):
            try container.encode("screen", forKey: .type)
            try container.encode(start, forKey: .start)
            // nil でもキーを省かず、JSON の null として出す（`encodeIfPresent` は使わない）。
            if let image {
                try container.encode(image, forKey: .image)
            } else {
                try container.encodeNil(forKey: .image)
            }
        }
    }
}

/// STT の結果をイベントにする。`duplicate` は常に false。重複の判定は `DuplicateMarker` が行い、呼び出し側（`relay`）が印を付ける。
public func event(from result: TranscriptionResult, track: Track) -> HelperEvent {
    if result.isFinal {
        return .remark(track: track, start: result.start, end: result.end, text: result.text, duplicate: false)
    }
    return .partial(track: track, start: result.start, end: result.end, text: result.text, duplicate: false)
}
