------------------------------ MODULE SessionLifecycle ------------------------------
(* セッションの受け付け（server/src/sessions.ts の Sessions.layer）のモデル。
   start・startRecorded（openSession）・stop・resume・reserveDeps と、会議のセッションで live.intake を
   書き換える者（runLive の observe、書き込みの失敗を待つ fork、resume）と、その変化を画面に送る showIntake が、
   どの順で割り込み合っても約束が成り立つかを見る。
   1 つの遷移は、コードで割り込まれない 1 歩（Ref.modify・Ref.set・Ref.get・SubscriptionRef.set・
   SubscriptionRef.modifySome・send の 1 回）、
   または I/O を待つ 1 回（checks.prepare・running.end・writeOut など）に当たる。
   Effect 4 の Fiber は MaxOpsBeforeYield ごとに順番を譲るので、同期の Ref の歩の間にも別の Fiber が入れる。
   取り込みの 1 回の run（intakeAttempts.ts の run の body）は、sessions.ts に見える分だけを書く:
   observe（running / interrupted / stopped）・reached・end と、stopRequested を見る条件。
   試行の中身（ヘルパーの起動、つながり直したときの指示の再送）は IntakeAttempts.tla が見る。
   live.intake は SubscriptionRef で、set は値の書き換えと changes への publish を 1 歩で行う（semaphore の中の同期の処理、
   effect/src/SubscriptionRef.ts の setUnsafe）。画面に intake を送るのは showIntake だけで、changes を順に読み、
   最後に送った値と違うときだけ送る。
   画面の値 shown は Viewers の retained の intake（後から開いた画面が受け取る値）。配信の順は ViewerFeed.tla が見る。
   含めないもの: マップと字幕の中身、共有画面の知らせ、話者、書き出しの中身、時刻、HTTP の切断による中断
   （stop は serverScope に fork するので中断されない）、ヘルパーの子プロセスそのもの。 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Kind,          \* "live"（会議: start・resume）か "recorded"（録画: startRecorded・concludeRecorded）
  MaxSessions,   \* 開くセッションの数の上限
  MaxResumes,    \* resume の呼び出しの数の上限
  MaxCrashes,    \* ヘルパーが勝手に終わる回数（起動の失敗を含む）の上限
  MaxReserve,    \* reserveDeps（依存の導入中）の回数の上限
  MaxWriteFails  \* 書き込みの失敗（sink.writeFailure）の回数の上限（0 か 1）

MaxRuns == 1 + MaxResumes
Gens == 1..MaxSessions
RunIds == 1..MaxRuns
NoRun == 0
Kinds == {"idle", "starting", "live", "recorded", "stopping"}
Ends == {"none", "stopped", "finished", "gaveUp", "aborted"}
Reaches == {"none", "running", "gaveUp", "aborted"}
IntakeKinds == {"running", "interrupted", "stopped"}

VARIABLES
  state,        \* sessions.ts:94 State: [kind, gen（どのセッションか）, inst（idle の installations）]
  reserver,     \* reserveDeps の acquireRelease（http.ts の依存の導入）: pc
  reserveN,
  starter,      \* start / startRecorded の要求（openSession）: pc
  sessions,     \* 開いたセッションの数（次のセッションの gen）
  stopper,      \* stop の要求: [pc, gen, run（stopLive が読んだ live.running）]
  resumer,      \* resume の要求: [pc, gen, run]
  resumes,
  scopeOpen,    \* セッションの Scope（openSession の Scope.fork）が開いているか
  stopReq,      \* openIntake の stopRequested（セッションごとに 1 つ、全 run で共有）
  intake,       \* live.intake（CLI の status が返す取り込みの状態）
  changes,      \* live.intake の changes のうち、showIntake がまだ読んでいない値（セッションごと）
  folded,       \* showIntake の runFoldEffect の値（セッションごと。最後に送った値で、初めは INITIAL_INTAKE の running）
  shown,        \* Viewers の retained の intake フレーム（画面が見る値）。"none" は消えた状態
  sent,         \* forSession の sent に intake が入っているか（Scope を閉じるとき none を送るか）
  runs,         \* run ごとの [pc, reached, end]
  runningRef,   \* live.running / recorded.running（最後に始めた run）
  nextRun,
  crashes,
  writeErr,     \* sink.writeError（書き込みの失敗が起きたか）
  writeFails,
  watcher,      \* start が fork する、書き込みの失敗を待つ Fiber（sessions.ts:334）: [pc, run]
  concluder     \* startRecorded の afterPublish が fork する、終わりを待つ Fiber（sessions.ts:491）: pc

vars == <<state, reserver, reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq,
          intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

NoRunRec == [pc |-> "unborn", reached |-> "none", end |-> "none"]

TypeOK ==
  /\ state \in [kind : Kinds, gen : 0..MaxSessions, inst : 0..MaxReserve]
  /\ intake \in [Gens -> IntakeKinds]
  /\ changes \in [Gens -> Seq(IntakeKinds)]
  /\ folded \in [Gens -> IntakeKinds]
  /\ shown \in {"none", "running", "interrupted", "stopped"}
  /\ runs \in [Gens \X RunIds -> [pc : {"unborn", "serving", "afterServe", "decide", "intrSet", "relaunch",
                                "launching", "connected", "runSet", "reachSet", "giveupSet", "giveupReach", "ended"},
                          reached : Reaches, end : Ends]]
  /\ runningRef \in [Gens -> 0..MaxRuns]

Init ==
  /\ state = [kind |-> "idle", gen |-> 0, inst |-> 0]
  /\ reserver = "out"
  /\ reserveN = 0
  /\ starter = "idle"
  /\ sessions = 0
  /\ stopper = [pc |-> "idle", gen |-> 0, run |-> NoRun]
  /\ resumer = [pc |-> "idle", gen |-> 0, run |-> NoRun]
  /\ resumes = 0
  /\ scopeOpen = [g \in Gens |-> FALSE]
  /\ stopReq = [g \in Gens |-> FALSE]
  /\ intake = [g \in Gens |-> "running"]
  /\ changes = [g \in Gens |-> <<>>]
  /\ folded = [g \in Gens |-> "running"]
  /\ shown = "none"
  /\ sent = [g \in Gens |-> FALSE]
  /\ runs = [k \in Gens \X RunIds |-> NoRunRec]
  /\ runningRef = [g \in Gens |-> NoRun]
  /\ nextRun = [g \in Gens |-> 1]
  /\ crashes = 0
  /\ writeErr = FALSE
  /\ writeFails = 0
  /\ watcher = [pc |-> "none", gen |-> 0, run |-> NoRun]
  /\ concluder = [pc |-> "none", gen |-> 0]

Cur == state.gen
\* run は <<セッション, 番号>> で指す（resume が持つ Running は、そのセッションの run を指し続ける）
Active(k) == runs[k].pc \notin {"unborn", "ended"}
SetRun(k, f, v) == runs' = [runs EXCEPT ![k][f] = v]
\* Deferred.succeed は決まっていれば何もしない
Reach(rec, v) == IF rec.reached = "none" THEN v ELSE rec.reached
\* body の ensuring（intakeAttempts.ts:153）: run が終われば、reached が決まっていなければ aborted にする
EndRun(k, e) == runs' = [runs EXCEPT ![k].pc = "ended", ![k].end = e, ![k].reached = Reach(runs[k], "aborted")]
Ended(g, r) == r = NoRun \/ runs[<<g, r>>].pc = "ended"
\* resume が live.scope に fork した Fiber（sessions.ts:554-558）の中の歩。Scope を閉じると中断される
ResInScope == {"runLive", "setRunning", "awaitReached"}

------------------------------------------------------------------------------
\* reserveDeps（sessions.ts:161）。idle のときだけ installations を 1 増やし、返すときは idle なら 1 減らす

ReserveAcquire ==
  /\ reserver = "out" /\ reserveN < MaxReserve
  /\ IF state.kind = "idle"                                   \* sessions.ts:153-158 claimIdle
     THEN /\ state' = [state EXCEPT !.inst = @ + 1]            \* sessions.ts:162
          /\ reserver' = "held"
     ELSE UNCHANGED <<state, reserver>>
  /\ reserveN' = reserveN + 1
  /\ UNCHANGED <<starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

ReserveRelease ==
  /\ reserver = "held"
  /\ state' = IF state.kind = "idle" THEN [state EXCEPT !.inst = @ - 1] ELSE state  \* sessions.ts:163
  /\ reserver' = "out"
  /\ UNCHANGED <<reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

------------------------------------------------------------------------------
\* openSession（sessions.ts:261）

StartClaim ==
  /\ starter = "idle" /\ sessions < MaxSessions
  /\ IF state.kind = "idle" /\ state.inst = 0                  \* sessions.ts:259 claimStart
     THEN /\ state' = [kind |-> "starting", gen |-> sessions + 1, inst |-> 0]
          /\ starter' = "opening"
          /\ sessions' = sessions + 1
     ELSE UNCHANGED <<state, starter, sessions>>                 \* SessionBusy / SessionTransition
  /\ UNCHANGED <<reserver, reserveN, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

\* body（prepareMap・openIntake の最初の起動・sinks.open）が失敗した: Scope を閉じ、onExit で idle に戻す（sessions.ts:277, 278）
StartFail ==
  /\ starter = "opening"
  /\ state' = [kind |-> "idle", gen |-> state.gen, inst |-> 0]
  /\ starter' = "idle"
  /\ UNCHANGED <<reserver, reserveN, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

\* body が通った。live なら showIntake を fork し（sessions.ts:332）、最初の試行はつながった状態で run を始め（:333 / 478-486）、書き込みの失敗を待つ Fiber を fork する（:334）
StartOpened ==
  /\ starter = "opening"
  /\ scopeOpen' = [scopeOpen EXCEPT ![Cur] = TRUE]
  /\ runs' = [runs EXCEPT ![<<Cur, 1>>] = [pc |-> "serving", reached |-> "none", end |-> "none"]]
  /\ runningRef' = [runningRef EXCEPT ![Cur] = 1]
  /\ nextRun' = [nextRun EXCEPT ![Cur] = 2]
  /\ crashes' = 0
  /\ writeErr' = FALSE
  /\ writeFails' = 0
  /\ watcher' = IF Kind = "live" THEN [pc |-> "waiting", gen |-> Cur, run |-> NoRun] ELSE watcher
  /\ concluder' = IF Kind = "recorded" THEN [pc |-> "waiting", gen |-> Cur] ELSE concluder
  /\ starter' = "publish"
  /\ UNCHANGED <<state, reserver, reserveN, sessions, stopper, resumer, resumes, stopReq, intake, changes, folded, shown, sent>>

\* Ref.set(state, opened.active)（sessions.ts:273）
StartPublish ==
  /\ starter = "publish"
  /\ state' = [state EXCEPT !.kind = Kind]
  /\ starter' = "idle"
  /\ UNCHANGED <<reserver, reserveN, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

------------------------------------------------------------------------------
\* 取り込みの run（intakeAttempts.ts:92 run の body）。sessions.ts に見える歩だけ。k = <<g, r>>

\* sessions.ts:254 SubscriptionRef.set(live.intake)。同じ歩で changes に publish する。
\* Scope を閉じた後は showIntake が中断されていて、読む者がいない
SetIntake(g, v) == /\ intake' = [intake EXCEPT ![g] = v]
                   /\ changes' = [changes EXCEPT ![g] = IF scopeOpen[g] THEN Append(@, v) ELSE @]

RunUnchanged == UNCHANGED <<state, reserver, reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq, runningRef, nextRun, writeErr, writeFails, watcher, concluder, folded>>
Quiet == UNCHANGED <<intake, changes, shown, sent, crashes>> /\ RunUnchanged

\* ヘルパーが勝手に終わる（落ちる・録画を読み終える）
RunCrash(k) ==
  /\ runs[k].pc = "serving" /\ ~stopReq[k[1]] /\ crashes < MaxCrashes
  /\ SetRun(k, "pc", "afterServe")
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<intake, changes, shown, sent>> /\ RunUnchanged

\* stopRequested で attempt.stop が走り、ヘルパーが終わる（intakeAttempts.ts:83）
RunStopped(k) ==
  /\ runs[k].pc = "serving" /\ stopReq[k[1]]
  /\ SetRun(k, "pc", "afterServe")
  /\ Quiet

\* intakeAttempts.ts:144-148
RunAfterServe(k) ==
  /\ runs[k].pc = "afterServe"
  /\ IF stopReq[k[1]] THEN EndRun(k, "stopped")                  \* :144
     ELSE IF Kind = "recorded" THEN \/ EndRun(k, "finished")     \* :146 exitZero finish かつ code 0
                                    \/ SetRun(k, "pc", "decide")
     ELSE SetRun(k, "pc", "decide")                              \* :147 observe crashed（表示は変えない）
  /\ Quiet

\* finishAttempt（:96）: decideIntakeRestart の結果は、起動し直す・諦めるのどちらでもよいとする
RunDecide(k) ==
  /\ runs[k].pc = "decide"
  /\ \/ SetRun(k, "pc", IF Kind = "live" THEN "intrSet" ELSE "relaunch")     \* :110 observe interrupted
     \/ SetRun(k, "pc", IF Kind = "live" THEN "giveupSet" ELSE "giveupReach") \* :107 observe stopped
  /\ Quiet

RunIntrSet(k) == /\ runs[k].pc = "intrSet" /\ SetIntake(k[1], "interrupted") /\ SetRun(k, "pc", "relaunch")
                 /\ UNCHANGED <<shown, sent, crashes>> /\ RunUnchanged

\* readNext(undefined)（:129）
RunRelaunch(k) ==
  /\ runs[k].pc = "relaunch"
  /\ IF stopReq[k[1]] THEN EndRun(k, "stopped") ELSE SetRun(k, "pc", "launching")
  /\ Quiet

\* launch（:130）を待つ。起動の失敗は、勝手に終わるのと同じく数える
RunLaunched(k) ==
  /\ runs[k].pc = "launching"
  /\ \/ SetRun(k, "pc", "connected") /\ UNCHANGED crashes
     \/ /\ crashes < MaxCrashes /\ crashes' = crashes + 1
        /\ IF stopReq[k[1]] THEN EndRun(k, "stopped") ELSE SetRun(k, "pc", "decide")  \* :132-133
  /\ UNCHANGED <<intake, changes, shown, sent>> /\ RunUnchanged

\* readConnected(…, true)（:114-124）: restarted = reconnecting ∧ ¬stopRequested
RunConnected(k) ==
  /\ runs[k].pc = "connected"
  /\ IF ~stopReq[k[1]] /\ Kind = "live" THEN SetRun(k, "pc", "runSet")  \* :116-118
     ELSE SetRun(k, "pc", "reachSet")
  /\ Quiet
RunRunSet(k) == /\ runs[k].pc = "runSet" /\ SetIntake(k[1], "running") /\ SetRun(k, "pc", "reachSet")   \* :122 observe running
                /\ UNCHANGED <<shown, sent, crashes>> /\ RunUnchanged
RunReachSet(k) ==
  /\ runs[k].pc = "reachSet"
  /\ runs' = [runs EXCEPT ![k].pc = "serving",
                          ![k].reached = IF ~stopReq[k[1]] THEN Reach(runs[k], "running") ELSE runs[k].reached]  \* :124
  /\ Quiet

