import Foundation

/// 話者分離が返す 1 件の区間（Issue #1020）。`start` / `end` は、`diarize` に渡した `origin` を 0 とする秒数で、STT の結果と同じ原点。
/// `slot` は Sortformer の出力の番号（0 始まり）。ラベル（相手 A など）への変換はここではしない。
/// `isFinal` が false なら仮の区間（後で変わり得る）、true なら確定。
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

public enum SpeakerDiarizerError: Error, Equatable, CustomStringConvertible {
    /// モデルのファイルが無い（セットアップの `fetch-speaker-models.sh` が済んでいない）。会議中には取りに行かない。
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

/// 話者分離のアダプタ。配線側はこのプロトコルだけを知る（本物は `SortformerSpeakerDiarizer`、unit テストは偽の実装を入れる）。
public protocol SpeakerDiarizer {
    /// モデルの読み込み。音声を流す前に呼ぶ。ネットワークへは行かない（モデルが無ければ `SpeakerDiarizerError.modelMissing`）。
    func prepare() async throws
    /// 音声バッファの流れを話者の区間の流れにする。`audio` が終わると、残りを確定させてから区間の流れも終わる。
    /// `audio` がエラーで終わった場合や処理に失敗した場合は、区間の流れもそのエラーで終わる。
    /// 区間の `start` / `end` は、ホスト時刻 `origin` を 0 とする秒数。
    func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerSegment, Error>
}
