------------------------------ MODULE IntakeAttempts ------------------------------
(* 取り込みの再起動（server/src/intakeAttempts.ts の openIntake）のモデル。
   ヘルパーの起動（launch）・つなぎ込み（connect）・読み取り（serve）・run の body のループ・finishAttempt と、
   send・stop・reached・end を扱う。再起動の判断は decideIntakeRestart（server/src/core/intake.ts:48）。
   1 つの遷移は、コードで割り込まれない 1 歩（Ref・SynchronizedRef・Deferred の 1 回の操作、
   または非同期の境目までの同期の区間）に当たる。条件の注釈に行を書く。
   モデルに入れる外の者: 利用者（stop・send）、ヘルパーの子プロセス（落ちる・ソケットを閉じる）、
   sessions.ts の resume（live だけ。前の run の end を待ってから次の run を始める）。
   含めないもの: イベントの中身と apply・log の書き込み（SessionWriteFailed による tapError を含む）、時刻そのもの
   （60 秒の窓は、落ちるたびに ranLong と窓から外れた構成の変化の数を選び直すことで表す）、stats の attempt の数、
   openIntake の最初の起動の失敗（start が失敗するだけなので、最初の試行はつながった状態から始める）。
   ヘルパーは、届いた指示をすぐ当てて、その状態を self-pause-state で返すとする（live の carried）。 *)
EXTENDS Naturals

CONSTANTS
  Mode,       \* "live"（start: self-pause が pending-once、exitZero が restart、resume がある）か "recorded"（reading-pause が sticky、exitZero が finish）
  MaxCfg,     \* MAX_CONFIGURATION_CHANGES（intake.ts:27。本物は 10）
  MaxFailures,\* MAX_CONSECUTIVE_FAILURES（intake.ts:21）
  MaxSends,   \* 状態を有限にするための、利用者の send の数の上限
  MaxRuns     \* run の数の上限（最初の run と resume の分）

Slots == {1, 2}            \* ヘルパーの子プロセス。続く試行は交互の枠を使う（同時に 2 つ動くかを見るため）
NoSlot == 0
Other(s) == IF s = 1 THEN 2 ELSE 1
Want == {"none", "on", "off"}  \* 指示の値。"none" は指示が無い（ヘルパーの既定は止めていない）
Paused(w) == w = "on"
ExitKinds == {"none", "zero", "config", "other"}  \* config は HELPER_EXIT_CONFIGURATION_CHANGED（intake.ts:25）

VARIABLES
  pc,           \* run の body（intakeAttempts.ts:137）の位置。"Ended" は body が返った後
  cur,          \* 読んでいる・起動中の試行の枠（readNext の current / next）
  reconnecting, \* readConnected の reconnecting（:128 は FALSE、:135 は TRUE）
  served,       \* readNext が served を返したか（:145）
  helper,       \* 枠ごとの子プロセス: alive・sock（ソケットが開いている）・afterStop（stop の要求の後に起動した）・applied（当たっている指示）・exit・ranLong
  stopRequested,\* Deferred stopRequested（:52）
  reached,      \* Deferred reached（:93）
  endKind,      \* body の返り値（IntakeEnd の kind）
  failures,     \* history.failures（:95）
  cfgN,         \* history.configurationChanges のうち、窓の中に残っている数
  shown,        \* sessions.ts の live.intake（observe の running / interrupted / stopped で変わる、sessions.ts:254）
  target,       \* link.target（:54）
  pending,      \* link.pending の、この Mode の指示（self-pause か reading-pause）の値
  userWant,     \* 利用者が最後に send した値
  carried,      \* live: sessions.ts の selfPauseState（ヘルパーが返した状態。次の起動の launchOptions に渡る）
  sends,
  runs,
  countedAfterStop \* 見張り: stop の要求の後に起動した試行を、起動し直し・running として数えた

vars == <<pc, cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

Pcs == {"ReadNext", "Launch", "Launching", "FailCheck", "Connect", "Check", "Restarted", "ObsRunning",
        "ReachCheck", "ReachSet", "Serving", "AwaitExit", "AfterRead", "Finish", "GaveUpReached", "Ended"}
