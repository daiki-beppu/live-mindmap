import Foundation

public enum Track: String, Sendable, Equatable {
    case 自分
    case 相手
}

public struct TranscriptionResult: Sendable, Equatable {
    public var text: String
    public var isFinal: Bool
    public var start: Double
    public var end: Double
    public var wordTimes: [WordTime]

    public init(text: String, isFinal: Bool, start: Double, end: Double, wordTimes: [WordTime] = []) {
        self.text = text
        self.isFinal = isFinal
        self.start = start
        self.end = end
        self.wordTimes = wordTimes
    }
}

public enum ScreenOffReason: String, Sendable, Equatable {
    case 許可なし
}

public enum SpeakerOffReason: String, Sendable, Equatable {
    case モデルなし
    case 読み込みに失敗
    case 途中で停止
}

enum HelperEventRetentionSlot: CaseIterable, Sendable {
    case origin, screen, screenOff, tapSilent, selfPause, selfPauseState, speakerOff, fileDuration, fileAudioTracks
}

enum HelperEventDelivery: Equatable, Sendable {
    case retain(HelperEventRetentionSlot)
    case bufferUntilFirstClient
    case connectedOnly
}

public enum HelperEvent: Sendable, Equatable {
    case remark(track: Track, start: Double, end: Double, text: String, duplicate: Bool, words: [Word], wordTimes: [WordTime])
    case partial(track: Track, start: Double, end: Double, text: String, duplicate: Bool, words: [Word], wordTimes: [WordTime])
    case origin(hostTime: UInt64)
    case screen(start: Double, image: String?, lines: [String]?, ocrFailed: Bool = false, meetingTabTitle: String? = nil)
    case screenOff(start: Double, reason: ScreenOffReason)
    case tapSilent(start: Double)
    case selfPause(paused: Bool, reason: SelfPauseReason, start: Double)
    case selfPauseState(SelfPauseCarryOver)
    case speaker(track: Track, start: Double, end: Double, slot: Int, isFinal: Bool)
    case speakerOff(start: Double, reason: SpeakerOffReason)
    case fileDuration(duration: Double)
    case fileAudioTracks(count: Int)
    case speakerSettled(track: Track, to: Double)
    /// `相手` の話者の枠 `slot` に、別の声が混ざっている（Issue #1024）。Nemotron 3 の枠は 8 つで、同じ枠に別の声が混ざることがある。
    case speakerMixed(track: Track, slot: Int, start: Double)
    case speakerCentroid(track: Track, slot: Int, centroid: [Float])

    func delivery(retained: HelperEvent?) -> HelperEventDelivery {
        switch self {
        case .origin: return .retain(.origin)
        case let .screen(start, _, _, _, _):
            if case let .screen(previousStart, _, _, _, _) = retained, start < previousStart {
                return .connectedOnly
            }
            return .retain(.screen)
        case .screenOff: return .retain(.screenOff)
        case .tapSilent: return .retain(.tapSilent)
        case .selfPause: return .retain(.selfPause)
        case .selfPauseState: return .retain(.selfPauseState)
        case .speakerOff: return .retain(.speakerOff)
        case .fileDuration: return .retain(.fileDuration)
        case .fileAudioTracks: return .retain(.fileAudioTracks)
        case .remark, .partial, .speaker, .speakerSettled, .speakerMixed, .speakerCentroid:
            return .bufferUntilFirstClient
        }
    }

    public func jsonString() throws -> String {
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
        case ocrFailed
        case manual, basis, lastKnown, idleFor, centroid, meetingTabTitle
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
        case let .screen(start, image, lines, ocrFailed, meetingTabTitle):
            try container.encode("screen", forKey: .type)
            try container.encode(start, forKey: .start)
            if let image {
                try container.encode(image, forKey: .image)
            } else {
                try container.encodeNil(forKey: .image)
            }
            if image != nil {
                if ocrFailed {
                    try container.encode(true, forKey: .ocrFailed)
                } else if let lines {
                    try container.encode(lines, forKey: .lines)
                }
            }
            try container.encodeIfPresent(meetingTabTitle, forKey: .meetingTabTitle)
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

public func event(from segment: SpeakerSegment, track: Track) -> HelperEvent {
    .speaker(track: track, start: segment.start, end: segment.end, slot: segment.slot, isFinal: segment.isFinal)
}

public func event(from item: SpeakerDiarization, track: Track) -> HelperEvent {
    switch item {
    case .segment(let segment): return event(from: segment, track: track)
    case .settled(let to): return .speakerSettled(track: track, to: to)
    case .mixed(let slot, let at): return .speakerMixed(track: track, slot: slot, start: at)
    case .centroid(let slot, let centroid): return .speakerCentroid(track: track, slot: slot, centroid: centroid)
    }
}
