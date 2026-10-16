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

/// 話者分離が流す 1 件。区間か、確定済みの位置。
public enum SpeakerDiarization: Sendable, Equatable {
    case segment(SpeakerSegment)
    /// この位置（`origin` を 0 とする秒）より前の確定した区間は、すべて流した。値は前に流した値より小さくならない。
    /// 区間の `end` からは「揃った」を判定できない（FluidAudio は確定区間を話者の枠の番号順に流し、閉じた区間だけを確定として流す）ので、
    /// 確定済みの位置はヘルパーが流す。黙っている間も更新ごとに進む。
    case settled(to: Double)
    /// 枠 `slot` に別の声が混ざっていると判定した（Issue #1024）。`at` は判定のもとになった確定区間の終わり（`origin` を 0 とする秒）。
    /// 区間の後、`settled` の前に流す。1 つの枠につき 1 回。
    case mixed(slot: Int, at: Double)
    /// 枠 `slot` の主な塊の声の埋め込みの重心（長さ 1。Issue #1025）。重心が変わった枠だけを流す。値は `origin` に依らない。
    /// 区間の後、`mixed` の前に流す。サーバーが、ヘルパーを起動し直した後の枠を前のラベルにつなぎ直すのに使う（ヘルパーはプロセスをまたぐ状態を持たない）。
    case centroid(slot: Int, centroid: [Float])
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
    /// 音声バッファの流れを話者の区間と確定済みの位置の流れにする。更新ごとに、区間を流した後で確定済みの位置を 1 件流す。
    /// `audio` が終わると、残りを確定させて流し、処理した音声の終わりを確定済みの位置として流してから終わる。
    /// `audio` がエラーで終わった場合や処理に失敗した場合は、流れもそのエラーで終わる。
    /// 区間の `start` / `end` と位置は、ホスト時刻 `origin` を 0 とする秒数。
    func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error>
}