RunGiveupSet(k) == /\ runs[k].pc = "giveupSet" /\ SetIntake(k[1], "stopped") /\ SetRun(k, "pc", "giveupReach")
                   /\ UNCHANGED <<shown, sent, crashes>> /\ RunUnchanged
RunGiveupReach(k) ==                                             \* :108 reached gaveUp、:149 end gaveUp
  /\ runs[k].pc = "giveupReach"
  /\ runs' = [runs EXCEPT ![k].pc = "ended", ![k].end = "gaveUp", ![k].reached = Reach(runs[k], "gaveUp")]
  /\ Quiet

RunStep(k) ==
  \/ RunStopped(k) \/ RunAfterServe(k) \/ RunDecide(k) \/ RunIntrSet(k) \/ RunRelaunch(k)
  \/ RunLaunched(k) \/ RunConnected(k) \/ RunRunSet(k) \/ RunReachSet(k)
  \/ RunGiveupSet(k) \/ RunGiveupReach(k)

------------------------------------------------------------------------------
\* 書き込みの失敗（sink.writeFailure）と、それを待つ Fiber（sessions.ts:334-341）

WriteFail ==
  /\ Kind = "live" /\ state.gen > 0 /\ scopeOpen[Cur] /\ ~writeErr /\ writeFails < MaxWriteFails
  /\ writeErr' = TRUE
  /\ writeFails' = writeFails + 1
  /\ UNCHANGED <<state, reserver, reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, watcher, concluder>>

