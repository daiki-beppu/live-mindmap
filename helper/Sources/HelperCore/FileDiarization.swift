import AVFoundation
import CoreAudio
import Foundation

// 録画のファイルの `相手` を話者分離にかける経路（Issue #1094。`transcribe-file` / `cli recorded`）。
// 読み手は 1 つで、同じ音声を STT と話者分離の両方へ流す。読む速さは遅いほう（話者分離）が受け取れる速さに抑える。
// STT は引いたぶんだけ読む（`FileAudioInputs`）ので、読み手が話者分離へ渡すところで待てば、両方の速さが揃う。
// 間に上限つきの列を置く分け方（`split`）では、読み手が先へ進んでしまうので使わない。
// 話者分離が使えない・途中で止まったときは `release()` で抑えを外し、STT の速さで読み続ける。

/// 読み手が話者分離へ音声を渡す口。`send` は、話者分離が引き取るまで待つ。
public actor FileDiarizationFeed {
    private var slot: CapturedAudio?
    private var finished = false
    private var released = false
    private var lastEnd = 0.0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    /// 最後に話者分離へ渡した音声の終わりの位置（ファイルの先頭からの秒）。
    public var position: Double { lastEnd }

    /// 話者分離へ渡す音声の流れ。話者分離が引くたびに、読み手が `send` した次の音声を返す。
    nonisolated func stream() -> AsyncThrowingStream<CapturedAudio, Error> {
        AsyncThrowingStream(unfolding: { try await self.next() })
    }

    /// 音声を、ファイル上の位置 `start`（先頭からの秒）の時刻で渡し、話者分離が引き取るまで待つ。`release` の後は、渡さずにすぐ戻る。
    /// 渡す音声は複製する（Issue #160。STT と話者分離が同じ `AVAudioPCMBuffer` を共有しない）。
    func send(buffer: AVAudioPCMBuffer, start: Double) async throws {
        while slot != nil, !released { try await waitForChange() }
        if released || finished { return }
        let nanos = UInt64((max(0, start) * 1_000_000_000).rounded())
        slot = copyCaptured(CapturedAudio(buffer: buffer, hostTime: AudioConvertNanosToHostTime(nanos)))
        lastEnd = start + Double(buffer.frameLength) / buffer.format.sampleRate
        wake()
        while slot != nil, !released { try await waitForChange() }
    }

    /// 読み終えた（失敗・取り消しを含む）。話者分離は、渡された分を処理して終わる。
    func finish() {
        finished = true
        wake()
    }

    /// 抑えを外す。以後の `send` は待たずに戻り、音声を渡さない。話者分離の側が終わるときに呼ぶ。
    func release() {
        released = true
        slot = nil
        wake()
    }

    private func next() async throws -> CapturedAudio? {
        while true {
            if let audio = slot {
                slot = nil
                wake()
                return audio
            }
            if finished || released { return nil }
            try await waitForChange()
        }
    }

    /// 状態の変化を 1 回待つ。キャンセルされたら起こされ、`CancellationError` を投げる（`FileReadingAlignment` と同じ形）。
    private func waitForChange() async throws {
        try Task.checkCancellation()
        await withTaskCancellationHandler {
            await withCheckedContinuation { waiters.append($0) }
        } onCancel: {
            Task { await self.wake() }
        }
        try Task.checkCancellation()
    }

    private func wake() {
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }
}

/// 録画の `相手` にかける話者分離。`prepare` で使えるかを決め、使えるなら `run` が話者分離を走らせて結果を `emit` へ流す。
/// 使えないとき（準備の失敗）は、`prepare` が `speaker-off` を流し、`feed` は nil（読み手は抑えられない）。
public final class FileDiarization: @unchecked Sendable {
    /// 読み手が音声を渡す口。話者分離が使えないときは nil。
    public let feed: FileDiarizationFeed?
    private let diarizer: (any SpeakerDiarizer)?
    private let emit: @Sendable (HelperEvent) async -> Void

    private init(feed: FileDiarizationFeed?, diarizer: (any SpeakerDiarizer)?, emit: @escaping @Sendable (HelperEvent) async -> Void) {
        self.feed = feed
        self.diarizer = diarizer
        self.emit = emit
    }

    /// 話者分離を準備する。使えなければ、読み始める位置 `from`（ファイルの秒）の `speaker-off` を流す。
    public static func prepare(
        _ diarizer: any SpeakerDiarizer, from: Double, emit: @escaping @Sendable (HelperEvent) async -> Void
    ) async -> FileDiarization {
        do {
            try await diarizer.prepare()
            return FileDiarization(feed: FileDiarizationFeed(), diarizer: diarizer, emit: emit)
        } catch {
            let reason = speakerOffReason(for: error)
            printDiarizationError("使えない（認識は続ける）: \(error)")
            await emit(.speakerOff(start: from, reason: reason))
            return FileDiarization(feed: nil, diarizer: nil, emit: emit)
        }
    }

    /// 話者分離を走らせ、区間と確定済みの位置を `相手` のイベントとして流す。読み手が音声を渡し終えて（`settled` まで）流し切ると戻る。
    /// 始められない・途中で止まったときは `speaker-off` を流す。どの終わり方でも抑えを外す。使えないときは何もせず戻る。
    public func run() async {
        guard let feed, let diarizer else { return }
        do {
            let segments = try await diarizer.diarize(feed.stream(), origin: 0)
            do {
                for try await item in segments { await emit(event(from: item, track: .相手)) }
            } catch {
                if !Task.isCancelled {
                    printDiarizationError("途中で停止（認識は続ける）: \(error)")
                    await emit(.speakerOff(start: await feed.position, reason: .途中で停止))
                }
            }
        } catch {
            printDiarizationError("開始できない（認識は続ける）: \(error)")
            await emit(.speakerOff(start: await feed.position, reason: .読み込みに失敗))
        }
        await feed.release()
    }

    /// 文字起こし `transcription` と話者分離 `run()` を並べて動かす。両方が終わる（話者分離が最後の区間と `settled` を流し切る）まで待つ。
    /// 文字起こしが入力を引く前に失敗すると、話者分離は入力待ちのままになる。その待ちは取り消しでしか解けない。
    public func run(alongside transcription: @escaping @Sendable () async throws -> Void) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { await self.run() }
            group.addTask { try await transcription() }
            // 最初の失敗でグループを抜ける（残りの子タスクは取り消される。`waitForAll()` は失敗後も残りの完了を待つので使わない）
            for try await _ in group {}
        }
    }
}

/// 話者分離が使えない理由の分類（ライブの `RunAudio.prepare` と同じ規則）。
func speakerOffReason(for error: Error) -> SpeakerOffReason {
    if case SpeakerDiarizerError.modelMissing = error { return .モデルなし }
    return .読み込みに失敗
}

private func printDiarizationError(_ message: String) {
    FileHandle.standardError.write(Data("speaker diarization: \(message)\n".utf8))
}
