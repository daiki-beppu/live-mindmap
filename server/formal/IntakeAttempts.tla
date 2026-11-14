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
   ヘルパーは、届いた指示をすぐ当て、処理した指示の seq を覚える（状態を変えない押下でも、SelfPauseMonitor.swift の handle）。
   live のヘルパーは、入力の使い方の変化で自分から休止・再開し、そのとき手動の休止を外す（AutoFlip、SelfPauseRule.swift の read）。
   self-pause-state は、ヘルパーが出す歩（起動したときの Launch と、生きている間の Echo）と、server が読む歩（ReadEcho）に分ける。
   出した状態は回ごとの outbox に並び、指示が届いた後に読まれることがある
   （起動したときの知らせは指示を読む前に出す、LiveSession.swift の announceSelfPause。死んだ回の読み残しも読む）。 *)
EXTENDS Naturals, Sequences

CONSTANTS
  Mode,       \* "live"（start: self-pause を handled が seq に届いた self-pause-state まで覚える、exitZero が restart、resume がある）か "recorded"（reading-pause が sticky、exitZero が finish）
  MaxCfg,     \* MAX_CONFIGURATION_CHANGES（intake.ts:27。本物は 10）
  MaxFailures,\* MAX_CONSECUTIVE_FAILURES（intake.ts:21）
  MaxSends,   \* 状態を有限にするための、利用者の send の数の上限
  MaxRuns     \* run の数の上限（最初の run と resume の分）

Slots == {1, 2}            \* ヘルパーの子プロセス。続く試行は交互の枠を使う（同時に 2 つ動くかを見るため）
NoSlot == 0
Other(s) == IF s = 1 THEN 2 ELSE 1
Want == {"none", "on", "off"}  \* 指示の値。"none" は指示が無い（ヘルパーの既定は止めていない）
MaxOutbox == 2
Paused(w) == w = "on"
Seqs == 0..MaxSends   \* 指示の seq。0 は「まだ指示を処理していない」
ExitKinds == {"none", "zero", "config", "other"}  \* config は HELPER_EXIT_CONFIGURATION_CHANGED（intake.ts:25）

VARIABLES
  pc,           \* run の body（intakeAttempts.ts:153）の位置。"Ended" は body が返った後
  cur,          \* 読んでいる・起動中の試行の枠（readNext の current / next）
  reconnecting, \* readConnected の reconnecting（:144 は FALSE、:151 は TRUE）
  served,       \* readNext が served を返したか（:161）
  helper,       \* 枠ごとの子プロセス: alive・sock（ソケットが開いている）・afterStop（stop の要求の後に起動した）・manual・auto・seq・has（HelperRec）・exit・ranLong
  stopRequested,\* Deferred stopRequested（:72）
  reached,      \* Deferred reached（:109）
  endKind,      \* body の返り値（IntakeEnd の kind）
  failures,     \* history.failures（:111）
  cfgN,         \* history.configurationChanges のうち、窓の中に残っている数
  shown,        \* sessions.ts の live.intake（observe の running / interrupted / stopped で変わる、sessions.ts:249）
  target,       \* link.target（:74）
  pending,      \* この Mode の覚えている指示の値。live は link.selfPause（acknowledged なら "none"）、recorded は link.readingPaused
  pendingSeq,   \* live: pending の self-pause の seq
  userWant,     \* 見張り: 利用者が最後に send した値。live で、その指示を取り込んだ状態のヘルパーが自分から休止・再開して外したら "none"
  carried,      \* live: sessions.ts の selfPauseState（ヘルパーが返した状態。次の起動の launchOptions に渡る）
  sends,
  runs,
  countedAfterStop, \* 見張り: stop の要求の後に起動した試行を、起動し直し・running として数えた
  outbox,       \* live: 枠ごとの、ヘルパーが出して server がまだ読んでいない self-pause-state（出した順、2 つまで）
  confirmed,    \* 見張り: server が読んだ self-pause-state の seq の最大（ヘルパーが処理したと返した指示）
  revived       \* 見張り: ヘルパーが処理したと返した指示を、次の回へ送り直した

vars == <<pc, cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

Pcs == {"ReadNext", "Launch", "Launching", "FailCheck", "Connect", "Check", "Restarted", "ObsRunning",
        "ReachCheck", "ReachSet", "Serving", "AwaitExit", "AfterRead", "Finish", "GaveUpReached", "Ended"}
