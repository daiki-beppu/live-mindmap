import Foundation

public enum InputJudgement: String, Sendable, Equatable, CaseIterable {
    case using
    case idle
    case unknown
}

public enum SelfPauseManual: String, Sendable, Equatable, CaseIterable {
    case none
    case pause
    case take
}

public enum SelfPauseReason: String, Sendable, Equatable, CaseIterable {
    case manual = "手動"
    case automatic = "自動"
    case undetermined = "判定できない"
}

public struct InputProcess: Sendable, Equatable {
    public var bundleID: String
    public var pid: Int32
    public var isRunningInput: Bool?

    public init(bundleID: String, pid: Int32, isRunningInput: Bool?) {
        self.bundleID = bundleID
        self.pid = pid
        self.isRunningInput = isRunningInput
    }
}

public enum PausedReason: String, Sendable, Equatable, CaseIterable {
    case manual = "手動"
    case automatic = "自動"
}

public enum SelfPauseChange: Sendable, Equatable {
    case paused(PausedReason)
    case resumed(SelfPauseReason)

    public var paused: Bool {
        switch self {
        case .paused: return true
        case .resumed: return false
        }
    }

    public var reason: SelfPauseReason {
        switch self {
        case .paused(.manual): return .manual
        case .paused(.automatic): return .automatic
        case .resumed(let reason): return reason
        }
    }
}

public struct SelfPauseCarryOver: Sendable, Equatable {
    public var manual: SelfPauseManual
    public var basis: InputJudgement
    public var lastKnown: InputJudgement
    public var idleFor: Double

    public init(manual: SelfPauseManual, basis: InputJudgement, lastKnown: InputJudgement, idleFor: Double) {
        self.manual = manual
        self.basis = basis
        self.lastKnown = lastKnown
        self.idleFor = idleFor
    }

    public static let initial = SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .unknown, idleFor: 0)
}

public func judgeInput(processes: [InputProcess]?, app: String, ownPID: Int32) -> InputJudgement {
    guard let processes else { return .unknown }
    let targets = processes.filter { belongs($0.bundleID, toApp: app) && $0.pid != ownPID }
    guard !targets.isEmpty else { return .unknown }
    if targets.contains(where: { $0.isRunningInput == true }) { return .using }
    if targets.contains(where: { $0.isRunningInput == nil }) { return .unknown }
    return .idle
}

public struct SelfPauseRule: Sendable {
    public static let defaultWait: Double = 3

    private let app: String
    private let ownPID: Int32
    private let wait: Double
    private(set) var judgement: InputJudgement = .unknown
    private var lastKnown: InputJudgement
    private var idleFor: Double
    private var manual: SelfPauseManual
    private var basis: InputJudgement
    private var lastTime: Double?

    public init(app: String, ownPID: Int32, wait: Double = SelfPauseRule.defaultWait, restoring: SelfPauseCarryOver = .initial) {
        self.app = app
        self.ownPID = ownPID
        self.wait = wait
        self.lastKnown = restoring.lastKnown
        self.idleFor = restoring.idleFor
        self.manual = restoring.manual
        self.basis = restoring.basis
    }

    private var autoPaused: Bool { judgement == .idle && idleFor >= wait }

    public var state: SelfPauseChange {
        switch manual {
        case .pause: return .paused(.manual)
        case .take: return .resumed(.manual)
        case .none:
            if autoPaused { return .paused(.automatic) }
            return .resumed(judgement == .unknown ? .undetermined : .automatic)
        }
    }

    public var paused: Bool { state.paused }

    public var reason: SelfPauseReason { state.reason }

    public var carryOver: SelfPauseCarryOver {
        SelfPauseCarryOver(manual: manual, basis: basis, lastKnown: lastKnown, idleFor: idleFor)
    }

    private func normalized(_ manual: SelfPauseManual, judgement: InputJudgement, idleFor: Double) -> SelfPauseManual {
        guard manual != .none, judgement != .unknown else { return manual }
        let auto = judgement == .idle && idleFor >= wait
        return (manual == .pause) == auto ? .none : manual
    }

    private mutating func advance(to time: Double) {
        defer { lastTime = lastTime.map { max($0, time) } ?? time }
        guard let last = lastTime else { return }
        let elapsed = max(0, time - last)
        switch judgement {
        case .idle: idleFor = min(wait, idleFor + elapsed)
        case .using: idleFor = 0
        case .unknown: break
        }
        manual = normalized(manual, judgement: judgement, idleFor: idleFor)
        if manual == .none { basis = .unknown }
    }

    private func change(from before: SelfPauseChange) -> SelfPauseChange? {
        guard paused != before.paused || (paused && reason != before.reason) else { return nil }
        return state
    }

    public mutating func read(_ processes: [InputProcess]?, at time: Double) -> SelfPauseChange? {
        let before = state
        advance(to: time)
        let value = judgeInput(processes: processes, app: app, ownPID: ownPID)
        let released = manual != .none && value != .unknown && basis != .unknown && value != basis
        let newBasis = (manual != .none && basis == .unknown && value != .unknown) ? value : basis
        let previous = judgement == .unknown ? lastKnown : judgement
        let carried = (value == .idle && previous == .idle) || value == .unknown ? idleFor : 0
        let progress = (released && manual == .pause && value == .idle) ? wait : carried
        let remaining = released ? SelfPauseManual.none : manual
        let next = normalized(remaining, judgement: value, idleFor: progress)
        judgement = value
        if value != .unknown { lastKnown = value }
        idleFor = progress
        manual = next
        basis = next == .none ? .unknown : newBasis
        return change(from: before)
    }

    public mutating func press(paused wantsPause: Bool, at time: Double) -> SelfPauseChange? {
        let before = state
        advance(to: time)
        guard wantsPause != paused else { return change(from: before) }
        manual = wantsPause == autoPaused ? .none : (wantsPause ? .pause : .take)
        basis = manual == .none ? .unknown : judgement
        guard paused != before.paused else { return change(from: before) }
        return paused ? .paused(.manual) : .resumed(.manual)
    }
}