WatcherUnchanged == UNCHANGED <<state, reserver, reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, runs, runningRef, nextRun, crashes, writeErr, writeFails, concluder, folded>>

WatchFire ==                                                    \* :335-337 controller.stop
  /\ watcher.pc = "waiting" /\ writeErr
  /\ stopReq' = [stopReq EXCEPT ![watcher.gen] = TRUE]
  /\ watcher' = [watcher EXCEPT !.pc = "readRunning"]
  /\ UNCHANGED <<intake, changes, shown, sent>> /\ WatcherUnchanged
WatchRead ==                                                    \* :339 Ref.get(live.running)
  /\ watcher.pc = "readRunning"
  /\ watcher' = [watcher EXCEPT !.pc = "awaitEnd", !.run = runningRef[watcher.gen]]
  /\ UNCHANGED <<stopReq, intake, changes, shown, sent>> /\ WatcherUnchanged
WatchAwait ==                                                   \* :340 running.end
  /\ watcher.pc = "awaitEnd" /\ Ended(watcher.gen, watcher.run)
  /\ watcher' = [watcher EXCEPT !.pc = "setStopped"]
  /\ UNCHANGED <<stopReq, intake, changes, shown, sent>> /\ WatcherUnchanged
WatchSet ==                                                     \* :341
  /\ watcher.pc = "setStopped"
  /\ SetIntake(watcher.gen, "stopped")
  /\ watcher' = [watcher EXCEPT !.pc = "done"]
  /\ UNCHANGED <<stopReq, shown, sent>> /\ WatcherUnchanged

