import Foundation

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