HelperRec == [alive : BOOLEAN, sock : BOOLEAN, afterStop : BOOLEAN, applied : Want, exit : ExitKinds, ranLong : BOOLEAN]
Dead == [alive |-> FALSE, sock |-> FALSE, afterStop |-> FALSE, applied |-> "none", exit |-> "none", ranLong |-> FALSE]

TypeOK ==
  /\ pc \in Pcs
  /\ cur \in Slots \cup {NoSlot}
  /\ reconnecting \in BOOLEAN /\ served \in BOOLEAN
  /\ helper \in [Slots -> HelperRec]
  /\ stopRequested \in BOOLEAN
  /\ reached \in {"undecided", "running", "gaveUp", "aborted"}
  /\ endKind \in {"none", "stopped", "finished", "gaveUp"}
  /\ failures \in 0..MaxFailures
  /\ cfgN \in 0..MaxCfg
  /\ shown \in {"running", "interrupted", "stopped"}
  /\ target \in Slots \cup {NoSlot}
  /\ pending \in Want /\ userWant \in Want /\ carried \in Want
  /\ sends \in 0..MaxSends /\ runs \in 1..MaxRuns
  /\ countedAfterStop \in BOOLEAN

\* 最初の試行は openIntake の中で起動し（:63）、link.target に入れてある（:70）。最初の run は initial を読む（:138）
Init ==
  /\ pc = "ReadNext"
  /\ cur = 1
  /\ reconnecting = FALSE /\ served = FALSE
  /\ helper = [s \in Slots |-> IF s = 1 THEN [Dead EXCEPT !.alive = TRUE, !.sock = TRUE] ELSE Dead]
  /\ stopRequested = FALSE
  /\ reached = "undecided" /\ endKind = "none"
  /\ failures = 0 /\ cfgN = 0
  /\ shown = "running"
  /\ target = 1
  /\ pending = "none" /\ userWant = "none" /\ carried = "none"
  /\ sends = 0 /\ runs = 1
  /\ countedAfterStop = FALSE

\* body が返る（:141・:144・:146・:149）。ensuring で reached が未定なら aborted にする（:153）
Return(kind) ==
  /\ pc' = "Ended" /\ endKind' = kind
  /\ reached' = IF reached = "undecided" THEN "aborted" ELSE reached

\* ---- run の body ----

\* readNext（:127）。current があればそれを readConnected(current, false) に渡す（:128）
ReadNextCurrent ==
  /\ pc = "ReadNext" /\ cur # NoSlot
  /\ pc' = "Connect" /\ reconnecting' = FALSE /\ served' = TRUE
  /\ UNCHANGED <<cur, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* current が無ければ、stop が要求済みかを見る（:129）
ReadNextStopped ==
  /\ pc = "ReadNext" /\ cur = NoSlot
  /\ stopRequested                                  \* intakeAttempts.ts:129
  /\ Return("stopped")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

ReadNextLaunch ==
  /\ pc = "ReadNext" /\ cur = NoSlot
  /\ ~stopRequested                                 \* intakeAttempts.ts:129
  /\ pc' = "Launch"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* launch（:55）: 子プロセスを起動する。launchOptions は selfPauseState（carried）を渡し（sessions.ts:308）、
\* reading-pause は渡さない（sessions.ts:437）。前の試行の子プロセスは serve が終わりを待ってから閉じている（:87）
Launch ==
  /\ pc = "Launch"
  /\ LET slot == CHOOSE x \in Slots : ~helper[x].alive /\ ~helper[x].sock IN
       /\ \E x \in Slots : ~helper[x].alive /\ ~helper[x].sock
       /\ cur' = slot
       /\ helper' = [helper EXCEPT ![slot] = [Dead EXCEPT !.alive = TRUE, !.afterStop = stopRequested,
                                                           !.applied = IF Mode = "live" THEN carried ELSE "none"]]
  /\ pc' = "Launching"
  /\ UNCHANGED <<reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* launch の中の raceFirst(connect, helperEnded)（helpers.ts:278）: ソケットが開けば成功