WatcherStep == WatchFire \/ WatchRead \/ WatchAwait \/ WatchSet

------------------------------------------------------------------------------
\* showIntake（sessions.ts:50-52。start が :332 で Scope に fork する）: changes を 1 つ読み、最後に送った値と違えば送る。
\* send（viewers.ts:55-58）は sent・retained・publish を 1 歩で行う

ShowIntake(g) ==
  /\ scopeOpen[g] /\ changes[g] # <<>>
  /\ LET v == Head(changes[g]) IN
       /\ IF v # folded[g]
          THEN /\ shown' = v                                    \* viewers.ts:44 retained
               /\ sent' = [sent EXCEPT ![g] = TRUE]              \* viewers.ts:56 sent
          ELSE UNCHANGED <<shown, sent>>
       /\ folded' = [folded EXCEPT ![g] = v]
  /\ changes' = [changes EXCEPT ![g] = Tail(@)]
  /\ UNCHANGED <<state, reserver, reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher, concluder>>

------------------------------------------------------------------------------
\* セッションを閉じる（closeSession, sessions.ts:346）。Scope は "sequential" なので後から足したものから閉じる:
\* fork した Fiber（showIntake・run・書き込みの失敗を待つ Fiber・終わりを待つ Fiber・resume が fork した Fiber）を中断し、
\* 最後に forSession の終わりのフレームを送る（viewers.ts:50-54）

