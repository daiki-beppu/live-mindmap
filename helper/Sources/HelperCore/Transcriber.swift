import AVFoundation

/// STT のアダプタ。配線側はこのプロトコルだけを知る（ADR 0002: 差し替えてもイベントの形は変えない）。
public protocol Transcriber {
    /// 認識に必要な準備（モデルの取得など）。音声を流す前に呼ぶ。
    func prepare() async throws
    /// 音声バッファの流れを文字起こしする。`audio` が終わると、残りを確定して結果の流れも終わる。`audio` がエラーで終わった場合は、結果の流れもそのエラーで終わる。
    /// 結果の `start` / `end` は、ホスト時刻 `origin` を 0 とする秒数。インスタンスごとに 1 回だけ呼べる。
    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error>
}