LaunchConnected ==
  /\ pc = "Launching" /\ helper[cur].alive
  /\ helper' = [helper EXCEPT ![cur].sock = TRUE]
  /\ pc' = "Connect" /\ reconnecting' = TRUE /\ served' = TRUE
  /\ UNCHANGED <<cur, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* 子プロセスが先に終われば HelperLaunchFailure（helpers.ts:276）。scope を閉じる（:60）
LaunchFailed ==
  /\ pc = "Launching" /\ ~helper[cur].alive
  /\ pc' = "FailCheck" /\ served' = FALSE
  /\ UNCHANGED <<cur, reconnecting, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

FailCheckStopped ==
  /\ pc = "FailCheck" /\ stopRequested               \* intakeAttempts.ts:132
  /\ Return("stopped")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

FailCheckFailed ==
  /\ pc = "FailCheck" /\ ~stopRequested              \* intakeAttempts.ts:132
  /\ pc' = "Finish"                                  \* connectionFailed（:133）は crashed を observe しない（:145）
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* connect（:72）。SynchronizedRef.updateEffect の中なので send と交わらない
Deliver(s, v) == IF helper[s].alive /\ helper[s].sock THEN v ELSE helper[s].applied  \* helperSocket.ts:46
Connect ==
  /\ pc = "Connect"
  /\ IF target = cur                                 \* intakeAttempts.ts:73
     THEN UNCHANGED <<helper, pending, carried, target>>
     ELSE /\ target' = cur
          /\ LET replay == pending # "none" /\ (Mode = "live" \/ Paused(pending)) IN  \* intakeAttempts.ts:76（pending-once か paused）
               /\ helper' = IF replay THEN [helper EXCEPT ![cur].applied = Deliver(cur, pending)] ELSE helper
               /\ carried' = IF replay /\ Mode = "live" /\ helper[cur].alive /\ helper[cur].sock THEN pending ELSE carried
          /\ pending' = IF Mode = "live" THEN "none" ELSE pending   \* intakeAttempts.ts:77
  /\ pc' = "Check"
  /\ UNCHANGED <<cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, userWant, sends, runs, countedAfterStop>>

\* restarted = reconnecting && !isDone(stopRequested)（:116）。observe connected（:117）は表示を変えない
Check ==
  /\ pc = "Check"
  /\ pc' = IF reconnecting /\ ~stopRequested THEN "Restarted" ELSE "ReachCheck"   \* intakeAttempts.ts:116・:118
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* restarts を 1 つ増やして intake-restarted を書く（:119・:120）
Restarted ==
  /\ pc = "Restarted"
  /\ countedAfterStop' = (countedAfterStop \/ helper[cur].afterStop)
  /\ pc' = "ObsRunning"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs>>

ObsRunning ==
  /\ pc = "ObsRunning"
  /\ shown' = "running"                              \* intakeAttempts.ts:122 → sessions.ts:254
  /\ pc' = "ReachCheck"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, target, pending, userWant, carried, sends, runs, countedAfterStop>>

ReachCheck ==
  /\ pc = "ReachCheck"
  /\ pc' = IF ~stopRequested THEN "ReachSet" ELSE "Serving"   \* intakeAttempts.ts:124
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

ReachSet ==
  /\ pc = "ReachSet"
  /\ reached' = IF reached = "undecided" THEN "running" ELSE reached   \* intakeAttempts.ts:124（Deferred は最初の 1 回だけ）
  /\ countedAfterStop' = (countedAfterStop \/ (reached = "undecided" /\ helper[cur].afterStop))
  /\ pc' = "Serving"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs>>

\* serve（:81）: ソケットが閉じるとイベントのストリームが終わり、ensuring で link.target を外す（:84・:85）
ServeEnd ==
  /\ pc = "Serving" /\ ~helper[cur].sock
  /\ target' = NoSlot
  /\ pc' = "AwaitExit"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, pending, userWant, carried, sends, runs, countedAfterStop>>

\* 子プロセスの終わりを待ってから scope を閉じる（:87・:89）
AwaitExit ==
  /\ pc = "AwaitExit" /\ ~helper[cur].alive          \* intakeAttempts.ts:87
  /\ pc' = "AfterRead"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

AfterReadStopped ==
  /\ pc = "AfterRead" /\ stopRequested               \* intakeAttempts.ts:144
  /\ Return("stopped")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