CloseScope(g) ==
  /\ scopeOpen' = [scopeOpen EXCEPT ![g] = FALSE]
  /\ runs' = [k \in Gens \X RunIds |-> IF k[1] = g /\ Active(k)
                                       THEN [pc |-> "ended", reached |-> Reach(runs[k], "aborted"), end |-> "aborted"]
                                       ELSE runs[k]]
  /\ watcher' = IF watcher.gen = g /\ watcher.pc \notin {"done", "none"} THEN [watcher EXCEPT !.pc = "done"] ELSE watcher
  /\ resumer' = IF resumer.gen = g /\ resumer.pc \in ResInScope THEN [pc |-> "idle", gen |-> 0, run |-> NoRun] ELSE resumer   \* Aborted（sessions.ts:560）
  /\ changes' = [changes EXCEPT ![g] = <<>>]
  /\ shown' = IF sent[g] THEN "none" ELSE shown                    \* END_FRAMES の intake: none

\* 録画の終わりを待つ Fiber と concludeRecorded（sessions.ts:491-496, 409-417）

ConcluderUnchanged == UNCHANGED <<reserver, reserveN, starter, sessions, stopper, resumer, resumes, scopeOpen, stopReq, intake, changes, folded, shown, sent, runs, runningRef, nextRun, crashes, writeErr, writeFails, watcher>>