\* manual は手動の指示（SelfPauseRule の manual: none・pause・take を "none"・"on"・"off" で）、auto は入力の読み取りで自分から休止している。
\* seq はヘルパーが self-pause-state の handled で返す、処理した最後の指示の seq。has は見張り: この状態が取り込んでいる最後の指示の seq（起動引数で引き継いだ分を含む）
HelperRec == [alive : BOOLEAN, sock : BOOLEAN, afterStop : BOOLEAN, manual : Want, auto : BOOLEAN, seq : Seqs, has : Seqs, exit : ExitKinds, ranLong : BOOLEAN]
Dead == [alive |-> FALSE, sock |-> FALSE, afterStop |-> FALSE, manual |-> "none", auto |-> FALSE, seq |-> 0, has |-> 0, exit |-> "none", ranLong |-> FALSE]
PausedNow(h) == h.manual = "on" \/ (h.manual = "none" /\ h.auto)   \* SelfPauseRule の state.paused
Report(h) == [manual |-> h.manual, auto |-> h.auto, seq |-> h.seq, has |-> h.has]   \* self-pause-state（has は見張り）
Reports == [manual : Want, auto : BOOLEAN, seq : Seqs, has : Seqs]
Carried == [manual : Want, auto : BOOLEAN, has : Seqs]
Max(a, b) == IF a >= b THEN a ELSE b

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
  /\ pending \in Want /\ pendingSeq \in Seqs /\ userWant \in Want /\ carried \in Carried
  /\ sends \in 0..MaxSends /\ runs \in 1..MaxRuns
  /\ countedAfterStop \in BOOLEAN
  /\ \A s \in Slots : Len(outbox[s]) <= MaxOutbox /\ \A i \in 1..Len(outbox[s]) : outbox[s][i] \in Reports
  /\ confirmed \in Seqs /\ revived \in BOOLEAN

\* 最初の試行は openIntake の中で起動し（:83）、link.target に入れてある（:90）。最初の run は initial を読む（:154）
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
  /\ pending = "none" /\ pendingSeq = 0 /\ userWant = "none" /\ carried = [manual |-> "none", auto |-> FALSE, has |-> 0]
  /\ sends = 0 /\ runs = 1
  /\ countedAfterStop = FALSE
  /\ outbox = [s \in Slots |-> IF s = 1 /\ Mode = "live" THEN <<Report(Dead)>> ELSE <<>>]   \* 最初の試行が起動したときの知らせ
  /\ confirmed = 0 /\ revived = FALSE

\* body が返る（:157・:160・:162・:165）。ensuring で reached が未定なら aborted にする（:169）
Return(kind) ==
  /\ pc' = "Ended" /\ endKind' = kind
  /\ reached' = IF reached = "undecided" THEN "aborted" ELSE reached

\* ---- run の body ----

\* readNext（:143）。current があればそれを readConnected(current, false) に渡す（:144）
ReadNextCurrent ==
  /\ pc = "ReadNext" /\ cur # NoSlot
  /\ pc' = "Connect" /\ reconnecting' = FALSE /\ served' = TRUE
  /\ UNCHANGED <<cur, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* current が無ければ、stop が要求済みかを見る（:145）
ReadNextStopped ==
  /\ pc = "ReadNext" /\ cur = NoSlot
  /\ stopRequested                                  \* intakeAttempts.ts:145
  /\ Return("stopped")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

ReadNextLaunch ==
  /\ pc = "ReadNext" /\ cur = NoSlot
  /\ ~stopRequested                                 \* intakeAttempts.ts:145
  /\ pc' = "Launch"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* launch（:75）: 子プロセスを起動する。launchOptions は selfPauseState（carried）を渡し（sessions.ts:304）、
