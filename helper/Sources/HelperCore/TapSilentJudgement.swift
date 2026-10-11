import Foundation

/// タップの無音判定。開始から `tapSilentJudgementDelay` 待ってもフレームが届いていなければ、その時点の機器の状態を 1 行出し、`tap-silent` を 1 回流す。
/// 停止した後、または停止の後に開始した場合は出さない。
public final class TapSilentJudgement: @unchecked Sendable {
    private let sleep: @Sendable (Duration) async throws -> Void
    private let hasReceivedFrames: @Sendable () -> Bool
    private let currentLine: @Sendable () -> String
    private let emit: @Sendable (String) -> Void
    private let now: @Sendable () -> UInt64
    private let emitEvent: @Sendable (HelperEvent) -> Void
    private var origin: UInt64 = 0
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var stopped = false

    /// `sleep` は待ち処理、`hasReceivedFrames` はフレームの到着、`currentLine` は判定時点の値の読み出し、`emit` は出力。
    public init(
        sleep: @escaping @Sendable (Duration) async throws -> Void,
        hasReceivedFrames: @escaping @Sendable () -> Bool,
        currentLine: @escaping @Sendable () -> String,
        emit: @escaping @Sendable (String) -> Void,
        now: @escaping @Sendable () -> UInt64,
        emitEvent: @escaping @Sendable (HelperEvent) -> Void
    ) {
        self.sleep = sleep
        self.hasReceivedFrames = hasReceivedFrames
        self.currentLine = currentLine
        self.emit = emit
        self.now = now
        self.emitEvent = emitEvent
    }

    /// 判定を始める。停止済みなら何もせず nil を返す。`origin` は `tap-silent` の `start` を求める時刻の基準。
    @discardableResult
    public func start(origin: UInt64) -> Task<Void, Never>? {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return nil }
        self.origin = origin
        let task = Task { [self] in
            try? await sleep(tapSilentJudgementDelay)
            judge()
        }
        self.task = task
        return task
    }

    /// 判定を止める。何度呼んでもよい。
    public func stop() {
        lock.lock()
        defer { lock.unlock() }
        stopped = true
        task?.cancel()
    }

    private func judge() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, !Task.isCancelled, !hasReceivedFrames() else { return }
        emit(currentLine())
        emitEvent(.tapSilent(start: offsetSeconds(from: origin, to: now())))
    }
}
