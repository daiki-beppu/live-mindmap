---
name: verify-viewer-feed
description: 画面への配信（server/src/viewers.ts の send・forSession・connect・deliver と END_FRAMES、web/src/liveFeed.ts の applyFrame・applyOpen・applyClose、web/src/app/liveFeed/subscription.ts の接続し直し）を変えたとき、またはフレームを送る場所（sessions.ts などの send の呼び出し）を足す・動かすとき、または変える前に、TLA+ のモデルを TLC にかけて、つながっている画面と後から開いた画面が同じものを見る・セッションが閉じたら終わりの値になる・同じ種類を同時に送らない・終わりの後に送らない、が成り立つか確かめる。画面の表示が CLI の status や開き直した画面と食い違う不具合を調べるときにも使う。
---

# 画面への配信を TLC で確かめる

`server/formal/ViewerFeed.tla` は、server が画面（ブラウザのタブ）にフレームを配る仕組みと、画面がそれを受け取る仕組みのモデルです。server 側は `server/src/viewers.ts` の `Viewers`、画面側は `web/src/liveFeed.ts` と `web/src/app/liveFeed/subscription.ts` です。モデルの 1 つの遷移は、コードの中で他の Fiber に割り込まれない 1 歩に当たります。1 歩は `Ref.update`・`Ref.get`・`PubSub.publish`・`PubSub.subscribe`・`PubSub.takeAll` と書き込みの 1 回、またはブラウザが 1 通受け取って `applyFrame` することです。`send`（viewers.ts:41-45）は `Effect.uninterruptible` ですが、割り込まれないだけで、他の Fiber は間に入れます。Effect 4 の Fiber は `MaxOpsBeforeYield`（既定 2048 回）ごとに順番を譲るので、`Ref.update` と `PubSub.publish` の間にも他の Fiber が入ります。遷移ごとの注釈に、対応するコードの行を書いてあります。

送る側は、コードで同じ種類のフレームを送る Fiber ごとに `SenderInfo` に並べてあります。

- `observe`: `runLive` の observe（sessions.ts:250）。Scope の中の Fiber です。
- `notice`・`noticeClear`: 共有画面の知らせ（sessions.ts:226-230）。Scope の中の Fiber です。
- `resume`: `resume`（sessions.ts:552）。HTTP の要求の Fiber で、Scope の外にあります。

`inScope` の送る側は、`closeSession` の `Scope.close`（sessions.ts:345）で中断されて待たれます。待ち終わってから、forSession の finalizer（sessions.ts:266 で Scope に最初に足したので、最後に走る）が終わりの値を送ります。

## 守っている約束

| 性質 | 平易に言うと | 破れたときの害 |
|---|---|---|
| `InvViewersMatchRetained` | 送り終えて静まったら、つながっている画面の各種類の値は、後から開いた画面が見る値（retained）と同じ | 同じ会議を見ている 2 つの画面で、取り込みの状態や知らせが食い違う。開き直すまで古い表示が残る |
| `InvEndFramesAfterClose` | セッションが閉じて静まったら、そのセッションで送った種類は終わりの値（`END_FRAMES`。intake は none）になっている | 会議を止めた後も「取り込みが途切れました」などが画面に残る |
| `InvSendsSerializedPerKind` | 同じ種類のフレームを、2 つの Fiber が同時に送らない（`InvViewersMatchRetained` の前提） | 上の食い違いが起きる |
| `InvNoSendAfterEnd` | forSession の finalizer が終わりの値を決めた後に、そのセッションの send が来ない（`InvEndFramesAfterClose` の前提） | 終わりの値が上書きされて、止めた会議の表示が残る |

構成は 2 つあります（`server/formal/viewer-single.cfg`・`viewer-resume.cfg`）。single は resume を呼ばない会議で、同じ種類を送る Fiber は重なりません。ここで上の 2 つの性質を調べます。resume は、取り込みが止まった後に resume を呼ぶ会議です。ここで下の 2 つ（前提）を調べます。今のコードでは、上の 2 つは成り立ちます。下の 2 つは破れ、「既知の発見」に書いてあります。`server/formal/ViewerFeed.checks` の `known` の行に載っている性質は、`check.sh` が `KNOWN` と出し、終了コードに数えません。直さずに残す不具合をほかに見つけたら、その性質を `known` に足して、下の節に反例を書きます。

## 手順

1. **変更がモデルの範囲に触れるか見る。** 下の「範囲」の関数で、`Ref`・`PubSub`・書き込みの回数・順番・条件を変えたら触れています。ほかに、次の変更も触れています。
   - `applyOpen`・`applyClose` が消す種類を変えた。
   - `END_FRAMES` の値や `"keep"` を変えた。
   - intake または screen-notice を送る場所を足した・動かした（`rg -n 'type: "intake"|type: "screen-notice"' server/src`）。そのとき、その場所が Scope の中の Fiber か、外の Fiber か（HTTP の要求など）も確かめます。

   どれにも当たらなければ触れていないので、ここで終えます。たとえば、フレームの中身や、ほかの種類の送り方だけを変えた場合です。