\* reading-pause は渡さない（sessions.ts:433）。前の試行の子プロセスは serve が終わりを待ってから閉じている（:103）。
\* seq は起動引数に無いので、新しいヘルパーはまだ指示を処理していない（seq 0）
Launch ==
  /\ pc = "Launch"
  /\ LET slot == CHOOSE x \in Slots : ~helper[x].alive /\ ~helper[x].sock
         started == IF Mode = "live"
                    THEN [Dead EXCEPT !.alive = TRUE, !.afterStop = stopRequested, !.manual = carried.manual, !.auto = carried.auto, !.has = carried.has]
                    ELSE [Dead EXCEPT !.alive = TRUE, !.afterStop = stopRequested] IN
       /\ \E x \in Slots : ~helper[x].alive /\ ~helper[x].sock
       /\ cur' = slot
       /\ helper' = [helper EXCEPT ![slot] = started]
       /\ outbox' = [outbox EXCEPT ![slot] = IF Mode = "live" THEN <<Report(started)>> ELSE <<>>]   \* 指示を読む前に起動引数の状態を知らせる（LiveSession.swift:103）
  /\ pc' = "Launching"
  /\ UNCHANGED <<reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, pendingSeq, confirmed, revived>>

\* launch の中の raceFirst(connect, helperEnded)（helpers.ts:284）: ソケットが開けば成功
LaunchConnected ==
  /\ pc = "Launching" /\ helper[cur].alive
  /\ helper' = [helper EXCEPT ![cur].sock = TRUE]
  /\ pc' = "Connect" /\ reconnecting' = TRUE /\ served' = TRUE
  /\ UNCHANGED <<cur, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* 子プロセスが先に終われば HelperLaunchFailure（helpers.ts:282）。scope を閉じる（:80）
LaunchFailed ==
  /\ pc = "Launching" /\ ~helper[cur].alive
  /\ pc' = "FailCheck" /\ served' = FALSE
  /\ UNCHANGED <<cur, reconnecting, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

FailCheckStopped ==
  /\ pc = "FailCheck" /\ stopRequested               \* intakeAttempts.ts:148
  /\ Return("stopped")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

FailCheckFailed ==
  /\ pc = "FailCheck" /\ ~stopRequested              \* intakeAttempts.ts:148
  /\ pc' = "Finish"                                  \* connectionFailed（:149）は crashed を observe しない（:161）
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* 指示 v（seq n）がヘルパー s に届けば、すぐ当てる（SelfPauseRule.swift の press）。求める値と今の休止が同じなら状態は変えない。
\* 自分から休止している値と同じなら手動を外し、違えば手動にする。どちらでも seq を処理済みにする（SelfPauseMonitor.swift の handle）。
\* ソケットが開いていない・子プロセスが終わっているなら届かない（helperSocket.ts:46）
Deliver(s, v, n) ==
  LET h == helper[s] IN
  IF h.alive /\ h.sock
  THEN [h EXCEPT !.manual = IF PausedNow(h) = Paused(v) THEN h.manual ELSE IF Paused(v) = h.auto THEN "none" ELSE v,
                 !.seq = n, !.has = n]
  ELSE h

\* connect（:92）。SynchronizedRef.updateEffect の中なので send と交わらない
Connect ==
  /\ pc = "Connect"
  /\ IF target = cur                                 \* intakeAttempts.ts:93
     THEN UNCHANGED <<helper, target, revived>>
     ELSE /\ target' = cur
          /\ LET replay == pending # "none" /\ (Mode = "live" \/ Paused(pending)) IN  \* intakeAttempts.ts:94・:41 carried（self-pause は処理したと返るまで、reading-pause は paused のときだけ送り直す）
               /\ helper' = IF replay THEN [helper EXCEPT ![cur] = Deliver(cur, pending, pendingSeq)] ELSE helper
               /\ revived' = (revived \/ (replay /\ Mode = "live" /\ pendingSeq <= confirmed))
  /\ pc' = "Check"
  /\ UNCHANGED <<cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed>>

\* restarted = reconnecting && !isDone(stopRequested)（:132）。observe connected（:133）は表示を変えない
Check ==
  /\ pc = "Check"
  /\ pc' = IF reconnecting /\ ~stopRequested THEN "Restarted" ELSE "ReachCheck"   \* intakeAttempts.ts:132・:134
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* restarts を 1 つ増やして intake-restarted を書く（:135・:136）
Restarted ==
  /\ pc = "Restarted"
  /\ countedAfterStop' = (countedAfterStop \/ helper[cur].afterStop)
  /\ pc' = "ObsRunning"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, outbox, pendingSeq, confirmed, revived>>

ObsRunning ==
  /\ pc = "ObsRunning"
  /\ shown' = "running"                              \* intakeAttempts.ts:138 → sessions.ts:249
  /\ pc' = "ReachCheck"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