AfterReadFinished ==
  /\ pc = "AfterRead" /\ ~stopRequested
  /\ served /\ Mode = "recorded" /\ helper[cur].exit = "zero"   \* intakeAttempts.ts:146（exitZero が finish）
  /\ Return("finished")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* served なら crashed を observe する（:147。表示は変えない、sessions.ts:246）
AfterReadCrashed ==
  /\ pc = "AfterRead" /\ ~stopRequested
  /\ ~(served /\ Mode = "recorded" /\ helper[cur].exit = "zero")
  /\ pc' = "Finish"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* finishAttempt（:96）。decideIntakeRestart（intake.ts:48）。窓から外れた構成の変化の数は選び直す（時刻を表さない代わり）
Finish ==
  /\ pc = "Finish"
  /\ LET h == helper[cur] IN
     \E kept \in 0..cfgN :
       IF h.exit = "config"                                         \* intake.ts:51
       THEN LET changes == kept + 1 IN
            LET f == IF h.ranLong THEN 0 ELSE failures IN           \* intake.ts:53
            IF changes > MaxCfg                                     \* intake.ts:54
            THEN /\ pc' = "GaveUpReached" /\ shown' = "stopped" /\ failures' = f /\ cfgN' = MaxCfg   \* :107
            ELSE /\ pc' = "ReadNext" /\ shown' = "interrupted" /\ failures' = f /\ cfgN' = changes   \* :110
       ELSE IF h.ranLong                                           \* intake.ts:58
            THEN /\ pc' = "ReadNext" /\ shown' = "interrupted" /\ failures' = 0 /\ cfgN' = kept
            ELSE IF failures + 1 >= MaxFailures                     \* intake.ts:60
                 THEN /\ pc' = "GaveUpReached" /\ shown' = "stopped" /\ failures' = MaxFailures /\ cfgN' = kept
                 ELSE /\ pc' = "ReadNext" /\ shown' = "interrupted" /\ failures' = failures + 1 /\ cfgN' = kept
  /\ cur' = NoSlot                                                  \* current = undefined（:143）
  /\ UNCHANGED <<reconnecting, served, helper, stopRequested, reached, endKind, target, pending, userWant, carried, sends, runs, countedAfterStop>>

GaveUpReached ==
  /\ pc = "GaveUpReached"
  /\ reached' = IF reached = "undecided" THEN "gaveUp" ELSE reached  \* intakeAttempts.ts:108
  /\ pc' = "Ended" /\ endKind' = "gaveUp"                            \* intakeAttempts.ts:149
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* ---- ヘルパーの子プロセス ----

\* 落ちる・終わる。stop の要求の後は kill で SIGTERM（helpers.ts:267・intakeAttempts.ts:83）なので exit は other
HelperExit ==
  \E s \in Slots, k \in {"zero", "config", "other"}, long \in BOOLEAN :
    /\ helper[s].alive
    /\ helper' = [helper EXCEPT ![s].alive = FALSE, ![s].exit = k, ![s].ranLong = long]
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

HelperKilled ==
  \E s \in Slots :
    /\ stopRequested /\ helper[s].alive
    /\ helper' = [helper EXCEPT ![s].alive = FALSE, ![s].exit = "other", ![s].ranLong = FALSE]
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* ソケットが閉じる（helperSocket.ts:35）。子プロセスが終わればいずれ閉じる。生きたまま閉じることもある
SockClose ==
  \E s \in Slots :
    /\ helper[s].sock
    /\ helper' = [helper EXCEPT ![s].sock = FALSE]
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* ---- 利用者と sessions.ts ----

Stop ==
  /\ ~stopRequested
  /\ stopRequested' = TRUE                            \* intakeAttempts.ts:167
  /\ UNCHANGED <<pc, cur, reconnecting, served, helper, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>

\* send（:160）。SynchronizedRef.updateEffect の中なので connect と交わらない
Send ==
  \E v \in {"on", "off"} :
    /\ sends < MaxSends
    /\ sends' = sends + 1 /\ userWant' = v
    /\ pending' = IF Mode = "recorded" \/ target = NoSlot THEN v ELSE pending   \* intakeAttempts.ts:163（sticky、または pending-once で target が無い）
    /\ IF target # NoSlot                                                     \* intakeAttempts.ts:164
       THEN /\ helper' = [helper EXCEPT ![target].applied = Deliver(target, v)]
            /\ carried' = IF Mode = "live" /\ helper[target].alive /\ helper[target].sock THEN v ELSE carried
       ELSE UNCHANGED <<helper, carried>>
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, runs, countedAfterStop>>

