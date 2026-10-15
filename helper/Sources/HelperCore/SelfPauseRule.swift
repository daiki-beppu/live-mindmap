import Foundation

// Issue #1071: 会議アプリのマイクの使用（Core Audio の IsRunningInput）と手動の指示を組み合わせて、`自分` の休止を決める純粋な規則。
// 規則は仕様 #1065 の Formal Spec（selfPause）のとおり。Core Audio は読まず、タイマーも持たない（時刻は引数で受ける）。

/// 会議アプリがマイクを使っているかの判定。
public enum InputJudgement: String, Sendable, Equatable {
    case using
    case idle
    case unknown
}

/// 手で選んだ状態。`pause` は休止、`take` は取る（再開）。
public enum SelfPauseManual: String, Sendable, Equatable {
    case none
    case pause
    case take
}

/// 休止の状態の理由。値はサーバーの `SelfPauseReason`（server/src/core/selfPause.ts）と同じ文字列。
public enum SelfPauseReason: String, Sendable, Equatable {
    case manual = "手動"
    case automatic = "自動"
    case undetermined = "判定できない"
}

/// Core Audio のプロセス 1 件の、入力の使用の読み取り結果。`isRunningInput` が nil なら値が読めなかった。
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

/// 規則が報告する休止の変化。
public struct SelfPauseChange: Sendable, Equatable {
    public var paused: Bool
    public var reason: SelfPauseReason

    public init(paused: Bool, reason: SelfPauseReason) {
        self.paused = paused
        self.reason = reason
    }
}

/// helper を起動し直すときに引き継ぐ状態（手動・基準・最後に読めた値・待ちの進み具合）。
public struct SelfPauseCarryOver: Sendable, Equatable {
    public var manual: SelfPauseManual
    /// 手動の基準。手で選んだ時点の判定（`unknown` なら最初に読めた値を基準にする）。
    public var basis: InputJudgement
    public var lastKnown: InputJudgement
    /// 「使っていない」が続いた秒数（待ちで頭打ち）。
    public var idleFor: Double

    public init(manual: SelfPauseManual, basis: InputJudgement, lastKnown: InputJudgement, idleFor: Double) {
        self.manual = manual
        self.basis = basis
        self.lastKnown = lastKnown
        self.idleFor = idleFor
    }

    public static let initial = SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .unknown, idleFor: 0)
}

/// `--app` に当たるプロセス（自分の pid を除く）のうち、どれか 1 つが入力を使っていれば using。
/// 当たるプロセスが無い・一覧が読めない・読めない対象があって using が無いときは unknown。
public func judgeInput(processes: [InputProcess]?, app: String, ownPID: Int32) -> InputJudgement {
    guard let processes else { return .unknown }
    let targets = processes.filter { belongs($0.bundleID, toApp: app) && $0.pid != ownPID }
    guard !targets.isEmpty else { return .unknown }
    if targets.contains(where: { $0.isRunningInput == true }) { return .using }
    if targets.contains(where: { $0.isRunningInput == nil }) { return .unknown }
    return .idle
}

public struct SelfPauseRule: Sendable {
    /// 取る → 休止に入るまでの、「使っていない」が続く秒数。
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

    public var paused: Bool { manual == .none ? autoPaused : manual == .pause }

    public var reason: SelfPauseReason {
        if manual != .none { return .manual }
        return judgement == .unknown ? .undetermined : .automatic
    }

    public var carryOver: SelfPauseCarryOver {
        SelfPauseCarryOver(manual: manual, basis: basis, lastKnown: lastKnown, idleFor: idleFor)
    }

    /// 手で選んだ状態が自動の結論と同じなら外す。「分からない」の間は比べない。
    private func normalized(_ manual: SelfPauseManual, judgement: InputJudgement, idleFor: Double) -> SelfPauseManual {
        guard manual != .none, judgement != .unknown else { return manual }
        let auto = judgement == .idle && idleFor >= wait
        return (manual == .pause) == auto ? .none : manual
    }

    /// 前の入力から `time` まで時間が進んだ（Formal Spec の tick）。
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

    /// 報告するのは、`paused` が変わったときと、休止中に理由だけが変わったときだけ。
    private func change(from before: (paused: Bool, reason: SelfPauseReason)) -> SelfPauseChange? {
        guard paused != before.paused || (paused && reason != before.reason) else { return nil }
        return SelfPauseChange(paused: paused, reason: reason)
    }

    /// プロセスの一覧（nil は読めなかった）を `time`（秒）に読んだ。
    public mutating func read(_ processes: [InputProcess]?, at time: Double) -> SelfPauseChange? {
        let before = (paused: paused, reason: reason)
        advance(to: time)
        let value = judgeInput(processes: processes, app: app, ownPID: ownPID)
        let released = manual != .none && value != .unknown && basis != .unknown && value != basis
        let newBasis = (manual != .none && basis == .unknown && value != .unknown) ? value : basis
        // 「分からない」をはさんでも、前に読めた値が「使っていない」なら待ちをやり直さない
        let previous = judgement == .unknown ? lastKnown : judgement
        let carried = (value == .idle && previous == .idle) || value == .unknown ? idleFor : 0
        // 手動の休止がマイクを閉じたことで外れたら、待たずに休止を続ける
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

    /// 手動の指示（状態を指定する）を `time`（秒）に受けた。今と同じ状態の指示は何も変えない。
    /// 押した時点の自動の結論と同じ指示は、手動にしない。
    public mutating func press(paused wantsPause: Bool, at time: Double) -> SelfPauseChange? {
        let before = (paused: paused, reason: reason)
        advance(to: time)
        guard wantsPause != paused else { return change(from: before) }
        manual = wantsPause == autoPaused ? .none : (wantsPause ? .pause : .take)
        basis = manual == .none ? .unknown : judgement
        guard paused != before.paused else { return change(from: before) }
        return SelfPauseChange(paused: paused, reason: .manual)
    }
}
