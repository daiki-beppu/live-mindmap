----------------------------- MODULE ViewerFeed -----------------------------
(* 画面への配信（server/src/viewers.ts の Viewers と、web/src/liveFeed.ts・web/src/app/liveFeed/subscription.ts の受け取り）のモデル。
   1 つの遷移は、コードで割り込まれない 1 歩（send・forSession の finalizer・PubSub.subscribe・retained を読む・
   PubSub.takeAll と writer への書き込み、ブラウザでの 1 通の受け取り）に当たる。send（viewers.ts:55-58）と
   finalizer（viewers.ts:50-54）は Effect.sync の中で sent・retained・PubSub.publishUnsafe をまとめて行うので、間に他の Fiber は入れない。
   セッションは 1 つ。フレームの種類は intake（web が接続し直しても消さない種類）と screen-notice（web が接続・切断で消す種類）の 2 つ。
   含めないもの: drained（サーバーの終わり）、サーバーの再起動（retained が空になる）、snapshot など他の種類、
   フレームの中身の新しさ（どの値を送るかを決める側の順序）、字幕の期限、JSON の読み違い。 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Viewers,          \* 開いている画面（ブラウザのタブ）
  WithResume,       \* TRUE なら showIntake が intake を 2 回続けて送る（resume の interrupted の後に、resume が始めた取り込みの running）
  MaxDisconnects    \* 状態空間を有限にするための、画面ごとの切断の数の上限

Kinds == {"intake", "screen-notice"}
NoValue == "absent"
\* 送る側。kind・value は送るフレーム、inScope はセッションの Scope に fork された Fiber か（Scope を閉じると中断される）
\* intake を送るのは showIntake（sessions.ts:50-52、start が sessions.ts:332 で Scope に fork）だけで、1 つの Fiber が live.intake の変化を順に送る
SenderInfo == [
  showInterrupted |-> [kind |-> "intake", value |-> "interrupted", inScope |-> TRUE],  \* showIntake の 1 回目（取り込みが途切れた、または resume が interrupted にした）
  showRunning     |-> [kind |-> "intake", value |-> "running", inScope |-> TRUE],      \* showIntake の 2 回目（resume が始めた取り込みがつながった）。1 回目を送り終えてから
  notice          |-> [kind |-> "screen-notice", value |-> "text", inScope |-> TRUE],  \* sessions.ts:231（applyEvent の screen-off、取り込みの Fiber）
  noticeClear     |-> [kind |-> "screen-notice", value |-> "null", inScope |-> TRUE]   \* sessions.ts:232-235（SCREEN_NOTICE_MS 後に消す、live.scope に fork）
]
Senders == IF WithResume THEN {"showInterrupted", "showRunning", "notice", "noticeClear"} ELSE {"showInterrupted", "notice", "noticeClear"}
\* 送る側が送っていない位置（送る前・送り終えた・中断された）
Resting == {"idle", "done", "interrupted"}
\* セッションの Scope を閉じたときに送る終わりの値（viewers.ts:12-25 の END_FRAMES）
End == [k \in Kinds |-> IF k = "intake" THEN "none" ELSE "null"]
\* createFeedState の後に applyOpen した画面の値（liveFeed.ts:6・11・36-37）
WebInit == [k \in Kinds |-> IF k = "intake" THEN "running" ELSE "null"]
Values == {"running", "interrupted", "stopped", "none", "text", "null"}
Frames == Kinds \X Values

VARIABLES
  retained,   \* viewers.ts:38 の retained（種類ごとの最後に送った値。無ければ NoValue）
  sent,       \* viewers.ts:49 の sent（このセッションで送った種類）
  pc,         \* 送る側の Fiber ごとの位置
  sess,       \* セッション: open → stopping（stop が取った）→ ending（Scope を閉じて、forSession の finalizer の前）→ closed
  conn,       \* 画面ごとの server 側の connect の位置
  sub,        \* 画面ごとの PubSub の購読に溜まったフレーム
  snap,       \* 画面ごとに connect が読んだ retained
  sock,       \* 画面ごとの WebSocket に書いて、ブラウザがまだ受け取っていないフレーム
  webOpen,    \* ブラウザの WebSocket が開いているか
  web,        \* ブラウザの FeedState の該当する値
  disconnects,
  lateSend    \* forSession の finalizer が終わりの値を送った後に、send が来たか

vars == <<retained, sent, pc, sess, conn, sub, snap, sock, webOpen, web, disconnects, lateSend>>

ApplyOpen(w) == [k \in Kinds |-> IF k = "screen-notice" THEN "null" ELSE w[k]]   \* liveFeed.ts:36-37
ApplyClose(w) == [k \in Kinds |-> IF k = "screen-notice" THEN "null" ELSE w[k]]  \* liveFeed.ts:40-41
\* retainedFrames（viewers.ts:27-30）と finalizer（viewers.ts:51）: END_FRAMES のキーの順に、値のある種類を並べる
RetainedSeq(r) ==
  LET ik == IF r["intake"] # NoValue THEN <<<<"intake", r["intake"]>>>> ELSE <<>>
      sk == IF r["screen-notice"] # NoValue THEN <<<<"screen-notice", r["screen-notice"]>>>> ELSE <<>>
  IN ik \o sk
\* 後から開いた画面が見る値
Fresh(k) == IF retained[k] # NoValue THEN retained[k] ELSE ApplyOpen(WebInit)[k]

Publish(fs) == sub' = [v \in Viewers |-> IF sub[v] = "off" THEN "off" ELSE sub[v] \o fs]

TypeOK ==
  /\ retained \in [Kinds -> Values \cup {NoValue}]
  /\ sent \subseteq Kinds
  /\ pc \in [Senders -> Resting]
  /\ sess \in {"open", "stopping", "ending", "closed"}
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

\* forSession の send（viewers.ts:55-58）: sent に種類を足し、retained を書き換え、購読している画面に配る。1 歩
Send(s) ==
  /\ pc[s] = "idle"
  /\ s = "noticeClear" => pc["notice"] = "done"                  \* sessions.ts:231-235: 表示を送ってから、消す Fiber を fork する
  /\ s = "showRunning" => pc["showInterrupted"] = "done"         \* showIntake は 1 つの Fiber で、changes を順に読んで送る
  /\ pc' = [pc EXCEPT ![s] = "done"]
  /\ sent' = sent \cup {SenderInfo[s].kind}
  /\ retained' = [retained EXCEPT ![SenderInfo[s].kind] = SenderInfo[s].value]
  /\ Publish(<<<<SenderInfo[s].kind, SenderInfo[s].value>>>>)
  /\ lateSend' = (lateSend \/ sess = "closed")
  /\ UNCHANGED <<sess, conn, snap, sock, webOpen, web, disconnects>>

(* ---- セッションの終わり ---- *)

\* stop が state を stopping にする（sessions.ts:144）
Stop ==
  /\ sess = "open"
  /\ sess' = "stopping"
  /\ UNCHANGED <<retained, sent, pc, lateSend, ViewerVars>>

\* closeSession の Scope.close（sessions.ts:349）。Scope は sequential なので、forSession の finalizer（sessions.ts:270 で最初に足した）より先に、
\* 後から fork した Fiber を中断して待つ。send は 1 歩なので、送る途中で中断されることはない
CloseScope ==
  /\ sess = "stopping"
  /\ pc' = [s \in Senders |-> IF SenderInfo[s].inScope /\ pc[s] = "idle" THEN "interrupted" ELSE pc[s]]
  /\ sess' = "ending"
  /\ UNCHANGED <<retained, sent, lateSend, ViewerVars>>

\* forSession の finalizer（viewers.ts:50-54）: sent を読み、送った種類の終わりの値を retained に入れて publish する。1 歩
EndFrames ==
  /\ sess = "ending"
  /\ LET ends == [k \in Kinds |-> IF k \in sent /\ End[k] # "keep" THEN End[k] ELSE NoValue] IN
       /\ retained' = [k \in Kinds |-> IF ends[k] # NoValue THEN ends[k] ELSE retained[k]]
       /\ Publish(RetainedSeq(ends))
  /\ sess' = "closed"
  /\ UNCHANGED <<sent, pc, lateSend, conn, snap, sock, webOpen, web, disconnects>>

(* ---- 画面 ---- *)

\* ブラウザが WebSocket を開く（subscription.ts:32-34 の onopen → applyOpen）。切断の後は RECONNECT_MS 後に開き直す（subscription.ts:66-68）
Open(v) ==
  /\ conn[v] = "off"
  /\ ~webOpen[v]
  /\ conn' = [conn EXCEPT ![v] = "upgraded"]
  /\ webOpen' = [webOpen EXCEPT ![v] = TRUE]
  /\ web' = [web EXCEPT ![v] = ApplyOpen(web[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, sub, snap, sock, disconnects>>

\* connect: 購読する（viewers.ts:75）
Subscribe(v) ==
  /\ conn[v] = "upgraded"
  /\ conn' = [conn EXCEPT ![v] = "subscribed"]
  /\ sub' = [sub EXCEPT ![v] = <<>>]
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, snap, sock, webOpen, web, disconnects>>

\* connect: retained を読む（viewers.ts:77 の retainedFrames(retained)）
ReadRetained(v) ==
  /\ conn[v] = "subscribed"
  /\ conn' = [conn EXCEPT ![v] = "read"]
  /\ snap' = [snap EXCEPT ![v] = retained]
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, sub, sock, webOpen, web, disconnects>>

\* connect: 読んだ retained を書く（viewers.ts:77 の writer.write）。この後 deliver に入る（viewers.ts:78）
WriteRetained(v) ==
  /\ conn[v] = "read"
  /\ conn' = [conn EXCEPT ![v] = "live"]
  /\ sock' = [sock EXCEPT ![v] = sock[v] \o RetainedSeq(snap[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, sub, snap, webOpen, web, disconnects>>

\* deliver: 購読に溜まったものをまとめて取り、書く（viewers.ts:63-65）
Deliver(v) ==
  /\ conn[v] = "live"
  /\ sub[v] # <<>>
  /\ sock' = [sock EXCEPT ![v] = sock[v] \o sub[v]]
  /\ sub' = [sub EXCEPT ![v] = <<>>]
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, conn, snap, webOpen, web, disconnects>>

\* ブラウザが 1 通受け取って applyFrame する（subscription.ts:35 → liveFeed.ts:20-21）
Receive(v) ==
  /\ webOpen[v]
  /\ sock[v] # <<>>
  /\ web' = [web EXCEPT ![v][Head(sock[v])[1]] = Head(sock[v])[2]]
  /\ sock' = [sock EXCEPT ![v] = Tail(sock[v])]
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, conn, sub, snap, webOpen, disconnects>>

\* 切断: ブラウザは onclose で applyClose（subscription.ts:36-39 → liveFeed.ts:40-41）。server は reader.pull の失敗で raceFirst を抜け、
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
  /\ UNCHANGED <<retained, sent, pc, sess, lateSend, snap>>

Next ==
  \/ \E s \in Senders : Send(s)
  \/ Stop \/ CloseScope \/ EndFrames
  \/ \E v \in Viewers : Open(v) \/ Subscribe(v) \/ ReadRetained(v) \/ WriteRetained(v) \/ Deliver(v) \/ Receive(v) \/ Disconnect(v)

Spec == Init /\ [][Next]_vars

(* ---- 性質 ---- *)

\* 送る途中の send が無く、Scope を閉じて終わりの値を送る前でもなく、つながっている画面には届いていないフレームが無い
Quiescent ==
  /\ \A s \in Senders : pc[s] \in Resting
  /\ sess \in {"open", "stopping", "closed"}
  /\ \A v \in Viewers : conn[v] \in {"off", "live"}
  /\ \A v \in Viewers : conn[v] = "live" => sub[v] = <<>> /\ sock[v] = <<>>

\* 静まったら、つながっている画面の各種類の値は、後から開いた画面が見る値と同じ
InvViewersMatchRetained ==
  Quiescent => \A v \in Viewers : conn[v] = "live" => \A k \in Kinds : web[v][k] = Fresh(k)

\* セッションが閉じて静まったら、このセッションで送った種類は終わりの値になっている
InvEndFramesAfterClose ==
  (sess = "closed" /\ Quiescent) => \A k \in sent : retained[k] = End[k]

\* 同じ種類のフレームを、2 つの Fiber が同時に送っていない（send の中の retained の更新と publish の間に、同じ種類の別の send が入らない）。
\* 今の send は 1 歩で途中の位置が無いので、send を 2 歩以上に分けたときに破れうる
InvSendsSerializedPerKind ==
  \A s1, s2 \in Senders :
    (s1 # s2 /\ SenderInfo[s1].kind = SenderInfo[s2].kind) => ~(pc[s1] \notin Resting /\ pc[s2] \notin Resting)

\* forSession の finalizer が終わりの値を決めた後に、そのセッションの send が来ない
InvNoSendAfterEnd == ~lateSend
=============================================================================