2. **モデルをコードに合わせる。** 変わった歩を、モデルの対応する遷移に移します。1 歩が増えたら遷移を 1 つ分け、1 歩にまとめたら遷移を 1 つにします。
   - 送る場所を足したら、`SenderInfo` と `Senders` に足します。足すときは、種類・値・`inScope` と、送る前に確かめる条件（resume の `ResumeCheck` のようなもの）も入れます。
   - 新しい種類を足したら `Kinds`・`End`・`WebInit`・`ApplyOpen`・`ApplyClose`・`RetainedSeq` を直します。新しい種類は、web が消す種類か、消さない種類かを見分けます。
   - 遷移の注釈の行番号も直します。

   直さずに済むのは、歩の回数・順番・条件が変わっていない変更だけです。たとえば、名前の変更やログの文言です。
3. **検査する。** repo のルートで `bash server/formal/check.sh --model ViewerFeed` を流します。性質を絞るときは名前を並べます（例 `bash server/formal/check.sh --model ViewerFeed InvViewersMatchRetained`）。
   - 1 回目は TLC（tla2tools.jar 1.7.4、SHA-256 を照合）を `server/formal/.tla/` に取ってきます。Java 11 以上が要ります。
   - 全体で 5 秒ほどかかります。
   - 出力の行は次のどれかです: `pass`（成り立つ）・`FAIL`（新しく破れた）・`KNOWN`（既知の発見のとおり破れた）・`PASS?`（既知の発見が通るようになった）・`ERROR`（TLC が調べ切れない）。
   - 終了コードは、`FAIL` が無ければ 0、あれば 1、`ERROR` があれば 2 です。
4. **結果を読む。** `FAIL`・`KNOWN` には、反例の手順（遷移の名前の列）と、全文のファイル `server/formal/.tla/traces/ViewerFeed-<性質>-<構成>.txt` が付きます。反例と状態図は pstack の `/statechart` スキルで読みます。`/statechart` は、反例を平易な最短の手順に直し、変更がどの違反を直すかを示します。通ったときは、状態がどう移るかの図を描きます。`/statechart` が使えないときは全文のファイルを開き、`State N: <遷移の名前 line ...>` ごとに次を追います。
   - `pc`（どの送る側がどこまで送ったか）
   - `retained`
   - `sub`・`sock`（届いていないフレーム）
   - `web`（画面の表示）

   `pc` は複数行にわたるので、行ごとの grep では切れます。そのうえで、次のどちらかを決めます。
   - **コードの不具合**: 反例の手順をコードの行で辿れて、各遷移が実際の 1 歩と合っている。性質もモデルも弱めずに、反例を手順で報告します。product のコードを直すのは、頼まれたときだけです。
   - **モデルの書き違い**: 反例の中に、コードでは 1 歩で起きることが 2 歩に分かれている遷移や、コードには無い条件がある。並んで起きない送る側を並べている場合もそうです（たとえば、resume は前の取り込みの終わりを sessions.ts:547 で待つので、前の取り込みの observe とは重なりません）。モデルを直して、手順 3 に戻ります。

   `PASS?` が出たら、変更が既知の発見を直しています。`ViewerFeed.checks` の `known` からその性質を外し、「既知の発見」の節からその項を消します。
5. **性質が空振りしていないか確かめる。** 性質を足した・変えたとき、または遷移や変数を足した・消したときに行います。既存の遷移の条件や代入を変えただけなら要りません。その性質が守っている条件をモデルから 1 か所だけ外した版を、scratchpad の別のフォルダに `ViewerFeed.tla` の名前で作ります。そして `bash server/formal/check.sh --model ViewerFeed --spec <その版の ViewerFeed.tla> <性質>` が `FAIL` になることを見ます。
   - `Subscribe` と `ReadRetained` の順を入れ替える（retained を読んでから購読する）と、`InvViewersMatchRetained` が破れます。
   - `CloseScope` から「途中の send が無い」の条件を外すと、`InvEndFramesAfterClose` が破れます。

   `FAIL` にならない性質は書き直します。
6. **モデルの変更の行き先を決める。** 変更がそのまま入るなら、モデルの変更も同じ PR に入れます。そして、下の「最後に合わせた」をその PR の番号に書き換えます。書き換えてよいのは、モデルが変更後のコードをそのまま表していると、手順 2 で確かめ終えたときだけです。コードの不具合と判定して変更を入れないなら、モデルの変更も戻します。

## 範囲

最後に合わせた PR: #2011（2026-11-09）

この PR が main に入った後に次のファイルが変わっていたら、手順 2 から見直します。PR の squash コミットは件名の末尾に `(#2011)` が付くので、`git log "$(git log -1 --format=%H --grep='(#2011)$' origin/main)"..origin/main -- <ファイル>` で後の変更を出せます。

対象のファイル:

