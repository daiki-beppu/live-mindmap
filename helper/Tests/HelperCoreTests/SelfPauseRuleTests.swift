import Testing
@testable import HelperCore

// Issue #1071: 会議アプリのマイクの使用（Core Audio の IsRunningInput）と手動の指示を組み合わせて `自分` の休止を決める純粋な部品。
// 規則は仕様 #1065 の Formal Spec（selfPause）のとおり。刻み 1 は 1 秒、待ち（WAIT）は 2 秒に置き換えて確かめる。

private let app = "com.google.Chrome"
private let me: Int32 = 100

private func proc(_ bundleID: String, pid: Int32 = 200, input: Bool?) -> InputProcess {
    InputProcess(bundleID: bundleID, pid: pid, isRunningInput: input)
}

private func makeRule(wait: Double = 2, restoring: SelfPauseCarryOver = .initial) -> SelfPauseRule {
    SelfPauseRule(app: app, ownPID: me, wait: wait, restoring: restoring)
}

private let using = [proc(app, input: true)]
private let idle = [proc(app, input: false)]

@Suite("自分の休止の規則: 判定")
struct InputJudgementTests {
    @Test("--app の helper プロセスが入力を使っていれば using")
    func helperOfAppIsUsing() {
        #expect(judgeInput(processes: [proc("com.google.Chrome.helper", input: true)], app: app, ownPID: me) == .using)
    }

    @Test("接頭辞は . の境界で判定する。ChromeCanary は対象外で、本体が false なら idle。自分の pid の helper は除く")
    func prefixBoundaryAndOwnPID() {
        let processes = [
            proc("com.google.ChromeCanary", pid: 201, input: true),
            proc("com.google.Chrome", pid: 202, input: false),
            proc("com.google.Chrome.helper", pid: me, input: true),
        ]
        #expect(judgeInput(processes: processes, app: app, ownPID: me) == .idle)
    }

    @Test("自分の pid のプロセスだけが using のときは、対象が 0 件なので unknown")
    func onlyOwnPIDIsUnknown() {
        #expect(judgeInput(processes: [proc(app, pid: me, input: true)], app: app, ownPID: me) == .unknown)
    }

    @Test("対象のプロセスが一覧に無い・一覧が空・一覧が読めないときは unknown")
    func missingProcessesAreUnknown() {
        #expect(judgeInput(processes: [], app: app, ownPID: me) == .unknown)
        #expect(judgeInput(processes: [proc("com.apple.Safari", input: true)], app: app, ownPID: me) == .unknown)
        #expect(judgeInput(processes: nil, app: app, ownPID: me) == .unknown)
    }

    @Test("読めない対象が 1 件でもあって using が無ければ unknown。全部 false なら idle")
    func unreadableWithoutUsingIsUnknown() {
        #expect(judgeInput(processes: [proc(app, pid: 1, input: false), proc(app + ".helper", pid: 2, input: nil)], app: app, ownPID: me) == .unknown)
        #expect(judgeInput(processes: [proc(app, pid: 1, input: false), proc(app + ".helper", pid: 2, input: false)], app: app, ownPID: me) == .idle)
    }

    @Test("1 件でも true があれば、読めない対象があっても using")
    func anyTrueIsUsing() {
        #expect(judgeInput(processes: [proc(app, pid: 1, input: nil), proc(app + ".helper", pid: 2, input: true)], app: app, ownPID: me) == .using)
    }
}

@Suite("自分の休止の規則: 自動")
struct SelfPauseAutomaticTests {
    @Test("始めは休止していない。読めるまでは「判定できない」")
    func startsTaking() {
        let rule = makeRule()
        #expect(rule.paused == false)
        #expect(rule.judgement == .unknown)
        #expect(rule.carryOver == .initial)
    }

