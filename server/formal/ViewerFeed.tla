----------------------------- MODULE ViewerFeed -----------------------------
(* 画面への配信（server/src/viewers.ts の Viewers と、web/src/liveFeed.ts・web/src/app/liveFeed/subscription.ts の受け取り）のモデル。
   1 つの遷移は、コードで割り込まれない 1 歩（Ref.update・Ref.get・PubSub.publish・PubSub.subscribe・PubSub.takeAll と writer への書き込み、
   ブラウザでの 1 通の受け取り）に当たる。Effect 4 の Fiber は MaxOpsBeforeYield ごとに順番を譲るので、
   send（viewers.ts:41-45）が Effect.uninterruptible でも、Ref.update と PubSub.publish の間に他の Fiber が入れる。
   セッションは 1 つ。フレームの種類は intake（web が接続し直しても消さない種類）と screen-notice（web が接続・切断で消す種類）の 2 つ。
   含めないもの: drained（サーバーの終わり）、サーバーの再起動（retained が空になる）、snapshot など他の種類、
   フレームの中身の新しさ（どの値を送るかを決める側の順序）、字幕の期限、JSON の読み違い。 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Viewers,          \* 開いている画面（ブラウザのタブ）
  WithResume,       \* TRUE なら resume（sessions.ts:553）が intake を送る
  MaxDisconnects    \* 状態空間を有限にするための、画面ごとの切断の数の上限

Kinds == {"intake", "screen-notice"}
NoValue == "absent"
\* 送る側。kind・value は送るフレーム、inScope はセッションの Scope に fork された Fiber か（Scope を閉じると中断される）
SenderInfo == [
  observe     |-> [kind |-> "intake", value |-> "running", inScope |-> TRUE],          \* sessions.ts:250（runLive の observe、intakeAttempts.ts:155 で Scope に fork）。前の取り込みの observe は resume が sessions.ts:547 で終わりを待つので重ならない
  notice      |-> [kind |-> "screen-notice", value |-> "text", inScope |-> TRUE],     \* sessions.ts:226（applyEvent の screen-off、取り込みの Fiber）
  noticeClear |-> [kind |-> "screen-notice", value |-> "null", inScope |-> TRUE],     \* sessions.ts:227-230（SCREEN_NOTICE_MS 後に消す、live.scope に fork）
  resume      |-> [kind |-> "intake", value |-> "interrupted", inScope |-> TRUE]      \* sessions.ts:553（resume が sessions.ts:550 で live.scope に fork した Fiber）
]
Senders == IF WithResume THEN {"observe", "notice", "noticeClear", "resume"} ELSE {"observe", "notice", "noticeClear"}
\* セッションの Scope を閉じたときに送る終わりの値（viewers.ts:11-24 の END_FRAMES）
End == [k \in Kinds |-> IF k = "intake" THEN "none" ELSE "null"]
\* createFeedState の後に applyOpen した画面の値（liveFeed.ts:6・11・36-37）
WebInit == [k \in Kinds |-> IF k = "intake" THEN "running" ELSE "null"]
Values == {"running", "interrupted", "stopped", "none", "text", "null"}
Frames == Kinds \X Values

VARIABLES
  retained,   \* viewers.ts:37 の retained（種類ごとの最後に送った値。無ければ NoValue）
  sent,       \* viewers.ts:48 の sent（このセッションで送った種類）
  pc,         \* 送る側の Fiber ごとの位置
  sess,       \* セッション: open → stopping（stop が取った）→ ending（Scope を閉じて forSession の finalizer）→ closed
  endTodo,    \* finalizer が読んだ sent のうち、終わりの値をまだ送っていない種類
  endStored,  \* finalizer が retained に入れて、まだ publish していない種類（無ければ NoValue）
  conn,       \* 画面ごとの server 側の connect の位置
  sub,        \* 画面ごとの PubSub の購読に溜まったフレーム
  snap,       \* 画面ごとに connect が読んだ retained
  sock,       \* 画面ごとの WebSocket に書いて、ブラウザがまだ受け取っていないフレーム
  webOpen,    \* ブラウザの WebSocket が開いているか
  web,        \* ブラウザの FeedState の該当する値
  disconnects,
  lateSend    \* forSession の finalizer が sent を読んだ後に、send が sent に種類を足したか

vars == <<retained, sent, pc, sess, endTodo, endStored, conn, sub, snap, sock, webOpen, web, disconnects, lateSend>>

ApplyOpen(w) == [k \in Kinds |-> IF k = "screen-notice" THEN "null" ELSE w[k]]   \* liveFeed.ts:36-37
ApplyClose(w) == [k \in Kinds |-> IF k = "screen-notice" THEN "null" ELSE w[k]]  \* liveFeed.ts:40-41
\* retainedFrames（viewers.ts:26-29）: END_FRAMES のキーの順に、retained にある種類を並べる
RetainedSeq(r) ==
  LET ik == IF r["intake"] # NoValue THEN <<<<"intake", r["intake"]>>>> ELSE <<>>
      sk == IF r["screen-notice"] # NoValue THEN <<<<"screen-notice", r["screen-notice"]>>>> ELSE <<>>
  IN ik \o sk
\* 後から開いた画面が見る値
Fresh(k) == IF retained[k] # NoValue THEN retained[k] ELSE ApplyOpen(WebInit)[k]

Publish(f) == sub' = [v \in Viewers |-> IF sub[v] = "off" THEN "off" ELSE Append(sub[v], f)]

TypeOK ==
  /\ retained \in [Kinds -> Values \cup {NoValue}]
  /\ sent \subseteq Kinds
  /\ pc \in [Senders -> {"idle", "checked", "forked", "marked", "stored", "done", "interrupted"}]
  /\ sess \in {"open", "stopping", "ending", "endRead", "closed"}
  /\ endTodo \subseteq Kinds
  /\ endStored \in Kinds \cup {NoValue}
  /\ conn \in [Viewers -> {"off", "upgraded", "subscribed", "read", "live"}]
  /\ \A v \in Viewers : sub[v] = "off" \/ sub[v] \in Seq(Frames)
  /\ \A v \in Viewers : sock[v] \in Seq(Frames)
  /\ webOpen \in [Viewers -> BOOLEAN]
  /\ web \in [Viewers -> [Kinds -> Values]]
  /\ disconnects \in [Viewers -> 0..MaxDisconnects]
  /\ lateSend \in BOOLEAN

Init ==
  /\ retained = [k \in Kinds |-> NoValue]
  /\ sent = {}
  /\ pc = [s \in Senders |-> "idle"]
  /\ sess = "open"
  /\ endTodo = {}
  /\ endStored = NoValue
  /\ conn = [v \in Viewers |-> "off"]
  /\ sub = [v \in Viewers |-> "off"]
  /\ snap = [v \in Viewers |-> [k \in Kinds |-> NoValue]]
  /\ sock = [v \in Viewers |-> <<>>]
  /\ webOpen = [v \in Viewers |-> FALSE]
  /\ web = [v \in Viewers |-> WebInit]   \* createFeedState（liveFeed.ts:10-12）
  /\ disconnects = [v \in Viewers |-> 0]
  /\ lateSend = FALSE

ViewerVars == <<conn, sub, snap, sock, webOpen, web, disconnects>>

(* ---- 送る側 ---- *)

\* resume は Ref.get(state) で live を確かめてから（sessions.ts:548-549）、送る歩を live.scope に fork する（sessions.ts:550）。
\* fork の後の runLive・Ref.set は state を見ない
ResumeCheck(s) ==
  /\ s = "resume"
  /\ pc[s] = "idle"
  /\ sess = "open"                     \* sessions.ts:549 beforeRun.kind === "live"
  /\ pc' = [pc EXCEPT ![s] = "checked"]
  /\ UNCHANGED <<retained, sent, sess, endTodo, endStored, lateSend, ViewerVars>>

\* 閉じた Scope への forkIn は Fiber を始めずに中断する（effect/src/internal/effect.ts:5698-5707）。resume は送らずに Aborted を返す
ResumeFork(s) ==
  /\ s = "resume"
  /\ pc[s] = "checked"
  /\ pc' = [pc EXCEPT ![s] = IF sess \in {"open", "stopping"} THEN "forked" ELSE "interrupted"]
  /\ UNCHANGED <<retained, sent, sess, endTodo, endStored, lateSend, ViewerVars>>

\* forSession の send の 1 歩目: sent に種類を足す（viewers.ts:56）
SendMark(s) ==
  /\ pc[s] = IF s = "resume" THEN "forked" ELSE "idle"
  /\ SenderInfo[s].inScope => sess \in {"open", "stopping"}     \* Scope を閉じると fork した Fiber は中断され、新しい send は始まらない
  /\ s = "noticeClear" => pc["notice"] = "done"                  \* sessions.ts:226-230: 表示を送ってから、消す Fiber を fork する
  /\ (s = "observe" /\ WithResume) => pc["resume"] \in {"forked", "marked", "stored", "done"}   \* resume があるときの observe は、resume が fork した Fiber の runLive（sessions.ts:551）で始めた取り込みのもの
  /\ pc' = [pc EXCEPT ![s] = "marked"]
  /\ sent' = sent \cup {SenderInfo[s].kind}
  /\ lateSend' = (lateSend \/ sess \in {"endRead", "closed"})
  /\ UNCHANGED <<retained, sess, endTodo, endStored, ViewerVars>>

\* send の 2 歩目: retained を書き換える（viewers.ts:43）
SendStore(s) ==
  /\ pc[s] = "marked"
  /\ pc' = [pc EXCEPT ![s] = "stored"]
  /\ retained' = [retained EXCEPT ![SenderInfo[s].kind] = SenderInfo[s].value]
  /\ UNCHANGED <<sent, sess, endTodo, endStored, lateSend, ViewerVars>>

\* send の 3 歩目: 購読している画面に配る（viewers.ts:44）
SendPublish(s) ==
  /\ pc[s] = "stored"
  /\ pc' = [pc EXCEPT ![s] = "done"]
  /\ Publish(<<SenderInfo[s].kind, SenderInfo[s].value>>)
  /\ UNCHANGED <<retained, sent, sess, endTodo, endStored, lateSend, conn, snap, sock, webOpen, web, disconnects>>

(* ---- セッションの終わり ---- *)

\* stop が state を stopping にする（sessions.ts:139）
Stop ==
  /\ sess = "open"
  /\ sess' = "stopping"
  /\ UNCHANGED <<retained, sent, pc, endTodo, endStored, lateSend, ViewerVars>>

\* closeSession の Scope.close（sessions.ts:345）。Scope は sequential なので、forSession の finalizer（sessions.ts:266 で最初に足した）より先に、
\* 後から fork した Fiber を中断して待つ。send は uninterruptible なので、途中の send は終わってから中断される
CloseScope ==
  /\ sess = "stopping"
  /\ \A s \in Senders : SenderInfo[s].inScope => pc[s] \notin {"marked", "stored"}
  /\ pc' = [s \in Senders |-> IF SenderInfo[s].inScope /\ pc[s] \in {"idle", "forked"} THEN "interrupted" ELSE pc[s]]
  /\ sess' = "ending"
  /\ UNCHANGED <<retained, sent, endTodo, endStored, lateSend, ViewerVars>>

\* finalizer が sent を読む（viewers.ts:50）
EndReadSent ==
  /\ sess = "ending"
  /\ endTodo' = sent
  /\ sess' = "endRead"
  /\ UNCHANGED <<retained, sent, pc, endStored, lateSend, ViewerVars>>

\* 終わりの値を send する 1 歩目: retained（viewers.ts:52 → 43）
EndStore(k) ==
  /\ sess = "endRead"
  /\ endStored = NoValue
  /\ k \in endTodo
  /\ End[k] # "keep"
  /\ retained' = [retained EXCEPT ![k] = End[k]]
  /\ endStored' = k
  /\ UNCHANGED <<sent, pc, sess, endTodo, lateSend, ViewerVars>>

\* 2 歩目: publish（viewers.ts:52 → 44）
EndPublish ==
  /\ sess = "endRead"
  /\ endStored # NoValue
  /\ Publish(<<endStored, End[endStored]>>)
  /\ endTodo' = endTodo \ {endStored}
  /\ endStored' = NoValue
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, conn, snap, sock, webOpen, web, disconnects>>

EndDone ==
  /\ sess = "endRead"
  /\ endTodo = {}
  /\ endStored = NoValue
  /\ sess' = "closed"
  /\ UNCHANGED <<retained, sent, pc, endTodo, endStored, lateSend, ViewerVars>>

(* ---- 画面 ---- *)

\* ブラウザが WebSocket を開く（subscription.ts:33-35 の onopen → applyOpen）。切断の後は RECONNECT_MS 後に開き直す（subscription.ts:67-68）
Open(v) ==
  /\ conn[v] = "off"
  /\ ~webOpen[v]
  /\ conn' = [conn EXCEPT ![v] = "upgraded"]
  /\ webOpen' = [webOpen EXCEPT ![v] = TRUE]
  /\ web' = [web EXCEPT ![v] = ApplyOpen(web[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, sub, snap, sock, disconnects>>

\* connect: 購読する（viewers.ts:75）
Subscribe(v) ==
  /\ conn[v] = "upgraded"
  /\ conn' = [conn EXCEPT ![v] = "subscribed"]
  /\ sub' = [sub EXCEPT ![v] = <<>>]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, snap, sock, webOpen, web, disconnects>>

\* connect: retained を読む（viewers.ts:77 の Ref.get）
ReadRetained(v) ==
  /\ conn[v] = "subscribed"
  /\ conn' = [conn EXCEPT ![v] = "read"]
  /\ snap' = [snap EXCEPT ![v] = retained]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, sub, sock, webOpen, web, disconnects>>

\* connect: 読んだ retained を書く（viewers.ts:77 の writer.write）。この後 deliver に入る（viewers.ts:78）
WriteRetained(v) ==
  /\ conn[v] = "read"
  /\ conn' = [conn EXCEPT ![v] = "live"]
  /\ sock' = [sock EXCEPT ![v] = sock[v] \o RetainedSeq(snap[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, sub, snap, webOpen, web, disconnects>>

\* deliver: 購読に溜まったものをまとめて取り、書く（viewers.ts:63-65）
Deliver(v) ==
  /\ conn[v] = "live"
  /\ sub[v] # <<>>
  /\ sock' = [sock EXCEPT ![v] = sock[v] \o sub[v]]
  /\ sub' = [sub EXCEPT ![v] = <<>>]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, conn, snap, webOpen, web, disconnects>>

\* ブラウザが 1 通受け取って applyFrame する（subscription.ts:36 → liveFeed.ts:20-21）
Receive(v) ==
  /\ webOpen[v]
  /\ sock[v] # <<>>
  /\ web' = [web EXCEPT ![v][Head(sock[v])[1]] = Head(sock[v])[2]]
  /\ sock' = [sock EXCEPT ![v] = Tail(sock[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, conn, sub, snap, webOpen, disconnects>>

\* 切断: ブラウザは onclose で applyClose（subscription.ts:37-40 → liveFeed.ts:40-41）。server は reader.pull の失敗で raceFirst を抜け、
\* Effect.scoped が購読を外す（viewers.ts:78-79）。まだ受け取っていないフレームは届かない
Disconnect(v) ==
  /\ webOpen[v]
  /\ disconnects[v] < MaxDisconnects
  /\ disconnects' = [disconnects EXCEPT ![v] = @ + 1]
  /\ conn' = [conn EXCEPT ![v] = "off"]
  /\ sub' = [sub EXCEPT ![v] = "off"]
  /\ sock' = [sock EXCEPT ![v] = <<>>]
  /\ webOpen' = [webOpen EXCEPT ![v] = FALSE]
  /\ web' = [web EXCEPT ![v] = ApplyClose(web[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, endTodo, endStored, lateSend, snap>>

Next ==
  \/ \E s \in Senders : ResumeCheck(s) \/ ResumeFork(s) \/ SendMark(s) \/ SendStore(s) \/ SendPublish(s)
  \/ Stop \/ CloseScope \/ EndReadSent \/ (\E k \in Kinds : EndStore(k)) \/ EndPublish \/ EndDone
  \/ \E v \in Viewers : Open(v) \/ Subscribe(v) \/ ReadRetained(v) \/ WriteRetained(v) \/ Deliver(v) \/ Receive(v) \/ Disconnect(v)

Spec == Init /\ [][Next]_vars

(* ---- 性質 ---- *)

\* 送る途中の send が無く、終わりの値を送る途中でもなく、つながっている画面には届いていないフレームが無い
Quiescent ==
  /\ \A s \in Senders : pc[s] \notin {"checked", "forked", "marked", "stored"}
  /\ sess \in {"open", "stopping", "closed"}
  /\ \A v \in Viewers : conn[v] \in {"off", "live"}
  /\ \A v \in Viewers : conn[v] = "live" => sub[v] = <<>> /\ sock[v] = <<>>

\* 静まったら、つながっている画面の各種類の値は、後から開いた画面が見る値と同じ
InvViewersMatchRetained ==
  Quiescent => \A v \in Viewers : conn[v] = "live" => \A k \in Kinds : web[v][k] = Fresh(k)

\* セッションが閉じて静まったら、このセッションで送った種類は終わりの値になっている
InvEndFramesAfterClose ==
  (sess = "closed" /\ Quiescent) => \A k \in sent : retained[k] = End[k]

\* 同じ種類のフレームを、2 つの Fiber が同時に送っていない（send の中の retained の更新と publish の間に、同じ種類の別の send が入らない）
InvSendsSerializedPerKind ==
  \A s1, s2 \in Senders :
    (s1 # s2 /\ SenderInfo[s1].kind = SenderInfo[s2].kind) => ~(pc[s1] \in {"marked", "stored"} /\ pc[s2] \in {"marked", "stored"})

\* forSession の finalizer が終わりの値を決めた後に、そのセッションの send が来ない
InvNoSendAfterEnd == ~lateSend
=============================================================================