ReachCheck ==
  /\ pc = "ReachCheck"
  /\ pc' = IF ~stopRequested THEN "ReachSet" ELSE "Serving"   \* intakeAttempts.ts:140
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

ReachSet ==
  /\ pc = "ReachSet"
  /\ reached' = IF reached = "undecided" THEN "running" ELSE reached   \* intakeAttempts.ts:140（Deferred は最初の 1 回だけ）
  /\ countedAfterStop' = (countedAfterStop \/ (reached = "undecided" /\ helper[cur].afterStop))
  /\ pc' = "Serving"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, outbox, pendingSeq, confirmed, revived>>

\* serve（:97）: ソケットが閉じて読み残しが無くなるとイベントのストリームが終わり、ensuring で link.target を外す（:100・:101）
ServeEnd ==
  /\ pc = "Serving" /\ ~helper[cur].sock /\ outbox[cur] = <<>>
  /\ target' = NoSlot
  /\ pc' = "AwaitExit"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* 子プロセスの終わりを待ってから scope を閉じる（:103・:105）
AwaitExit ==
  /\ pc = "AwaitExit" /\ ~helper[cur].alive          \* intakeAttempts.ts:103
  /\ pc' = "AfterRead"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

AfterReadStopped ==
  /\ pc = "AfterRead" /\ stopRequested               \* intakeAttempts.ts:160
  /\ Return("stopped")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

AfterReadFinished ==
  /\ pc = "AfterRead" /\ ~stopRequested
  /\ served /\ Mode = "recorded" /\ helper[cur].exit = "zero"   \* intakeAttempts.ts:162（exitZero が finish）
  /\ Return("finished")
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* served なら crashed を observe する（:163。表示は変えない、sessions.ts:241）
AfterReadCrashed ==
  /\ pc = "AfterRead" /\ ~stopRequested
  /\ ~(served /\ Mode = "recorded" /\ helper[cur].exit = "zero")
  /\ pc' = "Finish"
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* finishAttempt（:112）。decideIntakeRestart（intake.ts:48）。窓から外れた構成の変化の数は選び直す（時刻を表さない代わり）
Finish ==
  /\ pc = "Finish"
  /\ LET h == helper[cur] IN
     \E kept \in 0..cfgN :
       IF h.exit = "config"                                         \* intake.ts:51
       THEN LET changes == kept + 1 IN
            LET f == IF h.ranLong THEN 0 ELSE failures IN           \* intake.ts:53
            IF changes > MaxCfg                                     \* intake.ts:54
            THEN /\ pc' = "GaveUpReached" /\ shown' = "stopped" /\ failures' = f /\ cfgN' = MaxCfg   \* :123
            ELSE /\ pc' = "ReadNext" /\ shown' = "interrupted" /\ failures' = f /\ cfgN' = changes   \* :126
       ELSE IF h.ranLong                                           \* intake.ts:58
            THEN /\ pc' = "ReadNext" /\ shown' = "interrupted" /\ failures' = 0 /\ cfgN' = kept
            ELSE IF failures + 1 >= MaxFailures                     \* intake.ts:60
                 THEN /\ pc' = "GaveUpReached" /\ shown' = "stopped" /\ failures' = MaxFailures /\ cfgN' = kept
                 ELSE /\ pc' = "ReadNext" /\ shown' = "interrupted" /\ failures' = failures + 1 /\ cfgN' = kept
  /\ cur' = NoSlot                                                  \* current = undefined（:159）
  /\ UNCHANGED <<reconnecting, served, helper, stopRequested, reached, endKind, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

GaveUpReached ==
  /\ pc = "GaveUpReached"
  /\ reached' = IF reached = "undecided" THEN "gaveUp" ELSE reached  \* intakeAttempts.ts:124
  /\ pc' = "Ended" /\ endKind' = "gaveUp"                            \* intakeAttempts.ts:165
  /\ UNCHANGED <<cur, reconnecting, served, helper, stopRequested, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* ---- ヘルパーの子プロセス ----

\* 落ちる・終わる。stop の要求の後は kill で SIGTERM（helpers.ts:272・intakeAttempts.ts:99）なので exit は other
HelperExit ==
  \E s \in Slots, k \in {"zero", "config", "other"}, long \in BOOLEAN :
    /\ helper[s].alive
    /\ helper' = [helper EXCEPT ![s].alive = FALSE, ![s].exit = k, ![s].ranLong = long]
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