ConcludeAwait ==                                                \* :491 running.end
  /\ concluder.pc = "waiting" /\ runs[<<concluder.gen, 1>>].pc = "ended"
  /\ concluder' = [concluder EXCEPT !.pc = IF runs[<<concluder.gen, 1>>].end = "stopped" THEN "done" ELSE "prepare"]   \* :492
  /\ UNCHANGED state /\ ConcluderUnchanged
ConcludePrepare ==                                              \* :410 Effect.exit(prepare)（書き出しの準備の I/O）
  /\ concluder.pc = "prepare"
  /\ concluder' = [concluder EXCEPT !.pc = "claim"]
  /\ UNCHANGED state /\ ConcluderUnchanged
ConcludeClaim ==                                                \* :411-412
  /\ concluder.pc = "claim"
  /\ IF state.kind = "recorded" /\ state.gen = concluder.gen
     THEN /\ state' = [state EXCEPT !.kind = "stopping"]
          /\ concluder' = [concluder EXCEPT !.pc = "closing"]
     ELSE /\ concluder' = [concluder EXCEPT !.pc = "done"]
          /\ UNCHANGED state
  /\ ConcluderUnchanged
ConcludeClose ==                                                \* :417 finishing の ensuring で closeRecorded
  /\ concluder.pc = "closing"
  /\ CloseScope(concluder.gen)
  /\ concluder' = [concluder EXCEPT !.pc = "setIdle"]
  /\ UNCHANGED <<state, reserver, reserveN, starter, sessions, stopper, resumes, stopReq, intake, folded, sent, runningRef, nextRun, crashes, writeErr, writeFails>>
ConcludeIdle ==                                                 \* closeSession の ensuring（:350）
  /\ concluder.pc = "setIdle"
  /\ state' = [kind |-> "idle", gen |-> state.gen, inst |-> 0]
  /\ concluder' = [concluder EXCEPT !.pc = "done"]
  /\ ConcluderUnchanged

ConcluderStep == ConcludeAwait \/ ConcludePrepare \/ ConcludeClaim \/ ConcludeClose \/ ConcludeIdle

------------------------------------------------------------------------------
\* stop（sessions.ts:531）

StopKeep == UNCHANGED <<reserver, reserveN, starter, sessions, resumes, intake, folded, sent, runningRef, nextRun, crashes, writeErr, writeFails>>
StopUnchanged == UNCHANGED <<resumer, changes>> /\ StopKeep

StopClaim ==                                                    \* :533 current("any", "stopping")
  /\ stopper.pc = "idle"
  /\ IF state.kind \in {"live", "recorded"}
     THEN /\ state' = [state EXCEPT !.kind = "stopping"]
          /\ stopper' = [pc |-> "stopIntake", gen |-> state.gen, run |-> NoRun]
     ELSE UNCHANGED <<state, stopper>>                            \* NoSession / SessionTransition
  /\ UNCHANGED <<scopeOpen, stopReq, shown, runs, watcher, concluder>> /\ StopUnchanged
StopIntake ==                                                   \* :503 / :524 controller.stop
  /\ stopper.pc = "stopIntake"
  /\ stopReq' = [stopReq EXCEPT ![stopper.gen] = TRUE]
  /\ stopper' = [stopper EXCEPT !.pc = "readRunning"]
  /\ UNCHANGED <<state, scopeOpen, shown, runs, watcher, concluder>> /\ StopUnchanged
StopRead ==                                                     \* :504 / :525 Ref.get(running)
  /\ stopper.pc = "readRunning"
  /\ stopper' = [stopper EXCEPT !.pc = "awaitEnd", !.run = runningRef[stopper.gen]]
  /\ UNCHANGED <<state, scopeOpen, stopReq, shown, runs, watcher, concluder>> /\ StopUnchanged