\* sessions.ts の resume（:540）: 表示が stopped のときだけ、表示を interrupted にし、前の end を待ってから次の run を始める
Resume ==
  /\ Mode = "live" /\ runs < MaxRuns
  /\ ~stopRequested
  /\ shown = "stopped"                                 \* sessions.ts:544・:548
  /\ pc = "Ended"                                      \* sessions.ts:551（previous.end）
  /\ runs' = runs + 1
  /\ shown' = "interrupted"
  /\ pc' = "ReadNext" /\ cur' = NoSlot                 \* initial は最初の run が取り出した（:138）
  /\ reached' = "undecided" /\ endKind' = "none"
  /\ failures' = 0 /\ cfgN' = 0                        \* history は run ごと（:95）
  /\ UNCHANGED <<reconnecting, served, helper, stopRequested, target, pending, userWant, carried, sends, countedAfterStop>>

Body == ReadNextCurrent \/ ReadNextStopped \/ ReadNextLaunch \/ Launch \/ LaunchConnected \/ LaunchFailed
        \/ FailCheckStopped \/ FailCheckFailed \/ Connect \/ Check \/ Restarted \/ ObsRunning \/ ReachCheck \/ ReachSet
        \/ ServeEnd \/ AwaitExit \/ AfterReadStopped \/ AfterReadFinished \/ AfterReadCrashed \/ Finish \/ GaveUpReached

Next == Body \/ HelperExit \/ HelperKilled \/ SockClose \/ Stop \/ Send \/ Resume

\* body の Fiber は進む。stop の後の kill は効く。終わった子プロセスのソケットはいずれ閉じる。
\* 起動中の子プロセスは、いずれソケットを開くか終わる（LaunchConnected・LaunchFailed・HelperExit のどれか）
Spec ==
  /\ Init /\ [][Next]_vars
  /\ WF_vars(Body)
  /\ WF_vars(HelperKilled)
  /\ \A s \in Slots : WF_vars(helper[s].sock /\ ~helper[s].alive /\ helper' = [helper EXCEPT ![s].sock = FALSE]
                              /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop>>)

-----------------------------------------------------------------------------
\* 性質

\* 同時に 2 つのヘルパーを動かさない
InvOneHelperAtATime == ~(helper[1].alive /\ helper[2].alive)

\* stop の要求の後に起動した試行を、起動し直した（restarts・intake-restarted）とも、running に着いたとも数えない
InvNotCountedAfterStop == ~countedAfterStop

\* 取り込みの表示が stopped なのは、run が諦めて終わる（gaveUp）ときだけ
InvStoppedOnlyWhenGaveUp == shown = "stopped" => pc \in {"GaveUpReached", "Ended"} /\ endKind \in {"none", "gaveUp"} /\ cur = NoSlot

\* つながって読んでいるヘルパーには、利用者が最後に送った指示が当たっている
Connected == target # NoSlot /\ target = cur /\ helper[cur].alive /\ helper[cur].sock
              /\ pc \in {"Check", "Restarted", "ObsRunning", "ReachCheck", "ReachSet", "Serving"}
InvInstructionFollowsUser == Connected /\ userWant # "none" => Paused(helper[cur].applied) = Paused(userWant)
\* live では自分の一時停止（self-pause、pending-once）、recorded では読み上げの一時停止（reading-pause、sticky）
InvSelfPauseFollowsUser == InvInstructionFollowsUser
InvReadingPauseFollowsUser == InvInstructionFollowsUser

\* resume が待つ reached は、いつか決まる（reached を待つのは live の resume だけ、sessions.ts:557）
PropReachedSettles == [](reached = "undecided" => <>(reached # "undecided"))

\* stop の後、end はいつか返る
PropEndAfterStop == stopRequested ~> (pc = "Ended")
=============================================================================