HelperKilled ==
  \E s \in Slots :
    /\ stopRequested /\ helper[s].alive
    /\ helper' = [helper EXCEPT ![s].alive = FALSE, ![s].exit = "other", ![s].ranLong = FALSE]
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* ソケットが閉じる（helperSocket.ts:35）。子プロセスが終わればいずれ閉じる。生きたまま閉じることもある
SockClose ==
  \E s \in Slots :
    /\ helper[s].sock
    /\ helper' = [helper EXCEPT ![s].sock = FALSE]
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* live: 生きているヘルパーが、いまの状態と処理した最後の seq を self-pause-state で出す（SelfPauseMonitor.swift:92）。
\* 指示を当てたときだけでなく、入力の読み取りでも出す
Echo ==
  \E s \in Slots :
    /\ Mode = "live" /\ helper[s].alive /\ Len(outbox[s]) < MaxOutbox
    /\ helper[s].sock \/ (s = cur /\ pc = "Launching")   \* つながる前に出した状態は、つながったときに届く（WebSocketServer.swift:95）
    /\ outbox' = [outbox EXCEPT ![s] = Append(@, Report(helper[s]))]
    /\ UNCHANGED <<pc, cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, pendingSeq, confirmed, revived>>

\* 子プロセスが終わると、出したまま届いていない状態は消えることがある
LoseUnread ==
  \E s \in Slots :
    /\ ~helper[s].alive /\ outbox[s] # <<>>
    /\ outbox' = [outbox EXCEPT ![s] = <<>>]
    /\ UNCHANGED <<pc, cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, pendingSeq, confirmed, revived>>

\* serve が self-pause-state を読む。handled（r.seq）が pending の seq に届いていれば pending の self-pause を忘れ（intakeAttempts.ts:100・:45 acknowledge）、
\* それから sessions.ts が selfPauseState に入れる（sessions.ts:209）
ReadEcho ==
  /\ pc = "Serving" /\ outbox[cur] # <<>>
  /\ LET r == Head(outbox[cur]) IN
       /\ carried' = [manual |-> r.manual, auto |-> r.auto, has |-> r.has]
       /\ pending' = IF r.seq >= pendingSeq THEN "none" ELSE pending
       /\ confirmed' = Max(confirmed, r.seq)
  /\ outbox' = [outbox EXCEPT ![cur] = Tail(@)]
  /\ UNCHANGED <<pc, cur, reconnecting, served, helper, stopRequested, reached, endKind, failures, cfgN, shown, target, userWant, sends, runs, countedAfterStop, pendingSeq, revived>>

\* live: ヘルパーが入力の使い方の変化を読み、自分から休止・再開する。手動の休止・再開は外れる（SelfPauseRule.swift の released）。
\* 利用者の最後の指示を取り込んだ状態で外れたら、その指示はもう効いていなくてよい
AutoFlip ==
  \E s \in Slots :
    /\ Mode = "live" /\ helper[s].alive
    /\ helper' = [helper EXCEPT ![s].auto = ~@, ![s].manual = "none"]
    /\ userWant' = IF helper[s].has = sends THEN "none" ELSE userWant
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* ---- 利用者と sessions.ts ----

Stop ==
  /\ ~stopRequested
  /\ stopRequested' = TRUE                            \* intakeAttempts.ts:181
  /\ UNCHANGED <<pc, cur, reconnecting, served, helper, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

\* send（:176）。SynchronizedRef.updateEffect の中なので connect と交わらない
Send ==
  \E v \in {"on", "off"} :
    /\ sends < MaxSends
    /\ sends' = sends + 1 /\ userWant' = v
    /\ pending' = v /\ pendingSeq' = sends + 1                               \* intakeAttempts.ts:177・:31 remember（どちらも覚える。self-pause には前の seq の次を付ける）
    /\ helper' = IF target # NoSlot THEN [helper EXCEPT ![target] = Deliver(target, v, sends + 1)] ELSE helper   \* intakeAttempts.ts:178
    /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, carried, runs, countedAfterStop, outbox, confirmed, revived>>