StopAwait ==                                                    \* :505-510 / :523-526 running.end、続く writeOut（I/O）
  /\ stopper.pc = "awaitEnd" /\ Ended(stopper.gen, stopper.run)
  /\ stopper' = [stopper EXCEPT !.pc = "close"]
  /\ UNCHANGED <<state, scopeOpen, stopReq, shown, runs, watcher, concluder>> /\ StopUnchanged
StopClose ==                                                    \* :519 / :529 closeSession（stopRelays・Scope.close）
  /\ stopper.pc = "close"
  /\ CloseScope(stopper.gen)
  /\ concluder' = IF concluder.gen = stopper.gen /\ concluder.pc \in {"waiting", "prepare", "claim"}
                  THEN [concluder EXCEPT !.pc = "done"] ELSE concluder
  /\ stopper' = [stopper EXCEPT !.pc = "setIdle"]
  /\ UNCHANGED <<state, stopReq>> /\ StopKeep
StopIdle ==                                                     \* closeSession の ensuring（:350）
  /\ stopper.pc = "setIdle"
  /\ state' = [kind |-> "idle", gen |-> state.gen, inst |-> 0]
  /\ stopper' = [pc |-> "idle", gen |-> 0, run |-> NoRun]
  /\ UNCHANGED <<scopeOpen, stopReq, shown, runs, watcher, concluder>> /\ StopUnchanged

StopperStep == StopIntake \/ StopRead \/ StopAwait \/ StopClose \/ StopIdle

------------------------------------------------------------------------------
\* resume（sessions.ts:540）。resumer.gen は current で取った live（以降のコードの live）

ResUnchanged == UNCHANGED <<state, reserver, reserveN, starter, sessions, stopper, stopReq, crashes, writeErr, writeFails, watcher, concluder, folded>>
ResDone == resumer' = [pc |-> "idle", gen |-> 0, run |-> NoRun]
ResIsCurrent == state.kind = "live" /\ state.gen = resumer.gen

ResCurrent ==                                                   \* :541 current("live")、:542-544 writeError と intake を見る
  /\ Kind = "live" /\ resumer.pc = "idle" /\ resumes < MaxResumes
  /\ resumes' = resumes + 1
  /\ IF state.kind = "live" /\ ~writeErr /\ intake[Cur] = "stopped"
     THEN resumer' = [pc |-> "prepare", gen |-> Cur, run |-> NoRun]
     ELSE UNCHANGED resumer
  /\ UNCHANGED <<scopeOpen, intake, changes, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged
ResPrepare ==                                                   \* :545 checks.prepare（I/O）、:546-547
  /\ resumer.pc = "prepare"
  /\ IF ResIsCurrent THEN resumer' = [resumer EXCEPT !.pc = "take"] ELSE ResDone   \* Aborted
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged
ResTake ==                                                      \* :548-549 SubscriptionRef.modifySome(live.intake)
  /\ resumer.pc = "take"
  /\ IF intake[resumer.gen] = "stopped"
     THEN /\ SetIntake(resumer.gen, "interrupted")
          /\ resumer' = [resumer EXCEPT !.pc = "readPrev"]
     ELSE /\ ResDone                                             \* IntakeNotStopped
          /\ UNCHANGED <<intake, changes>>
  /\ UNCHANGED <<resumes, scopeOpen, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged
