import Foundation

/// 録画ファイル（`transcribe-file`）の読み手を、サーバーの指示で止める門。
/// 差分更新が利用上限で一時停止している間、サーバーは `reading-pause`（`paused: true`）を送り、ファイルを読み進めさせない。
/// 再開したら `paused: false` を送り、止めた位置の続きから読ませる。読み手は次の入力を読む前に `waitOpen()` を通る。
/// 同じ状態の指示を重ねても結果は同じ（状態を指定する指示）。2 本の読み手と映像の読みは同じ門を共有する。
public actor FileReadingGate {
    private var paused = false
    private var stopped = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    public init() {}

    /// いま止められているか（指示が門に反映されたことの確認に使う）。
    public var isPaused: Bool { paused }

    /// 読み進めさせない。
    public func pause() {
        paused = true
    }

    /// 止めを解き、待っていた読み手をすべて通す。
    public func resume() {
        paused = false
        let released = waiters
        waiters = [:]
        for (_, waiter) in released { waiter.resume() }
    }

    /// 以後、門を通ろうとする読み手と、待っている読み手を `CancellationError` で終わらせる（プロセスを止めるとき）。
    public func stop() {
        stopped = true
        let released = waiters
        waiters = [:]
        for (_, waiter) in released { waiter.resume(throwing: CancellationError()) }
    }

    /// 止められていなければ、すぐ戻る。止められていれば、止めが解けるまで待つ。待っている間にキャンセルされたら `CancellationError` を投げる。
    public func waitOpen() async throws {
        let id = UUID()
        while paused || stopped {
            try Task.checkCancellation()
            if stopped { throw CancellationError() }
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        waiters[id] = continuation
                    }
                }
            } onCancel: {
                Task { await self.cancelWaiter(id) }
            }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    /// サーバーからの指示（`{"type":"reading-pause","paused":boolean,"token":string}`）が求める状態。
    /// 読み取りの規則は self-pause の指示と同じ（壊れた JSON・知らない type・`paused` が真偽値でない指示・`token` が一致しない指示は nil。`token` が空のときは何も受け付けない）。
    public static func requestedState(in message: String, token: String) -> Bool? {
        SelfPause.instructedState(in: message, type: "reading-pause", token: token)
    }
}

/// サーバーからの指示を順に読み、認証できた `reading-pause` の求める状態を `gate` に反映する。`messages` が終わると戻る。
public func serveFileReadingRequests<Messages: AsyncSequence>(
    _ messages: Messages, token: String, gate: FileReadingGate
) async where Messages.Element == String {
    do {
        for try await message in messages {
            guard let paused = FileReadingGate.requestedState(in: message, token: token) else { continue }
            if paused { await gate.pause() } else { await gate.resume() }
        }
    } catch {}
}