\* sessions.ts の resume（:536）: 表示が stopped のときだけ、表示を interrupted にし、前の end を待ってから次の run を始める
Resume ==
  /\ Mode = "live" /\ runs < MaxRuns
  /\ ~stopRequested
  /\ shown = "stopped"                                 \* sessions.ts:540・:544
  /\ pc = "Ended"                                      \* sessions.ts:547（previous.end）
  /\ runs' = runs + 1
  /\ shown' = "interrupted"
  /\ pc' = "ReadNext" /\ cur' = NoSlot                 \* initial は最初の run が取り出した（:154）
  /\ reached' = "undecided" /\ endKind' = "none"
  /\ failures' = 0 /\ cfgN' = 0                        \* history は run ごと（:111）
  /\ UNCHANGED <<reconnecting, served, helper, stopRequested, target, pending, userWant, carried, sends, countedAfterStop, outbox, pendingSeq, confirmed, revived>>

Body == ReadNextCurrent \/ ReadNextStopped \/ ReadNextLaunch \/ Launch \/ LaunchConnected \/ LaunchFailed
        \/ FailCheckStopped \/ FailCheckFailed \/ Connect \/ Check \/ Restarted \/ ObsRunning \/ ReachCheck \/ ReachSet
        \/ ReadEcho \/ ServeEnd \/ AwaitExit \/ AfterReadStopped \/ AfterReadFinished \/ AfterReadCrashed \/ Finish \/ GaveUpReached

Next == Body \/ HelperExit \/ HelperKilled \/ SockClose \/ Echo \/ AutoFlip \/ LoseUnread \/ ReadEcho \/ Stop \/ Send \/ Resume

\* body の Fiber は進む。stop の後の kill は効く。終わった子プロセスのソケットはいずれ閉じる。
\* 起動中の子プロセスは、いずれソケットを開くか終わる（LaunchConnected・LaunchFailed・HelperExit のどれか）
Spec ==
  /\ Init /\ [][Next]_vars
  /\ WF_vars(Body)
  /\ WF_vars(HelperKilled)
  /\ \A s \in Slots : WF_vars(helper[s].sock /\ ~helper[s].alive /\ helper' = [helper EXCEPT ![s].sock = FALSE]
                              /\ UNCHANGED <<pc, cur, reconnecting, served, stopRequested, reached, endKind, failures, cfgN, shown, target, pending, userWant, carried, sends, runs, countedAfterStop, outbox, pendingSeq, confirmed, revived>>)

-----------------------------------------------------------------------------
\* 性質

\* 同時に 2 つのヘルパーを動かさない
InvOneHelperAtATime == ~(helper[1].alive /\ helper[2].alive)

\* stop の要求の後に起動した試行を、起動し直した（restarts・intake-restarted）とも、running に着いたとも数えない
InvNotCountedAfterStop == ~countedAfterStop

\* 取り込みの表示が stopped なのは、run が諦めて終わる（gaveUp）ときだけ
InvStoppedOnlyWhenGaveUp == shown = "stopped" => pc \in {"GaveUpReached", "Ended"} /\ endKind \in {"none", "gaveUp"} /\ cur = NoSlot

\* つながって読んでいるヘルパーには、利用者が最後に送った指示が当たっている（live では、ヘルパーが自分から外した後を除く）
Connected == target # NoSlot /\ target = cur /\ helper[cur].alive /\ helper[cur].sock
              /\ pc \in {"Check", "Restarted", "ObsRunning", "ReachCheck", "ReachSet", "Serving"}
InvInstructionFollowsUser == Connected /\ userWant # "none" => PausedNow(helper[cur]) = Paused(userWant)
\* live では自分の一時停止（self-pause、self-pause-state まで覚える）、recorded では読み上げの一時停止（reading-pause、sticky）
InvSelfPauseFollowsUser == InvInstructionFollowsUser
InvReadingPauseFollowsUser == InvInstructionFollowsUser

\* ヘルパーが処理したと返した self-pause を、次の回へ送り直さない（外れた手動の休止を、起動し直しで戻さない）
InvNoResendAfterHandled == ~revived

\* resume が待つ reached は、いつか決まる（reached を待つのは live の resume だけ、sessions.ts:553）
PropReachedSettles == [](reached = "undecided" => <>(reached # "undecided"))

\* stop の後、end はいつか返る
PropEndAfterStop == stopRequested ~> (pc = "Ended")
=============================================================================
