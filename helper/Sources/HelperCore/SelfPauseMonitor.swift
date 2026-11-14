import Foundation

public final class SelfPauseMonitor: @unchecked Sendable {
    static let pollInterval = Duration.milliseconds(500)

    private enum Input: Sendable {
        case read
        case press(SelfPausePress)
    }

    private let origin: UInt64
    private let readProcesses: @Sendable () -> [InputProcess]?
    private let sleep: @Sendable (Duration) async throws -> Void
    private let now: @Sendable () -> UInt64
    private let requestGate: @Sendable (Bool, UInt64) -> Void
    private let emit: @Sendable (HelperEvent) async -> Void
    private let inputs: AsyncStream<Input>
    private let continuation: AsyncStream<Input>.Continuation
    private var rule: SelfPauseRule
    private var gated: Bool
    private var announced: SelfPauseCarryOver
    private var handled = SelfPauseSeq.none

    public init(
        rule: SelfPauseRule,
        origin: UInt64,
        readProcesses: @escaping @Sendable () -> [InputProcess]?,
        sleep: @escaping @Sendable (Duration) async throws -> Void,
        now: @escaping @Sendable () -> UInt64,
        requestGate: @escaping @Sendable (Bool, UInt64) -> Void,
        emit: @escaping @Sendable (HelperEvent) async -> Void
    ) {
        self.rule = rule
        self.origin = origin
        self.readProcesses = readProcesses
        self.sleep = sleep
        self.now = now
        self.requestGate = requestGate
        self.emit = emit
        self.gated = rule.paused
        self.announced = rule.carryOver
        (inputs, continuation) = AsyncStream.makeStream(of: Input.self)
    }

    public func start() -> Task<Void, Never> {
        continuation.yield(.read)
        let sleep = sleep
        let continuation = continuation
        let poll = Task {
            while !Task.isCancelled {
                do { try await sleep(Self.pollInterval) } catch { return }
                continuation.yield(.read)
            }
        }
        return Task { [self] in
            for await input in inputs { await handle(input) }
            poll.cancel()
        }
    }

    public func stop() { continuation.finish() }

    public func requestRead() { continuation.yield(.read) }

    public func press(_ press: SelfPausePress) { continuation.yield(.press(press)) }

    private func handle(_ input: Input) async {
        let hostTime = now()
        let seconds = offsetSeconds(from: origin, to: hostTime)
        let change: SelfPauseChange?
        let pressed: Bool
        switch input {
        case .read:
            change = rule.read(readProcesses(), at: seconds)
            pressed = false
        case let .press(press):
            change = rule.press(paused: press.paused, at: seconds)
            handled = press.seq
            pressed = true
        }
        if let change {
            if change.paused != gated {
                gated = change.paused
                requestGate(change.paused, hostTime)
            }
            await emit(.selfPause(change, start: seconds))
        }
        let state = rule.carryOver
        // サーバーは handled を見て、送り直すのをやめる。状態を変えない指示にも返さないと、送り直しが止まらない。
        if pressed || state != announced {
            announced = state
            await emit(.selfPauseState(state, handled: handled))
        }
    }
}
