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
    /// STT の run ごとの区間。本文の UTF-16 位置と、`start` / `end` と同じ基準の秒。持たない結果は空。
    public var wordTimes: [WordTime]

    public init(text: String, isFinal: Bool, start: Double, end: Double, wordTimes: [WordTime] = []) {
        self.text = text
        self.isFinal = isFinal
        self.start = start
        self.end = end
        self.wordTimes = wordTimes
    }
}

/// WebSocket に流すイベント。確定結果は `remark`、途中結果は別の `partial`。どちらも `duplicate` を持つ。
/// `id` はサーバーが採番するので、ここでは持たない。
/// `screen-off` の理由。ヘルパーが流すのは `許可なし` だけ（`指定` はサーバーが書く）。
public enum ScreenOffReason: String, Sendable, Equatable {
    case 許可なし
}

/// `speaker-off` の理由（Issue #1020）。
public enum SpeakerOffReason: String, Sendable, Equatable {
    case モデルなし
    case 読み込みに失敗
    case 途中で停止
}

public enum HelperEvent: Sendable, Equatable {
    case remark(track: Track, start: Double, end: Double, text: String, duplicate: Bool, words: [Word], wordTimes: [WordTime])
    case partial(track: Track, start: Double, end: Double, text: String, duplicate: Bool, words: [Word], wordTimes: [WordTime])
    /// 2 トラック共通の時刻の基準（`AudioGetCurrentHostTime()` の値）の通知。ヘルパー起動につき 1 回だけ流す（Issue #161）。
    case origin(hostTime: UInt64)
    /// 共有画面の変化（Issue #278）。`start` は `origin` と同じ原点からの秒。
    /// `image` は JPEG の base64。映していたウィンドウが無くなったときは nil で、JSON では `null` を明示する。
    /// `lines` は Vision で読んだ文字の行（Issue #643）。OCR に失敗したときは空の配列。画像が nil のときは nil で、キーを付けない。
    case screen(start: Double, image: String?, lines: [String]?)
    /// 共有画面を取り込めない（画面収録の許可が無い・断られた・途中で取れなくなった）。音声は続ける。`start` は `origin` と同じ原点からの秒。
    case screenOff(start: Double, reason: ScreenOffReason)
    /// 相手のタップから、フレーム数 1 以上のバッファが 10 秒届かなかった。`start` は `origin` と同じ原点からの秒。1 回だけ流す。
    case tapSilent(start: Double)
    /// `自分` の休止の状態が変わった（Issue #1069・#1071）。`reason` は手動・自動・判定できないのどれか。休止中に理由だけが変わったときも流す。`start` は `origin` と同じ原点からの秒。
    case selfPause(paused: Bool, reason: SelfPauseReason, start: Double)
    /// `自分` の休止の規則の、起動し直しで引き継ぐ状態（Issue #1071）。server が覚え、helper を起動し直すときに引数で送り直す。
    case selfPauseState(SelfPauseCarryOver)
    /// `相手` のトラックの話者の区間（Issue #1020）。`start` / `end` は `origin` と同じ原点からの秒。
    /// `slot` は Sortformer の出力の番号。`isFinal` が false なら仮の区間で、JSON のキーは `final`。
    case speaker(track: Track, start: Double, end: Double, slot: Int, isFinal: Bool)
    /// 話者分離が使えない（モデルが無い・読み込みに失敗・途中で停止）。認識は続ける。`start` は `origin` と同じ原点からの秒。
    case speakerOff(start: Double, reason: SpeakerOffReason)
    /// 録画の文字起こし（`transcribe-file`）が最初に流す、ファイルの音声の全体の長さ（秒）。サーバーが進み具合の「全体」に使う。
    case fileDuration(duration: Double)
    /// 録画の文字起こし（`transcribe-file`）が `file-duration` の後に流す、ファイルの音声トラックの本数。使うのは最初の 1 本だけ。サーバーは 2 本以上のとき端末に知らせる。
    case fileAudioTracks(count: Int)
    /// `相手` の話者分離が、ここまで確定した（Issue #1021）。`to` より前の確定した区間（`speaker` の `final: true`）は、すべて流した。
    /// `origin` と同じ原点からの秒。値は前に流した値より小さくならない。サーバーはこの位置で、発言の終わりまでの区間が揃ったかを判定する。
    case speakerSettled(track: Track, to: Double)
    /// `相手` の話者の枠 `slot` に、別の声が混ざっている（Issue #1024）。Sortformer の枠は 4 つまでで、5 人目以降が声の近い人の枠に混ざる。
    /// `start` は判定のもとになった確定区間の終わり（`origin` と同じ原点からの秒）。サーバーはその枠のラベルを、以降の発言に付けない。
    case speakerMixed(track: Track, slot: Int, start: Double)
    /// `相手` の話者の枠 `slot` の、主な塊の声の埋め込みの重心（長さ 1。Issue #1025）。重心が変わった枠だけを、変わるたびに最新の値で流す。
    /// サーバーはラベルごとの重心を覚え、ヘルパーを起動し直した後の新しい枠を前のラベルにつなぎ直すのに使う。ヘルパーは重心をプロセスをまたいで持たない。
    case speakerCentroid(track: Track, slot: Int, centroid: [Float])

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
        case type, track, start, end, text, duplicate, words, wordTimes, hostTime, image, lines, reason, paused, slot, final, duration, to, count
        case manual, basis, lastKnown, idleFor, centroid
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .remark(track, start, end, text, duplicate, words, wordTimes):
            try container.encode("remark", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(text, forKey: .text)
            try container.encode(duplicate, forKey: .duplicate)
            try container.encode(words, forKey: .words)
            try container.encode(wordTimes, forKey: .wordTimes)
        case let .partial(track, start, end, text, duplicate, words, wordTimes):
            try container.encode("partial", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(text, forKey: .text)
            try container.encode(duplicate, forKey: .duplicate)
            try container.encode(words, forKey: .words)
            try container.encode(wordTimes, forKey: .wordTimes)
        case let .origin(hostTime):
            try container.encode("origin", forKey: .type)
            // 64 bit の値は JSON の number では桁が落ちるので、文字列として積む。
            try container.encode(String(hostTime), forKey: .hostTime)
        case let .screen(start, image, lines):
            try container.encode("screen", forKey: .type)
            try container.encode(start, forKey: .start)
            // nil でもキーを省かず、JSON の null として出す（`encodeIfPresent` は使わない）。
            if let image {
                try container.encode(image, forKey: .image)
            } else {
                try container.encodeNil(forKey: .image)
            }
            if let lines {
                try container.encode(lines, forKey: .lines)
            }
        case let .screenOff(start, reason):
            try container.encode("screen-off", forKey: .type)
            try container.encode(start, forKey: .start)
            try container.encode(reason.rawValue, forKey: .reason)
        case let .tapSilent(start):
            try container.encode("tap-silent", forKey: .type)
            try container.encode(start, forKey: .start)
        case let .selfPause(paused, reason, start):
            try container.encode("self-pause", forKey: .type)
            try container.encode(paused, forKey: .paused)
            try container.encode(reason.rawValue, forKey: .reason)
            try container.encode(start, forKey: .start)
        case let .selfPauseState(state):
            try container.encode("self-pause-state", forKey: .type)
            try container.encode(state.manual.rawValue, forKey: .manual)
            try container.encode(state.basis.rawValue, forKey: .basis)
            try container.encode(state.lastKnown.rawValue, forKey: .lastKnown)
            try container.encode(state.idleFor, forKey: .idleFor)
        case let .speaker(track, start, end, slot, isFinal):
            try container.encode("speaker", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(slot, forKey: .slot)
            try container.encode(isFinal, forKey: .final)
        case let .speakerOff(start, reason):
            try container.encode("speaker-off", forKey: .type)
            try container.encode(start, forKey: .start)
            try container.encode(reason.rawValue, forKey: .reason)
        case let .fileDuration(duration):
            try container.encode("file-duration", forKey: .type)
            try container.encode(duration, forKey: .duration)
        case let .fileAudioTracks(count):
            try container.encode("file-audio-tracks", forKey: .type)
            try container.encode(count, forKey: .count)
        case let .speakerSettled(track, to):
            try container.encode("speaker-settled", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(to, forKey: .to)
        case let .speakerMixed(track, slot, start):
            try container.encode("speaker-mixed", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(slot, forKey: .slot)
            try container.encode(start, forKey: .start)
        case let .speakerCentroid(track, slot, centroid):
            try container.encode("speaker-centroid", forKey: .type)
            try container.encode(track.rawValue, forKey: .track)
            try container.encode(slot, forKey: .slot)
            try container.encode(centroid, forKey: .centroid)
        }
    }
}

/// STT の結果をイベントにする。両トラック・確定/途中のすべてのイベントは、ここで作る。
/// `duplicate` は重複の印。既定は false（判定器を通さない経路と `相手`）。判定は `DuplicateMarker` が行い、呼び出し側（`relay`）が渡す。
/// `words` は本文を語に区切る関数（既定は CFStringTokenizer。unit テストは固定の関数を渡す）。語は確定結果にも途中結果にも載る。
/// `wordTimes` は結果の区間をそのまま載せる。
public func event(
    from result: TranscriptionResult, track: Track, duplicate: Bool = false, words: (String) -> [Word] = transcriptWords
) -> HelperEvent {
    if result.isFinal {
        return .remark(
            track: track, start: result.start, end: result.end, text: result.text, duplicate: duplicate,
            words: words(result.text), wordTimes: result.wordTimes)
    }
    return .partial(
        track: track, start: result.start, end: result.end, text: result.text, duplicate: duplicate,
        words: words(result.text), wordTimes: result.wordTimes)
}

/// 話者の区間をイベントにする。トラックは呼び出し側が決める（話者分離は `相手` にだけ掛ける）。
public func event(from segment: SpeakerSegment, track: Track) -> HelperEvent {
    .speaker(track: track, start: segment.start, end: segment.end, slot: segment.slot, isFinal: segment.isFinal)
}

/// 話者分離が流す 1 件をイベントにする。トラックは呼び出し側が決める（話者分離は `相手` にだけ掛ける）。
public func event(from item: SpeakerDiarization, track: Track) -> HelperEvent {
    switch item {
    case .segment(let segment): return event(from: segment, track: track)
    case .settled(let to): return .speakerSettled(track: track, to: to)
    case .mixed(let slot, let at): return .speakerMixed(track: track, slot: slot, start: at)
    case .centroid(let slot, let centroid): return .speakerCentroid(track: track, slot: slot, centroid: centroid)
    }
}
