import Foundation

/// 会議アプリのマイクの使用を読み直し（通知のきっかけ・0.5 秒ごとのポーリング）、手動の指示と合わせて `SelfPauseRule` へ渡し、
/// 休止の変化を音のゲートとイベントへ届ける（Issue #1071）。読み直しと指示は 1 本の流れにまとめ、1 つの Task が順に処理する。
/// Core Audio の読み取り・待ち・時計・出力は外から渡す（テストでは偽物に置き換える）。
public final class SelfPauseMonitor: @unchecked Sendable {
    /// ポーリングの間隔。通知を取りこぼしても、この間隔で読み直す。
    static let pollInterval = Duration.milliseconds(500)

    private enum Input: Sendable {
        case read
        case press(Bool)
    }

    private let origin: UInt64
    private let readProcesses: @Sendable () -> [InputProcess]?
    private let sleep: @Sendable (Duration) async throws -> Void
    private let now: @Sendable () -> UInt64
    private let requestGate: @Sendable (Bool, UInt64) -> Void
    private let emit: @Sendable (HelperEvent) async -> Void
    private let inputs: AsyncStream<Input>
    private let continuation: AsyncStream<Input>.Continuation
    // 以下は処理の Task だけが触る
    private var rule: SelfPauseRule
    private var gated: Bool
    private var announced: SelfPauseCarryOver

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

    /// 始めに 1 回読み、以後はポーリングと `requestRead`・`press` で処理する。`stop` で戻る。
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

    /// 機器・プロセス一覧の変化の通知から呼ぶ。ポーリングを待たずに読み直す。
    public func requestRead() { continuation.yield(.read) }

    /// 手動の指示（休止の状態を指定する）。
    public func press(paused: Bool) { continuation.yield(.press(paused)) }

    private func handle(_ input: Input) async {
        let hostTime = now()
        let seconds = offsetSeconds(from: origin, to: hostTime)
        let change: SelfPauseChange?
        switch input {
        case .read: change = rule.read(readProcesses(), at: seconds)
        case let .press(paused): change = rule.press(paused: paused, at: seconds)
        }
        if let change {
            if change.paused != gated {
                gated = change.paused
                requestGate(change.paused, hostTime)
            }
            await emit(.selfPause(paused: change.paused, reason: change.reason, start: seconds))
        }
        let state = rule.carryOver
        if state != announced {
            announced = state
            await emit(.selfPauseState(state))
        }
    }
}