    @Test("使っていない状態が待ち（2 秒）続くと自動で休止し、使い始めるとその読み取りで取る。同じインスタンスで続けて観測する")
    func idleForWaitPausesThenUsingTakesImmediately() {
        var rule = makeRule()
        #expect(rule.read(idle, at: 0) == nil)
        #expect(rule.read(idle, at: 1) == nil)
        #expect(rule.paused == false)
        #expect(rule.read(idle, at: 2) == SelfPauseChange(paused: true, reason: .automatic))
        #expect(rule.paused == true)
        #expect(rule.read(idle, at: 3) == nil)
        #expect(rule.read(using, at: 3.5) == SelfPauseChange(paused: false, reason: .automatic))
        #expect(rule.paused == false)
        // もう一度閉じても、待ちは最初からやり直す
        #expect(rule.read(idle, at: 4) == nil)
        #expect(rule.read(idle, at: 5) == nil)
        #expect(rule.read(idle, at: 6) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("読み取りの間隔が待ちより長くても、経過時間の分だけ待ちが進む（0.5 秒ごとの読み取りに限らない）")
    func elapsedTimeAdvancesWait() {
        var rule = makeRule(wait: 3)
        #expect(rule.read(idle, at: 10) == nil)
        #expect(rule.read(idle, at: 20) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("既定の待ちは 3 秒")
    func defaultWaitIsThreeSeconds() {
        #expect(SelfPauseRule.defaultWait == 3)
        var rule = SelfPauseRule(app: app, ownPID: me)
        _ = rule.read(idle, at: 0)
        #expect(rule.read(idle, at: 2.9) == nil)
        #expect(rule.read(idle, at: 3) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("会議アプリが一瞬だけマイクを閉じても休止しない（待ちの途中で using に戻る）")
    func briefIdleDoesNotPause() {
        var rule = makeRule(wait: 3)
        _ = rule.read(using, at: 0)
        #expect(rule.read(idle, at: 1) == nil)
        #expect(rule.read(idle, at: 2.5) == nil)
        #expect(rule.read(using, at: 3) == nil)
        #expect(rule.paused == false)
        // using に戻った後、再び閉じると待ちは 0 から。直前の 2.5 秒は持ち越さない
        #expect(rule.read(idle, at: 3.5) == nil)
        #expect(rule.read(idle, at: 5) == nil)
        #expect(rule.paused == false)
        #expect(rule.read(idle, at: 6.5) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("「分からない」の間はすぐ取り、理由は「判定できない」。読めない一瞬をはさんで同じ「使っていない」に戻ったら待ちをやり直さない")
    func unknownTakesButKeepsIdleProgress() {
        var rule = makeRule(wait: 3)
        _ = rule.read(idle, at: 0)
        _ = rule.read(idle, at: 2)
        // 読めない（待ちの途中）。休止していないので変化なし
        #expect(rule.read(nil, at: 2.5) == nil)
        #expect(rule.read(nil, at: 10) == nil)  // 分からない間は待ちが進まない
        #expect(rule.paused == false)
        // 同じ「使っていない」に戻ると、待ちの進み（2.5 秒）を保ったまま続き、あと 0.5 秒で休止
        #expect(rule.read(idle, at: 10.5) == nil)
        #expect(rule.read(idle, at: 11.5) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("休止中に「分からない」になると取り、理由は「判定できない」。戻ると待たずに休止する（待ちは済んでいる）")
    func unknownWhilePausedTakesWithUndeterminedReason() {
        var rule = makeRule()
        _ = rule.read(idle, at: 0)
        _ = rule.read(idle, at: 2)
        #expect(rule.paused == true)
        #expect(rule.read(nil, at: 3) == SelfPauseChange(paused: false, reason: .undetermined))
        #expect(rule.read(idle, at: 3.5) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("「分からない」をはさんで using → idle に戻ったときは待ちをやり直す")
    func unknownBetweenUsingAndIdleRestartsWait() {
        var rule = makeRule(wait: 2)
        _ = rule.read(idle, at: 0)
        _ = rule.read(idle, at: 1)
        _ = rule.read(using, at: 1.5)
        _ = rule.read(nil, at: 2)
        #expect(rule.read(idle, at: 2.5) == nil)
        #expect(rule.read(idle, at: 3.5) == nil)
        #expect(rule.read(idle, at: 4.5) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("--app に当たるプロセスが無いときは、休止しない（unknown）")
    func noMatchingProcessNeverPauses() {
        var rule = makeRule()
        for second in 0..<10 { #expect(rule.read([proc("com.apple.Safari", input: false)], at: Double(second)) == nil) }
        #expect(rule.paused == false)
    }
}

@Suite("自分の休止の規則: 手動")
struct SelfPauseManualTests {
    private func pausedAutomatically() -> SelfPauseRule {
        var rule = makeRule()
        _ = rule.read(idle, at: 0)
        _ = rule.read(idle, at: 2)
        return rule
    }

    @Test("使っている間に押した休止は手動の休止になり、理由は「手動」。同じ状態の指示は何も変えない")
    func manualPauseWhileUsing() {
        var rule = makeRule()
        _ = rule.read(using, at: 0)
        #expect(rule.press(paused: true, at: 1) == SelfPauseChange(paused: true, reason: .manual))
        #expect(rule.paused == true)
        #expect(rule.reason == .manual)
        #expect(rule.carryOver.manual == .pause)
        #expect(rule.carryOver.basis == .using)
        #expect(rule.press(paused: true, at: 2) == nil)
    }

    @Test("手動の休止は、会議アプリが使っている → 使っていないに変わるまで続く。変わると外れるが、待たずに休止を続ける（理由は自動）")
    func manualPauseSurvivesUntilAppClosesThenKeepsPausing() {
        var rule = makeRule(wait: 3)
        _ = rule.read(using, at: 0)
        _ = rule.press(paused: true, at: 1)
        #expect(rule.read(using, at: 2) == nil)
        #expect(rule.read(nil, at: 3) == nil)  // 分からない間は外さない
        #expect(rule.read(using, at: 4) == nil)
        #expect(rule.paused == true)
        // マイクを閉じた読み取りで手動が外れ、待ち 3 秒を待たずに休止のまま。取る瞬間は無い
        #expect(rule.read(idle, at: 5) == SelfPauseChange(paused: true, reason: .automatic))
        #expect(rule.carryOver.manual == .none)
        #expect(rule.carryOver.basis == .unknown)
        #expect(rule.read(idle, at: 5.5) == nil)
        #expect(rule.paused == true)
    }

    @Test("手動で取った状態（休止中に再開）は、会議アプリがマイクを開くと外れ、自動（取る）に戻る")
    func manualTakeReleasedWhenAppOpensMic() {
        var rule = pausedAutomatically()
        #expect(rule.press(paused: false, at: 3) == SelfPauseChange(paused: false, reason: .manual))
        #expect(rule.carryOver.manual == .take)
        #expect(rule.carryOver.basis == .idle)
        // 使っていないままいくら経っても、取ったまま
        #expect(rule.read(idle, at: 4) == nil)
        #expect(rule.read(idle, at: 20) == nil)
        #expect(rule.paused == false)
        // マイクを開いた → 手動が外れる（自動の結論も取るなので、状態は変わらない）
        #expect(rule.read(using, at: 21) == nil)
        #expect(rule.carryOver.manual == .none)
        // 閉じると待ってから休止
        #expect(rule.read(idle, at: 22) == nil)
        #expect(rule.read(idle, at: 24) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("押した時点の自動の結論と同じ指示は、手動にしない。手動の休止中に使っている状態で取る指示を押すと、手動は無くなる")
    func pressMatchingAutomaticConclusionIsNotManual() {
        var rule = makeRule()
        _ = rule.read(using, at: 0)
        _ = rule.press(paused: true, at: 1)
        #expect(rule.press(paused: false, at: 2) == SelfPauseChange(paused: false, reason: .manual))
        #expect(rule.carryOver.manual == .none)
        #expect(rule.carryOver.basis == .unknown)
        #expect(rule.paused == false)
    }

    @Test("「分からない」の間に押した休止は手動の休止になり、基準は最初に読めた値になる。使っている → 使っていないで外れる")
    func manualPauseWhileUnknownTakesFirstReadAsBasis() {
        var rule = makeRule()
        #expect(rule.press(paused: true, at: 0) == SelfPauseChange(paused: true, reason: .manual))
        #expect(rule.carryOver.basis == .unknown)
        // 最初に読めた値（using）が基準になる。外れない
        #expect(rule.read(using, at: 1) == nil)
        #expect(rule.carryOver.basis == .using)
        #expect(rule.carryOver.manual == .pause)
        #expect(rule.read(idle, at: 2) == SelfPauseChange(paused: true, reason: .automatic))
        #expect(rule.carryOver.manual == .none)
    }

    @Test("「分からない」の間は取っているので、取る指示は状態を変えず、手動にもしない")
    func takeInstructionWhileUnknownChangesNothing() {
        var rule = makeRule()
        // 分からない間は取っているので、取る指示は状態を変えない
        #expect(rule.press(paused: false, at: 0) == nil)
        #expect(rule.carryOver.manual == .none)
    }

    @Test("手動の休止が、使っていない状態の待ちを済ませて自動の結論と同じになると外れる。休止は続き、理由が手動 → 自動に変わる")
    func manualPauseBecomesAutomaticWhenConclusionCatchesUp() {
        var rule = makeRule(wait: 2)
        _ = rule.read(idle, at: 0)
        #expect(rule.press(paused: true, at: 0.5) == SelfPauseChange(paused: true, reason: .manual))
        #expect(rule.carryOver.manual == .pause)
        #expect(rule.read(idle, at: 1) == nil)
        // 使っていないが 2 秒続いて、自動の結論も休止になる → 手動を外し、理由だけ変わる
        #expect(rule.read(idle, at: 2) == SelfPauseChange(paused: true, reason: .automatic))
        #expect(rule.carryOver.manual == .none)
        #expect(rule.read(idle, at: 3) == nil)
    }

    @Test("理由だけの変化は休止中のときだけ知らせる。取っている間に理由が変わるだけなら知らせない")
    func reasonOnlyChangeIsReportedOnlyWhilePaused() {
        var rule = makeRule()
        _ = rule.read(using, at: 0)
        #expect(rule.reason == .automatic)
        // 取っている間に分からなくなっても、状態は変わらないので知らせない
        #expect(rule.read(nil, at: 1) == nil)
        #expect(rule.paused == false)
    }
}

@Suite("自分の休止の規則: 起動し直し")
struct SelfPauseRestartTests {
    @Test("手動・基準・最後に読めた値・待ちの進み具合が carryOver に出て、そのまま復元できる")
    func carryOverReflectsState() {
        var rule = makeRule(wait: 3)
        _ = rule.read(idle, at: 0)
        _ = rule.read(idle, at: 1.5)
        #expect(rule.carryOver == SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .idle, idleFor: 1.5))
        #expect(rule.press(paused: true, at: 1.5) == SelfPauseChange(paused: true, reason: .manual))
        #expect(rule.carryOver == SelfPauseCarryOver(manual: .pause, basis: .idle, lastKnown: .idle, idleFor: 1.5))
    }

    @Test("手動の休止を復元すると、始めから休止中（手動）で、判定は「分からない」")
    func restoredManualPauseStartsPaused() {
        let rule = makeRule(restoring: SelfPauseCarryOver(manual: .pause, basis: .using, lastKnown: .using, idleFor: 0))
        #expect(rule.paused == true)
        #expect(rule.reason == .manual)
        #expect(rule.judgement == .unknown)
    }

    @Test("復元後に読めた値が、最後に読めた値と同じ「使っていない」で待ちが済んでいれば、待たずに休止する")
    func restoredIdleProgressSkipsWait() {
        var rule = makeRule(wait: 3, restoring: SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .idle, idleFor: 3))
        #expect(rule.paused == false)  // 読めるまでは取る
        #expect(rule.read(idle, at: 0) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("復元した待ちの進み具合から続きを数える")
    func restoredIdleProgressContinues() {
        var rule = makeRule(wait: 3, restoring: SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .idle, idleFor: 2))
        #expect(rule.read(idle, at: 0) == nil)
        #expect(rule.read(idle, at: 1) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("復元後に最後に読めた値と違う値が読めたら、待ちはやり直す")
    func restoredDifferentValueRestartsWait() {
        var rule = makeRule(wait: 2, restoring: SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .using, idleFor: 0))
        #expect(rule.read(idle, at: 0) == nil)
        #expect(rule.read(idle, at: 1) == nil)
        #expect(rule.read(idle, at: 2) == SelfPauseChange(paused: true, reason: .automatic))
    }

    @Test("手動の休止を復元しても、起動し直しや読めない一瞬では外れない。基準と同じ値が読めても外れない")
    func restoredManualIsNotReleasedByRestartOrUnknown() {
        var rule = makeRule(restoring: SelfPauseCarryOver(manual: .pause, basis: .using, lastKnown: .using, idleFor: 0))
        #expect(rule.read(nil, at: 0) == nil)
        #expect(rule.read(using, at: 1) == nil)
        #expect(rule.paused == true)
        #expect(rule.read(idle, at: 2) == SelfPauseChange(paused: true, reason: .automatic))
    }

    // 起動し直しの前の規則（original）と、その carryOver から作り直した規則（restored）に、同じ時刻・同じ読み取りの列を渡し、
    // 各手の後の paused・reason・carryOver が一致することを確かめる。期待値は書かず、起動し直しの前の規則の結論と比べる。
    // 列の最初の読み取りは、original が最後に操作した時刻と同じにする（restored は最初の読み取りでは時間が進まないため）。
    private typealias Reading = (processes: [InputProcess]?, time: Double)

    private func expectSameConclusions(
        _ original: SelfPauseRule,
        thenReading readings: [Reading],
        restoredPausedBeforeFirstRead: Bool,
        restoredReasonBeforeFirstRead: SelfPauseReason,
        wait: Double = 2
    ) {
        var original = original
        var restored = makeRule(wait: wait, restoring: original.carryOver)
        #expect(restored.judgement == .unknown)
        #expect(restored.paused == restoredPausedBeforeFirstRead)
        #expect(restored.reason == restoredReasonBeforeFirstRead)
        for (index, reading) in readings.enumerated() {
            _ = original.read(reading.processes, at: reading.time)
            _ = restored.read(reading.processes, at: reading.time)
            #expect(restored.paused == original.paused, "読み取り \(index) の後の paused")
            #expect(restored.reason == original.reason, "読み取り \(index) の後の reason")
            #expect(restored.carryOver == original.carryOver, "読み取り \(index) の後の carryOver")
        }
    }

    @Test("起動し直しの前後で同じ結論: 手動の休止（基準 using）は、マイクが基準から変わるまで続き、変わったら自動の結論に従う")
    func sameConclusionsManualPauseWithUsingBasis() {
        var original = makeRule()
        _ = original.read(using, at: 0)
        _ = original.press(paused: true, at: 0)
        #expect(original.paused == true && original.reason == .manual)
        expectSameConclusions(
            original,
            thenReading: [(using, 0), (using, 1), (nil, 2), (using, 3), (idle, 4), (idle, 5), (using, 6)],
            restoredPausedBeforeFirstRead: true,
            restoredReasonBeforeFirstRead: .manual
        )
    }

    @Test("起動し直しの前後で同じ結論: 手動の休止（基準 idle、待ちの途中）は、使い始めで外れる")
    func sameConclusionsManualPauseWithIdleBasisDuringWait() {
        var original = makeRule(wait: 2)
        _ = original.read(idle, at: 0)
        _ = original.read(idle, at: 1)
        _ = original.press(paused: true, at: 1)
        #expect(original.paused == true && original.reason == .manual)
        expectSameConclusions(
            original,
            thenReading: [(idle, 1), (idle, 2), (nil, 3), (using, 4), (using, 5)],
            restoredPausedBeforeFirstRead: true,
            restoredReasonBeforeFirstRead: .manual
        )
    }

    @Test("起動し直しの前後で同じ結論: 手動の取る（基準 idle）は、マイクが基準から変わるまで続く")
    func sameConclusionsManualTake() {
        var original = makeRule(wait: 2)
        _ = original.read(idle, at: 0)
        _ = original.read(idle, at: 2)
        _ = original.press(paused: false, at: 2)
        #expect(original.paused == false && original.reason == .manual)
        expectSameConclusions(
            original,
            thenReading: [(idle, 2), (idle, 3), (nil, 4), (idle, 5), (using, 6), (idle, 7)],
            restoredPausedBeforeFirstRead: false,
            restoredReasonBeforeFirstRead: .manual
        )
    }

    @Test("起動し直しの前後で同じ結論: 待ちが済んだ自動の休止は、同じ「使っていない」が読めた時点で待たずに休止に戻る")
    func sameConclusionsAutomaticPauseAfterWait() {
        var original = makeRule(wait: 2)
        _ = original.read(idle, at: 0)
        _ = original.read(idle, at: 2)
        #expect(original.paused == true && original.reason == .automatic)
        // 読めるまでは「分からない」のはさまりとして取る
        expectSameConclusions(
            original,
            thenReading: [(idle, 2), (idle, 3), (using, 4), (idle, 5), (idle, 6)],
            restoredPausedBeforeFirstRead: false,
            restoredReasonBeforeFirstRead: .undetermined
        )
    }

    @Test("起動し直しの前後で同じ結論: 待ちの途中は、復元した進み具合から続きを数える")
    func sameConclusionsAutomaticDuringWait() {
        var original = makeRule(wait: 3)
        _ = original.read(idle, at: 0)
        _ = original.read(idle, at: 2)
        #expect(original.paused == false)
        expectSameConclusions(
            original,
            thenReading: [(idle, 2), (idle, 3), (idle, 4), (idle, 5), (using, 6)],
            restoredPausedBeforeFirstRead: false,
            restoredReasonBeforeFirstRead: .undetermined,
            wait: 3
        )
    }

    @Test("起動し直しの前後で同じ結論: 休止の後に「分からない」をはさんでも、同じ「使っていない」が読めたら休止に戻る")
    func sameConclusionsAutomaticPauseAcrossUnknown() {
        var original = makeRule(wait: 2)
        _ = original.read(idle, at: 0)
        _ = original.read(idle, at: 2)
        _ = original.read(nil, at: 3)
        #expect(original.judgement == .unknown)
        expectSameConclusions(
            original,
            thenReading: [(idle, 3), (idle, 4), (nil, 5), (using, 6), (idle, 7)],
            restoredPausedBeforeFirstRead: false,
            restoredReasonBeforeFirstRead: .undetermined
        )
    }
}

// Formal Spec の不変条件。Quint のモデルを、深さ 7 まで総当たりして毎手で 6 つの不変条件を確かめる。
@Suite("自分の休止の規則: Formal Spec の不変条件")
struct SelfPauseInvariantTests {
    private enum Step: CaseIterable {
        case appToggle, readApp, readUnknown, pressPause, pressTake, restart
    }

    private struct Model {
        var rule: SelfPauseRule
        var appUsing = false
        var now = 0.0
        // 観測用（Quint の pressed / changes と、読めた最後の値）
        var pressed = SelfPauseManual.none
        var changes = 0
        var lastRead = InputJudgement.unknown
    }

    private static let wait = 2.0
    private static let maxFailures = 5

    private static func autoPaused(_ rule: SelfPauseRule) -> Bool {
        rule.judgement == .idle && rule.carryOver.idleFor >= wait
    }

    private static func violations(of model: Model) -> [String] {
        let rule = model.rule
        let carry = rule.carryOver
        let paused = rule.paused
        var broken: [String] = []
        if rule.judgement == .unknown && carry.manual == .none && paused { broken.append("invUnknownTakes") }
        if rule.judgement == .using && carry.manual == .none && paused { broken.append("invUsingTakes") }
        if carry.manual == .none && paused && !(rule.judgement == .idle && carry.idleFor >= wait) { broken.append("invPauseOnlyAfterWait") }
        if carry.manual != .none && rule.judgement != .unknown && (carry.manual == .pause) == autoPaused(rule) { broken.append("invManualDiffersFromAuto") }
        if model.pressed != .none && model.changes == 0 && rule.judgement != .unknown && paused != (model.pressed == .pause) { broken.append("invManualHeldUntilAppChanges") }
        if model.pressed == .pause && model.changes == 1 && rule.judgement == .idle && !paused { broken.append("invNoTakeAfterLeavingWithManualPause") }
        return broken
    }

    /// 1 手進める。前提を満たさない手（今と同じ状態の指示）は nil。報告の整合も確かめ、食い違いを `broken` に足す
    private static func apply(_ step: Step, to model: Model, broken: inout [String]) -> Model? {
        var next = model
        switch step {
        case .appToggle:
            next.appUsing.toggle()
        case .readApp, .readUnknown:
            next.now += 1
            let beforePaused = next.rule.paused
            let beforeReason = next.rule.reason
            let value: InputJudgement = step == .readUnknown ? .unknown : (next.appUsing ? .using : .idle)
            let change = next.rule.read(step == .readUnknown ? nil : (next.appUsing ? using : idle), at: next.now)
            if value != .unknown {
                if next.lastRead != .unknown && value != next.lastRead { next.changes = min(2, next.changes + 1) }
                next.lastRead = value
            }
            // 返り値があるのは、paused が変わったとき、または休止中に理由が変わったときだけ
            let expectChange = beforePaused != next.rule.paused || (next.rule.paused && beforeReason != next.rule.reason)
            if (change != nil) != expectChange { broken.append("read の報告の有無が状態の変化と合わない") }
            if let change, change != SelfPauseChange(paused: next.rule.paused, reason: next.rule.reason) { broken.append("read の報告が状態と合わない") }
        case .pressPause, .pressTake:
            let wantsPause = step == .pressPause
            if wantsPause == next.rule.paused {
                // 今と同じ状態の指示は何も変えない
                if next.rule.press(paused: wantsPause, at: next.now) != nil { broken.append("同じ状態の指示が変化を報告した") }
                return nil
            }
            let change = next.rule.press(paused: wantsPause, at: next.now)
            if change != SelfPauseChange(paused: wantsPause, reason: .manual) { broken.append("press の報告が手動の変化でない") }
            next.pressed = next.rule.carryOver.manual
            next.changes = 0
        case .restart:
            next.rule = makeRule(wait: wait, restoring: next.rule.carryOver)
        }
        return next
    }

    private static func explore(_ model: Model, _ trail: [Step], depth: Int, failures: inout [String]) {
        guard failures.count < maxFailures else { return }
        let broken = violations(of: model)
        if !broken.isEmpty {
            failures.append("\(broken) 手順: \(trail) 判定=\(model.rule.judgement) 手動=\(model.rule.carryOver.manual) idleFor=\(model.rule.carryOver.idleFor)")
            return
        }
        guard depth > 0 else { return }
        for step in Step.allCases {
            var broken: [String] = []
            guard let next = apply(step, to: model, broken: &broken) else { continue }
            if !broken.isEmpty {
                failures.append("\(broken) 手順: \(trail + [step])")
                continue
            }
            explore(next, trail + [step], depth: depth - 1, failures: &failures)
        }
    }

    @Test("どの手順の毎手でも、6 つの不変条件が成り立つ（unknown を取る・using を取る・待ってから休止・手動は自動と違う・手動は変わり目まで続く・手動の休止は閉じても続く）")
    func invariantsHoldForEveryShortSequence() {
        var failures: [String] = []
        Self.explore(Model(rule: makeRule(wait: Self.wait)), [], depth: 7, failures: &failures)
        #expect(failures.isEmpty, Comment(rawValue: failures.joined(separator: "\n")))
    }

    @Test("反例の再現: 手動の休止の後、読めない一瞬をはさんで閉じたときも、取る瞬間は無い")
    func counterexampleManualPauseThenLeaving() {
        var rule = makeRule(wait: 2)
        _ = rule.read(using, at: 0)
        _ = rule.press(paused: true, at: 0)
        _ = rule.read(nil, at: 1)
        _ = rule.read(idle, at: 2)
        #expect(rule.paused == true)
    }

    @Test("反例の再現: 起動し直しと読めない一瞬では手動が外れない（読めた値は基準にしない）")
    func counterexampleRestartKeepsManual() {
        var rule = makeRule(wait: 2)
        _ = rule.read(idle, at: 0)
        _ = rule.press(paused: true, at: 0)
        rule = makeRule(wait: 2, restoring: rule.carryOver)
        _ = rule.read(nil, at: 1)
        #expect(rule.carryOver.manual == .pause)
        #expect(rule.paused == true)
    }
}

@Suite("自分の休止の規則: Core Audio のプロセスの変換")
struct InputProcessConversionTests {
    @Test("pid が読めないプロセスは除外せず、pid -1・入力の使用 nil で残す。別に入力を使っていない対象があっても判定は unknown")
    func unreadablePIDIsKeptAndJudgedUnknown() {
        let unreadable = inputProcess(bundleID: app, readPID: { nil }, readRunningInput: { 1 })
        let notUsing = inputProcess(bundleID: app + ".helper", readPID: { 200 }, readRunningInput: { 0 })
        #expect(unreadable == InputProcess(bundleID: app, pid: -1, isRunningInput: nil))
        #expect(notUsing == InputProcess(bundleID: app + ".helper", pid: 200, isRunningInput: false))
        let converted = [unreadable, notUsing].compactMap { $0 }
        #expect(judgeInput(processes: converted, app: app, ownPID: me) == .unknown)
    }

    @Test("bundle id が無いプロセスは除外する。pid が読めて入力が読めないときは isRunningInput が nil")
    func missingBundleIDIsExcluded() {
        #expect(inputProcess(bundleID: nil, readPID: { 200 }, readRunningInput: { 1 }) == nil)
        #expect(inputProcess(bundleID: app, readPID: { 200 }, readRunningInput: { nil })
            == InputProcess(bundleID: app, pid: 200, isRunningInput: nil))
    }
}
