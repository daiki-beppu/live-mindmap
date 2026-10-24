--------------------------- MODULE DiffUpdateScheduler ---------------------------
(* 差分更新の呼び出しの段取り（server/src/core/session.ts の openSession）のモデル。
   1 つの遷移は、コードで割り込まれない 1 歩（Ref.modify / Ref.update / Ref.get の 1 回）に当たる。
   遷移ごとの注釈に session.ts の行を書く。
   含めないもの: 共有画面の選び方、マップの中身、Scope を閉じたときの中断、時刻（再試行の待ちは「いつか起きる」とする）、
   復元（restoreSession）、push の 2 歩のうち remarks への追加とログ（pending への追加だけを見る）。 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Remarks,      \* 中身のある、重複でない発言（push で pending に入るもの）
  Kind,         \* "cloud"（ChatGPT・Claude: 一時停止がある）か "apple"（Apple Intelligence: lifecycle と停止がある）
  MaxPauses,    \* 状態空間を有限にするための、一時停止で終わる呼び出しの数の上限
  MaxLifecycle, \* 同じく、lifecycle の running / restarting の通知の数の上限
  CatchUp       \* CATCH_UP_REMARKS（session.ts:403）

\* 成功・失敗の呼び出しは 1 件以上を処理済みにし、停止の後は呼び出しが始まらないので、呼び出しの数は次で足りる
MaxCalls == Cardinality(Remarks) + MaxPauses + 1
CallIds == 1..MaxCalls
\* 再試行の待ちは、一時停止で終わった呼び出しごとに高々 1 つ
SleeperIds == 1..MaxPauses
NoCall == 0

VARIABLES
  pending,      \* Runtime.pending（Seq）
  known,        \* SessionState.known（反映済み・処理済みの発言の集合）
  reflecting,   \* Runtime.reflecting（unreflectedRemarks に載る、結果待ちの発言）
  inFlight,     \* Runtime.inFlight: [kind |-> "none" | "reserved" | "running", id |-> 呼び出しの番号]
  status,       \* diffUpdate.status
  retryEnabled, \* Runtime.retryEnabled
  calls,        \* 呼び出しの Fiber（runCall）ごとの pc と、渡した発言（fresh）
  nextCall,     \* 次に作る呼び出しの番号（Reservation の同一性の代わり）
  sleepers,     \* 再試行の待ちの Fiber（scheduleRetry が fork する）ごとの pc
  nextSleeper,
  pusher,       \* push を呼ぶ側（取り込み）。[pc, i |-> 次に入れる発言の番号]
  flusher,      \* flush の pc
  starts,       \* startDiffIfReady の途中にいる者ごとの、予約した呼び出しの番号（fork と置き換えの間）
  lifecycleN,
  pauses

vars == <<pending, known, reflecting, inFlight, status, retryEnabled, calls, nextCall, sleepers, nextSleeper, pusher, flusher, starts, lifecycleN, pauses>>

RemarkSeq == CHOOSE s \in [1..Cardinality(Remarks) -> Remarks] : \A i, j \in DOMAIN s : i # j => s[i] # s[j]
Range(s) == {s[i] : i \in DOMAIN s}
Take(s, n) == SubSeq(s, 1, n)
Drop(s, n) == SubSeq(s, n + 1, Len(s))

\* startDiffIfReady を呼べる者。呼び出しの Fiber は onExit の中で、再試行の待ちは起きた後に呼ぶ
Actors == {<<"push", 0>>, <<"flush", 0>>} \cup {<<"call", c>> : c \in CallIds} \cup {<<"sleeper", s>> : s \in SleeperIds}

Init ==
  /\ pending = <<>>
  /\ known = {}
  /\ reflecting = <<>>
  /\ inFlight = [kind |-> "none", id |-> NoCall]
  /\ status = "running"
  /\ retryEnabled = TRUE
  /\ calls = [c \in CallIds |-> [pc |-> "unborn", fresh |-> <<>>]]
  /\ nextCall = 1
  /\ sleepers = [s \in SleeperIds |-> "unborn"]
  /\ nextSleeper = 1
  /\ pusher = [pc |-> "append", i |-> 1]
  /\ flusher = "waiting"
  /\ starts = [a \in Actors |-> NoCall]
  /\ lifecycleN = 0
  /\ pauses = 0

-----------------------------------------------------------------------------
(* startDiffIfReady（session.ts:473–487）。2 歩に分かれる。
   1 歩目（:478）: 条件を見て、たまった発言を取り、予約の印を置く。fork した呼び出しはすぐ動き出せる（startImmediately）。
   2 歩目（:484）: 印が自分のものなら、running に置き換える。 *)
Ready(retry) ==
  /\ inFlight.kind = "none"
  /\ Len(pending) > 0
  /\ IF retry THEN retryEnabled /\ status = "paused"
              ELSE status \notin {"paused", "stopped"}

\* takeFresh（:435）: たまりの印があれば先頭 CatchUp 件、無ければ全部。どちらになるかは印の有無で決まるが、ここでは両方を許す
TakeSizes == {Len(pending)} \cup {IF Len(pending) < CatchUp THEN Len(pending) ELSE CatchUp}

\* base は、呼び出す者が呼び出しの Fiber のとき、その pc を進めた calls
StartTake(a, retry, base) ==
  /\ Ready(retry)
  /\ \E n \in TakeSizes :
       /\ pending' = Drop(pending, n)
       /\ calls' = [base EXCEPT ![nextCall] = [pc |-> "begin", fresh |-> Take(pending, n)]]
  /\ inFlight' = [kind |-> "reserved", id |-> nextCall]
  /\ starts' = [starts EXCEPT ![a] = nextCall]
  /\ nextCall' = nextCall + 1

\* 条件を満たさなければ何もしない
StartSkip(retry) == ~Ready(retry)

StartSwap(a) ==
  /\ starts[a] # NoCall
  /\ inFlight' = IF inFlight = [kind |-> "reserved", id |-> starts[a]]
                   THEN [kind |-> "running", id |-> starts[a]]
                   ELSE inFlight
  /\ starts' = [starts EXCEPT ![a] = NoCall]

-----------------------------------------------------------------------------
\* 取り込み: 発言を 1 件ずつ pending に足し（:662）、続けて startDiffIfReady を呼ぶ（:663）
PushAppend ==
  /\ pusher.pc = "append"
  /\ pusher.i <= Cardinality(Remarks)
  /\ pending' = Append(pending, RemarkSeq[pusher.i])
  /\ pusher' = [pc |-> "start", i |-> pusher.i + 1]
  /\ UNCHANGED <<known, reflecting, inFlight, status, retryEnabled, calls, nextCall, sleepers, nextSleeper, flusher, starts, lifecycleN, pauses>>

PushStart ==
  /\ pusher.pc = "start"
  /\ \/ /\ StartTake(<<"push", 0>>, FALSE, calls)
        /\ pusher' = [pusher EXCEPT !.pc = "swap"]
     \/ /\ StartSkip(FALSE)
        /\ pusher' = [pusher EXCEPT !.pc = "next"]
        /\ UNCHANGED <<pending, calls, inFlight, starts, nextCall>>
  /\ UNCHANGED <<known, reflecting, status, retryEnabled, sleepers, nextSleeper, flusher, lifecycleN, pauses>>

PushSwap ==
  /\ pusher.pc = "swap"
  /\ StartSwap(<<"push", 0>>)
  /\ pusher' = [pusher EXCEPT !.pc = "next"]
  /\ UNCHANGED <<pending, known, reflecting, status, retryEnabled, calls, nextCall, sleepers, nextSleeper, flusher, lifecycleN, pauses>>

PushNext ==
  /\ pusher.pc = "next"
  /\ pusher' = [pusher EXCEPT !.pc = IF pusher.i <= Cardinality(Remarks) THEN "append" ELSE "done"]
  /\ UNCHANGED <<pending, known, reflecting, inFlight, status, retryEnabled, calls, nextCall, sleepers, nextSleeper, flusher, starts, lifecycleN, pauses>>

-----------------------------------------------------------------------------
(* 呼び出しの Fiber（runCall :503 と callUpdater :522）。 *)
CallUnchanged == UNCHANGED <<nextCall, sleepers, nextSleeper, pusher, flusher, lifecycleN, pauses>>

\* :527 結果待ちの発言に載せる
CallBegin(c) ==
  /\ calls[c].pc = "begin"
  /\ reflecting' = calls[c].fresh
  /\ calls' = [calls EXCEPT ![c].pc = "update"]
  /\ UNCHANGED <<pending, known, inFlight, status, retryEnabled, starts>> /\ CallUnchanged

ResumeIfPaused == IF status = "paused" THEN "running" ELSE status

\* :618–632 成功。processedRemarks（1..fresh の件数）件を反映し、残りを pending の先頭へ戻す
CallSucceed(c) ==
  /\ calls[c].pc = "update"
  /\ \E k \in 1..Len(calls[c].fresh) :
       /\ known' = known \cup Range(Take(calls[c].fresh, k))
       /\ pending' = Drop(calls[c].fresh, k) \o pending
  /\ status' = ResumeIfPaused
  /\ reflecting' = <<>>
  /\ calls' = [calls EXCEPT ![c].pc = "exitClear"]
  /\ UNCHANGED <<inFlight, retryEnabled, starts>> /\ CallUnchanged

\* :613 失敗（一時停止・停止以外。Apple の再起動中も含む）。渡した発言は処理済みにして進む
CallFail(c) ==
  /\ calls[c].pc = "update"
  /\ known' = known \cup Range(calls[c].fresh)
  /\ status' = ResumeIfPaused
  /\ reflecting' = <<>>
  /\ calls' = [calls EXCEPT ![c].pc = "exitClear"]
  /\ UNCHANGED <<pending, inFlight, retryEnabled, starts>> /\ CallUnchanged

\* :598–610 一時停止（cloud だけ）。渡した発言を pending の先頭へ戻す
CallPause(c) ==
  /\ Kind = "cloud"
  /\ calls[c].pc = "update"
  /\ pauses < MaxPauses
  /\ pending' = calls[c].fresh \o pending
  /\ status' = "paused"
  /\ reflecting' = <<>>
  /\ calls' = [calls EXCEPT ![c].pc = "exitClear"]
  /\ pauses' = pauses + 1
  /\ UNCHANGED <<known, inFlight, retryEnabled, starts, nextCall, sleepers, nextSleeper, pusher, flusher, lifecycleN>>

\* :593–596 停止（apple だけ）。発言を戻す歩（:594）と、状態を stopped にする歩（:595 setLifecycleState）に分かれる
CallStop(c) ==
  /\ Kind = "apple"
  /\ calls[c].pc = "update"
  /\ pending' = calls[c].fresh \o pending
  /\ reflecting' = <<>>
  /\ calls' = [calls EXCEPT ![c].pc = "stopping"]
  /\ UNCHANGED <<known, inFlight, status, retryEnabled, starts>> /\ CallUnchanged

\* setLifecycleState（:456–461）: stopped か同じ状態なら変えない
SetLifecycle(s) == IF status = "stopped" \/ status = s THEN status ELSE s

CallStopped(c) ==
  /\ calls[c].pc = "stopping"
  /\ status' = SetLifecycle("stopped")
  /\ calls' = [calls EXCEPT ![c].pc = "exitClear"]
  /\ UNCHANGED <<pending, known, reflecting, inFlight, retryEnabled, starts>> /\ CallUnchanged

\* :507 印を外す
CallExitClear(c) ==
  /\ calls[c].pc = "exitClear"
  /\ inFlight' = [kind |-> "none", id |-> NoCall]
  /\ calls' = [calls EXCEPT ![c].pc = "exitRead"]
  /\ UNCHANGED <<pending, known, reflecting, status, retryEnabled, starts>> /\ CallUnchanged

\* :509–514 状態を読み、一時停止なら再試行を予約し、そうでなければ続きを呼ぶ
CallExitRead(c) ==
  /\ calls[c].pc = "exitRead"
  /\ calls' = [calls EXCEPT ![c].pc = IF status = "paused" THEN "schedule" ELSE "start"]
  /\ UNCHANGED <<pending, known, reflecting, inFlight, status, retryEnabled, starts>> /\ CallUnchanged

\* scheduleRetry（:491–499）: retryEnabled を読む歩で、許されていれば待ちの Fiber を fork する
CallSchedule(c) ==
  /\ calls[c].pc = "schedule"
  /\ IF retryEnabled
       THEN /\ sleepers' = [sleepers EXCEPT ![nextSleeper] = "sleeping"]
            /\ nextSleeper' = nextSleeper + 1
       ELSE UNCHANGED <<sleepers, nextSleeper>>
  /\ calls' = [calls EXCEPT ![c].pc = "done"]
  /\ UNCHANGED <<pending, known, reflecting, inFlight, status, retryEnabled, nextCall, pusher, flusher, starts, lifecycleN, pauses>>

\* :514 続きを呼ぶ（startDiffIfReady()）
CallStart(c) ==
  /\ calls[c].pc = "start"
  /\ \/ StartTake(<<"call", c>>, FALSE, [calls EXCEPT ![c].pc = "swap"])
     \/ /\ StartSkip(FALSE)
        /\ calls' = [calls EXCEPT ![c].pc = "done"]
        /\ UNCHANGED <<pending, inFlight, starts, nextCall>>
  /\ UNCHANGED <<known, reflecting, status, retryEnabled, sleepers, nextSleeper, pusher, flusher, lifecycleN, pauses>>

CallSwap(c) ==
  /\ calls[c].pc = "swap"
  /\ StartSwap(<<"call", c>>)
  /\ calls' = [calls EXCEPT ![c].pc = "done"]
  /\ UNCHANGED <<pending, known, reflecting, status, retryEnabled, nextCall, sleepers, nextSleeper, pusher, flusher, lifecycleN, pauses>>

-----------------------------------------------------------------------------
\* 再試行の待ち（:498）: 待ち終えたら startDiffIfReady(true) を呼ぶ
SleeperWake(s) ==
  /\ sleepers[s] = "sleeping"
  /\ \/ /\ StartTake(<<"sleeper", s>>, TRUE, calls)
        /\ sleepers' = [sleepers EXCEPT ![s] = "swap"]
     \/ /\ StartSkip(TRUE)
        /\ sleepers' = [sleepers EXCEPT ![s] = "done"]
        /\ UNCHANGED <<pending, calls, inFlight, starts, nextCall>>
  /\ UNCHANGED <<known, reflecting, status, retryEnabled, nextSleeper, pusher, flusher, lifecycleN, pauses>>

SleeperSwap(s) ==
  /\ sleepers[s] = "swap"
  /\ StartSwap(<<"sleeper", s>>)
  /\ sleepers' = [sleepers EXCEPT ![s] = "done"]
  /\ UNCHANGED <<pending, known, reflecting, status, retryEnabled, calls, nextCall, nextSleeper, pusher, flusher, lifecycleN, pauses>>

-----------------------------------------------------------------------------
(* flush（:680–692）。取り込みを止めて読み終えた後（sessions.ts stopLive の drain の後）に呼ばれる。
   idle（:640–648）: 印が無ければ抜け、予約の印だけなら順番を譲り、running なら Fiber の終わりを待つ。 *)
FlushUnchanged == UNCHANGED <<pending, known, reflecting, inFlight, status, calls, nextCall, sleepers, nextSleeper, pusher, starts, lifecycleN, pauses>>

FlushBegin ==
  /\ flusher = "waiting"
  /\ pusher.pc = "done"
  /\ retryEnabled' = FALSE
  /\ flusher' = "idle"
  /\ FlushUnchanged

FlushIdle ==
  /\ flusher = "idle"
  /\ \/ /\ inFlight.kind = "none"
        /\ flusher' = "check"
     \/ /\ inFlight.kind = "running"
        /\ calls[inFlight.id].pc = "done"
        /\ flusher' = "idle"
  /\ UNCHANGED retryEnabled /\ FlushUnchanged

\* :686–691 呼び出し中の印があれば idle に戻る。たまりが無いか、一時停止・停止なら抜ける。そうでなければ startDiffIfReady() を呼んで idle に戻る
FlushCheck ==
  /\ flusher = "check"
  /\ flusher' = IF inFlight.kind # "none" THEN "idle"
                ELSE IF Len(pending) = 0 \/ status \in {"paused", "stopped"} THEN "returned" ELSE "start"
  /\ UNCHANGED <<pending, known, reflecting, inFlight, status, retryEnabled, calls, nextCall, sleepers, nextSleeper, pusher, starts, lifecycleN, pauses>>

FlushStart ==
  /\ flusher = "start"
  /\ \/ /\ StartTake(<<"flush", 0>>, FALSE, calls)
        /\ flusher' = "swap"
     \/ /\ StartSkip(FALSE)
        /\ flusher' = "idle"
        /\ UNCHANGED <<pending, calls, inFlight, starts, nextCall>>
  /\ UNCHANGED <<known, reflecting, status, retryEnabled, sleepers, nextSleeper, pusher, lifecycleN, pauses>>

FlushSwap ==
  /\ flusher = "swap"
  /\ StartSwap(<<"flush", 0>>)
  /\ flusher' = "idle"
  /\ UNCHANGED <<pending, known, reflecting, status, retryEnabled, calls, nextCall, sleepers, nextSleeper, pusher, lifecycleN, pauses>>

-----------------------------------------------------------------------------
\* lifecycle（:462–464、apple だけ）: Apple Intelligence の子プロセスの再起動（appleDiffUpdater.ts:36–52）。どの時点にも割り込む
Lifecycle ==
  /\ Kind = "apple"
  /\ \/ /\ lifecycleN < MaxLifecycle
        /\ \E s \in {"running", "restarting"} : status' = SetLifecycle(s)
        /\ lifecycleN' = lifecycleN + 1
     \/ /\ status' = SetLifecycle("stopped")
        /\ UNCHANGED lifecycleN
  /\ status' # status
  /\ UNCHANGED <<pending, known, reflecting, inFlight, retryEnabled, calls, nextCall, sleepers, nextSleeper, pusher, flusher, starts, pauses>>

-----------------------------------------------------------------------------
Next ==
  \/ PushAppend \/ PushStart \/ PushSwap \/ PushNext
  \/ \E c \in CallIds :
       \/ CallBegin(c) \/ CallSucceed(c) \/ CallFail(c) \/ CallPause(c) \/ CallStop(c) \/ CallStopped(c)
       \/ CallExitClear(c) \/ CallExitRead(c) \/ CallSchedule(c) \/ CallStart(c) \/ CallSwap(c)
  \/ \E s \in SleeperIds : SleeperWake(s) \/ SleeperSwap(s)
  \/ FlushBegin \/ FlushIdle \/ FlushCheck \/ FlushStart \/ FlushSwap
  \/ Lifecycle

\* 差分更新の外の世界（API・子プロセス）は止まらず、どの Fiber もいつかは動く。呼び出しの結果は何でもよい
Fairness ==
  /\ WF_vars(PushAppend \/ PushStart \/ PushSwap \/ PushNext)
  /\ \A c \in CallIds :
       /\ WF_vars(CallBegin(c) \/ CallSucceed(c) \/ CallFail(c) \/ CallPause(c) \/ CallStop(c) \/ CallStopped(c))
       /\ WF_vars(CallExitClear(c) \/ CallExitRead(c) \/ CallSchedule(c) \/ CallStart(c) \/ CallSwap(c))
  /\ \A s \in SleeperIds : WF_vars(SleeperWake(s) \/ SleeperSwap(s))
  /\ WF_vars(FlushBegin \/ FlushIdle \/ FlushCheck \/ FlushStart \/ FlushSwap)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
Updating == {c \in CallIds : calls[c].pc \in {"begin", "update"}}
Held == UNION {Range(calls[c].fresh) : c \in Updating}
Pushed == {RemarkSeq[i] : i \in 1..(pusher.i - 1)}

TypeOK ==
  /\ status \in {"running", "restarting", "paused", "stopped"}
  /\ inFlight.kind \in {"none", "reserved", "running"}
  /\ retryEnabled \in BOOLEAN

\* 差分更新を同時に 2 つ呼ばない
InvOneCallAtATime == Cardinality(Updating) <= 1

\* 呼び出し中の印は、終わった呼び出しを指さない（指したままだと idle が抜けられず、次の呼び出しも始まらない）
InvNoStaleInFlight == inFlight.kind = "running" => calls[inFlight.id].pc # "done"

\* 入った発言は、たまり・呼び出し中・反映済み（処理済み）のちょうど 1 か所にある。取りこぼしも二重の反映もない
InvRemarksConserved ==
  /\ Range(pending) \cup Held \cup known = Pushed
  /\ Range(pending) \cap Held = {}
  /\ Range(pending) \cap known = {}
  /\ Held \cap known = {}
  /\ Cardinality(Range(pending)) = Len(pending)

\* flush が抜けた後は、呼び出しは残っておらず、新しく始まることもない。止まっていなければ、たまりも空
InvQuietAfterFlush ==
  flusher = "returned" =>
    /\ inFlight.kind = "none"
    /\ Updating = {}
    /\ status \notin {"paused", "stopped"} => Len(pending) = 0

\* stopped からは戻らない
PropStoppedStays == [][status = "stopped" => status' = "stopped"]_vars

\* flush はいつか抜ける（終了が止まらない）
PropFlushReturns == (pusher.pc = "done") ~> (flusher = "returned")
=============================================================================
