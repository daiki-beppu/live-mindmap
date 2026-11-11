import Foundation

public struct SpeakerSegment: Sendable, Equatable {
    public var start: Double
    public var end: Double
    public var slot: Int
    public var isFinal: Bool

    public init(start: Double, end: Double, slot: Int, isFinal: Bool) {
        self.start = start
        self.end = end
        self.slot = slot
        self.isFinal = isFinal
    }
}

public enum SpeakerDiarization: Sendable, Equatable {
    case segment(SpeakerSegment)
    /// 区間の `end` からは「揃った」を判定できない（FluidAudio は確定区間を話者の枠の番号順に流し、閉じた区間だけを確定として流す）ので、
    /// 確定済みの位置はヘルパーが流す。黙っている間も更新ごとに進む。
    case settled(to: Double)
    case mixed(slot: Int, at: Double)
    case centroid(slot: Int, centroid: [Float])
}

public enum SpeakerDiarizerError: Error, Equatable, CustomStringConvertible {
    case modelMissing(URL)
    case notPrepared
    case conversionFailed(String)

    public var description: String {
        switch self {
        case .modelMissing(let url):
            return "話者分離のモデルが無い: \(url.path)（bash helper/scripts/fetch-speaker-models.sh で取得する）"
        case .notPrepared:
            return "話者分離の prepare が済んでいない"
        case .conversionFailed(let reason):
            return "話者分離の入力を変換できない: \(reason)"
        }
    }
}

public protocol SpeakerDiarizer {
    func prepare() async throws
    func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error>
}