- `server/src/viewers.ts`: `END_FRAMES`・`retainedFrames`・`send`・`forSession`（`sent` と finalizer）・`deliver`・`connect`
- `web/src/liveFeed.ts`: `createFeedState`（`DEFAULT_INTAKE`）・`applyFrame` の intake と screen-notice・`applyOpen`・`applyClose`
- `web/src/app/liveFeed/subscription.ts`: `connection`（onopen・onmessage・onclose）・`liveFeedStream`（`RECONNECT_MS` 後に接続し直す）
- `server/src/sessions.ts`: intake と screen-notice を送る場所（`runLive` の observe、`showScreenNotice`、`start` の writeFailure の fork、`resume` の `beforeRun` の確かめと send）、`openSession` で `viewers.forSession` を Scope に足す順、`closeSession` の `Scope.close`、`stop` が state を stopping にする `current`

## 調べている範囲と前提

- 構成は 2 つです（`server/formal/viewer-single.cfg`・`viewer-resume.cfg`）。どちらも、画面は 1 つで、切断と接続し直しは 2 回までです。後から開いた画面の値は、retained から計算して比べます（`Fresh`）。そのため、画面を 2 つ並べなくても比べられます。
- セッションは 1 つです。フレームの種類は intake と screen-notice の 2 つです。intake は、web が接続・切断で消さない種類の代表です。screen-notice は、消す種類の代表です。送る側は各 1 回送ります。
- 含めていないもの:
  - `drained`（サーバーの終わり）
  - サーバーの再起動（retained が空になり、画面の intake が古いまま残りうる）
  - snapshot・diff-update など他の種類
  - どの値を送るかを決める側の順序。たとえば resume の interrupted が新しい取り込みの running より後に届くこと、`sessionFiles.ts` が diff-update の状態を読んでから送るまでに別の Fiber が入ることは、このモデルの外です。
  - 字幕の期限
  - JSON の読み違い
  - writeFailure の fork（sessions.ts:329-338）が送る intake の stopped
- 通ったときに言えるのは、この範囲のモデルで成り立つということだけです。システム全体で成り立つとまでは言えません。

## 既知の発見

どちらも、resume の send（sessions.ts:552）が Scope の外の Fiber から来ることによります。起こすには、同期の歩だけが並ぶ短い間に別の Fiber が I/O を終えて割り込む必要があり、実際にはまず起きません。ただし、コードで止めているわけではありません。

### `InvSendsSerializedPerKind`（viewer-resume）

画面が見る値と、後から開いた画面が見る値が食い違います（このとき `InvViewersMatchRetained` も破れます）。

1. resume が `Ref.get(state)` で live を確かめ（sessions.ts:548-549）、`runLive` で新しい取り込みを始めます（sessions.ts:550）。
2. 新しい取り込みの observe が `{ type: "intake", status: "running" }` を送り始めます（sessions.ts:250）。`sent` に足し（viewers.ts:56）、retained を running にします（viewers.ts:43）。まだ publish していません。
3. resume が `{ type: "intake", status: "interrupted" }` を送ります（sessions.ts:552）。retained を interrupted にし、publish します（viewers.ts:43-44）。
4. 画面がつながり、購読します（viewers.ts:75）。
5. observe が running を publish します（viewers.ts:44）。
6. 画面は retained の interrupted を受け取り（viewers.ts:77）、続けて購読から running を受け取ります（viewers.ts:63-65）。

この結果、つながっていた画面は取り込み中を表示します。一方、retained は interrupted なので、後から開いた画面は「音声の取り込みが途切れました。再開しています」を表示します。どちらも、次に intake が送られるまで続きます。

起きやすさ: observe の send は、ヘルパーの起動と接続の I/O の後にしか始まりません。resume の 550-552 は同期の歩だけです。observe の send の中で、viewers.ts:43 と :44 の間で Fiber が順番を譲り、その間に resume が send を通す必要があります。

### `InvNoSendAfterEnd`（viewer-resume）

止めた会議の終わりの値が上書きされます（このとき `InvEndFramesAfterClose` も破れます）。

1. resume が `Ref.get(state)` で live を確かめます（sessions.ts:548-549）。
2. stop が state を stopping にします（sessions.ts:139）。そして `stopLive` を終え、`closeSession` の `Scope.close`（sessions.ts:345）に進みます。
3. forSession の finalizer が `sent` を読み（viewers.ts:50）、終わりの値（intake は none）を送ります。
4. resume が `runLive`・`Ref.set` の後に `{ type: "intake", status: "interrupted" }` を送ります（sessions.ts:550-552）。retained の intake は interrupted になります。

この結果、会議が終わった後も、つながっている画面と新しく開いた画面の両方に「音声の取り込みが途切れました。再開しています」が残ります。次のセッションが intake を送るまで消えません。resume 自身がこの後どう終わるかは、このモデルの外です。

起きやすさ: 549 から 552 の間は同期の歩だけです。その間に、stop がヘルパーの停止と書き出しの I/O をすべて終える必要があります。