ResReadPrev ==                                                  \* :550 Ref.get(live.running)
  /\ resumer.pc = "readPrev"
  /\ resumer' = [resumer EXCEPT !.pc = "awaitPrev", !.run = runningRef[resumer.gen]]
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged
ResAwaitPrev ==                                                 \* :551 previous.end、:552-553
  /\ resumer.pc = "awaitPrev" /\ Ended(resumer.gen, resumer.run)
  /\ IF ResIsCurrent THEN resumer' = [resumer EXCEPT !.pc = "fork"] ELSE ResDone   \* Aborted
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged
ResFork ==                                                      \* :554-558 forkIn(…, live.scope)、:559-560。閉じた Scope への forkIn は Fiber を始めずに中断する
                                                                \* （effect/src/internal/effect.ts:5698-5707）ので、resume は Aborted を返す
  /\ resumer.pc = "fork"
  /\ IF scopeOpen[resumer.gen] THEN resumer' = [resumer EXCEPT !.pc = "runLive"] ELSE ResDone
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged
ResRunLive ==                                                   \* :555 runLive（開いた Scope の中の Fiber から）
  /\ resumer.pc = "runLive" /\ nextRun[resumer.gen] <= MaxRuns
  /\ LET k == <<resumer.gen, nextRun[resumer.gen]>> IN
       runs' = [runs EXCEPT ![k] = [pc |-> "relaunch", reached |-> "none", end |-> "none"]]
  /\ resumer' = [resumer EXCEPT !.pc = "setRunning", !.run = nextRun[resumer.gen]]
  /\ nextRun' = [nextRun EXCEPT ![resumer.gen] = @ + 1]
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runningRef>> /\ ResUnchanged
ResSetRunning ==                                                \* :556
  /\ resumer.pc = "setRunning"
  /\ runningRef' = [runningRef EXCEPT ![resumer.gen] = resumer.run]
  /\ resumer' = [resumer EXCEPT !.pc = "awaitReached"]
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runs, nextRun>> /\ ResUnchanged
ResAwaitReached ==                                              \* :557 running.reached、:561-563
  /\ resumer.pc = "awaitReached" /\ runs[<<resumer.gen, resumer.run>>].reached # "none"
  /\ ResDone
  /\ UNCHANGED <<resumes, scopeOpen, intake, changes, shown, sent, runs, runningRef, nextRun>> /\ ResUnchanged

ResumerStep == ResPrepare \/ ResTake \/ ResReadPrev \/ ResAwaitPrev \/ ResFork \/ ResRunLive \/ ResSetRunning \/ ResAwaitReached

------------------------------------------------------------------------------

\* 利用者や外から起きること（要求の始まり、ヘルパーが勝手に終わる、書き込みの失敗）を除いた、システムが自分で進める歩
System ==
  \/ StartFail \/ StartOpened \/ StartPublish
  \/ \E k \in Gens \X RunIds : RunStep(k)
  \/ \E g \in Gens : ShowIntake(g)
  \/ WatcherStep \/ ConcluderStep \/ StopperStep \/ ResumerStep

Next ==
  \/ ReserveAcquire \/ ReserveRelease \/ StartClaim \/ StopClaim \/ ResCurrent \/ WriteFail
  \/ \E k \in Gens \X RunIds : RunCrash(k)
  \/ System

Spec == Init /\ [][Next]_vars /\ WF_vars(System)

------------------------------------------------------------------------------
\* 約束

Settled == ~ENABLED System
Notice(v) == IF v \in {"interrupted", "stopped"} THEN v ELSE "quiet"   \* web/src/intake.ts intakeNoticeText

\* 依存の導入中はセッションを始めない（導入中の依存を、始めたセッションが使わない）
InvNoSessionWhileReserved == reserver = "held" => state.kind = "idle"

\* idle の installations は、持たれている予約の数と同じ（予約が返ったのに start が断られ続けない）
InvInstallationsCount == state.kind = "idle" => state.inst = IF reserver = "held" THEN 1 ELSE 0

\* セッションを閉じる者は 1 人だけ（stop と録画の自然な終わりが、同じセッションを二重に書き出し・閉じない）
InvOneCloser == ~(stopper.pc \in {"stopIntake", "readRunning", "awaitEnd", "close", "setIdle"} /\ concluder.pc \in {"closing", "setIdle"})

\* 落ち着いたとき、画面の知らせは CLI の status と同じことを言う
InvScreenMatchesStatus == Settled /\ state.kind = "live" => Notice(shown) = Notice(intake[Cur])

\* 落ち着いたとき、取り込みが止まっているなら status は stopped と言い、動いているなら stopped と言わない
InvStatusTruthful ==
  Settled /\ state.kind = "live" => ((\A r \in RunIds : ~Active(<<Cur, r>>)) <=> intake[Cur] = "stopped")

\* セッションが閉じて落ち着いたら、画面に取り込みの知らせが残らない
InvScreenQuietWhenIdle == Settled /\ state.kind = "idle" => Notice(shown) = "quiet"

\* stop はいつか返る
PropStopReturns == [](stopper.pc # "idle" => <>(stopper.pc = "idle"))

\* resume はいつか返る
PropResumeReturns == [](resumer.pc # "idle" => <>(resumer.pc = "idle"))

=============================================================================
