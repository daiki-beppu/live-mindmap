---
name: verify-viewer-feed
description: 画面への配信（server/src/viewers.ts の publish・forSession・connect・deliver と END_FRAMES、web/src/liveFeed.ts の applyFrame・applyOpen・applyClose、web/src/app/liveFeed/subscription.ts の接続し直し）を変えたとき、またはフレームを送る場所（sessions.ts などの send の呼び出し）を足す・動かすとき、または変える前に、TLA+ のモデルを TLC にかけて、つながっている画面と後から開いた画面が同じものを見る・セッションが閉じたら終わりの値になる・同じ種類を同時に送らない・終わりの後に送らない、が成り立つか確かめる。画面の表示が CLI の status や開き直した画面と食い違う不具合を調べるときにも使う。
---

# 画面への配信を TLC で確かめる

`server/formal/ViewerFeed.tla` は、server が画面（ブラウザのタブ）にフレームを配る仕組みと、画面がそれを受け取る仕組みのモデルです。server 側は `server/src/viewers.ts` の `Viewers`、画面側は `web/src/liveFeed.ts` と `web/src/app/liveFeed/subscription.ts` です。モデルの 1 つの遷移は、コードの中で他の Fiber に割り込まれない 1 歩に当たります。1 歩は、forSession が返す `send` の 1 回、forSession の finalizer、`PubSub.subscribe`・retained を読む・`PubSub.takeAll` と書き込みの 1 回、またはブラウザが 1 通受け取って `applyFrame` することです。`send`（viewers.ts:55-58）は `sent` に種類を足し、retained を書き換え、`PubSub.publishUnsafe` で配るまでを `Effect.sync` の中で行います。finalizer（viewers.ts:50-54）も、終わりの値をすべて `Effect.sync` の中で送ります。どちらも同期の処理だけなので、途中に他の Fiber は入れません。遷移ごとの注釈に、対応するコードの行を書いてあります。

送る側は、コードで同じ種類のフレームを送る Fiber ごとに `SenderInfo` に並べてあります。

- `showInterrupted`・`showRunning`: `showIntake`（sessions.ts:50-52）が送る intake。`start` が Scope に fork した 1 つの Fiber（sessions.ts:332）が、`live.intake` の変化を順に送ります。intake を送るのはこの Fiber だけです。resume の構成では、interrupted を送り終えてから running を送ります。
- `notice`・`noticeClear`: 共有画面の知らせ（sessions.ts:231-235）。Scope の中の Fiber です。

`inScope` の送る側は、`closeSession` の `Scope.close`（sessions.ts:349）で中断されて待たれます。待ち終わってから、forSession の finalizer（sessions.ts:270 で Scope に最初に足したので、最後に走る）が終わりの値を送ります。

## 守っている約束

| 性質 | 平易に言うと | 破れたときの害 |
|---|---|---|
| `InvViewersMatchRetained` | 送り終えて静まったら、つながっている画面の各種類の値は、後から開いた画面が見る値（retained）と同じ | 同じ会議を見ている 2 つの画面で、取り込みの状態や知らせが食い違う。開き直すまで古い表示が残る |
| `InvEndFramesAfterClose` | セッションが閉じて静まったら、そのセッションで送った種類は終わりの値（`END_FRAMES`。intake は none）になっている | 会議を止めた後も「取り込みが途切れました」などが画面に残る |
| `InvSendsSerializedPerKind` | 同じ種類のフレームを、2 つの Fiber が同時に送らない（`InvViewersMatchRetained` の前提） | 上の食い違いが起きる |
| `InvNoSendAfterEnd` | forSession の finalizer が終わりの値を決めた後に、そのセッションの send が来ない（`InvEndFramesAfterClose` の前提） | 終わりの値が上書きされて、止めた会議の表示が残る |

構成は 2 つあります（`server/formal/viewer-single.cfg`・`viewer-resume.cfg`）。single は resume を呼ばない会議で、showIntake は intake を 1 回送ります。resume は、取り込みが止まった後に resume を呼ぶ会議で、showIntake が interrupted と running を続けて送ります。上の 2 つの性質は両方の構成で、下の 2 つ（前提）は resume で調べます。今のコードでは 4 つとも成り立ちます。`server/formal/ViewerFeed.checks` の `known` の行に載っている性質は、`check.sh` が `KNOWN` と出し、終了コードに数えません。直さずに残す不具合をほかに見つけたら、その性質を `known` に足して、下の節に反例を書きます。

## 手順

1. **変更がモデルの範囲に触れるか見る。** 下の「範囲」の関数で、`sent`・retained・`PubSub`・書き込みの回数・順番・条件を変えたら触れています。ほかに、次の変更も触れています。
   - `applyOpen`・`applyClose` が消す種類を変えた。
   - `END_FRAMES` の値や `"keep"` を変えた。
   - intake または screen-notice を送る場所を足した・動かした（`rg -n 'type: "intake"|type: "screen-notice"' server/src`）。そのとき、その場所が Scope の中の Fiber か、外の Fiber か（HTTP の要求など）も確かめます。

   どれにも当たらなければ触れていないので、ここで終えます。たとえば、フレームの中身や、ほかの種類の送り方だけを変えた場合です。
2. **モデルをコードに合わせる。** 変わった歩を、モデルの対応する遷移に移します。1 歩が増えたら遷移を 1 つ分け、1 歩にまとめたら遷移を 1 つにします。
   - 送る場所を足したら、`SenderInfo` と `Senders` に足します。足すときは、種類・値・`inScope` と、送る前に待つ条件（`noticeClear` が `notice` を待つようなもの）も入れます。
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
   - **モデルの書き違い**: 反例の中に、コードでは 1 歩で起きることが 2 歩に分かれている遷移や、コードには無い条件がある。並んで起きない送る側を並べている場合もそうです（たとえば、showIntake の 2 つの値は 1 つの Fiber が順に送るので重なりません）。モデルを直して、手順 3 に戻ります。

   `PASS?` が出たら、変更が既知の発見を直しています。`ViewerFeed.checks` の `known` からその性質を外し、「既知の発見」の節からその項を消します。
5. **性質が空振りしていないか確かめる。** 性質を足した・変えたとき、または遷移や変数を足した・消したときに行います。既存の遷移の条件や代入を変えただけなら要りません。その性質が守っている条件をモデルから 1 か所だけ外した版を、scratchpad の別のフォルダに `ViewerFeed.tla` の名前で作ります。そして `bash server/formal/check.sh --model ViewerFeed --spec <その版の ViewerFeed.tla> <性質>` が `FAIL` になることを見ます。
   - `Subscribe` と `ReadRetained` の順を入れ替える（retained を読んでから購読する）と、`InvViewersMatchRetained` が破れます。
   - `CloseScope` が Scope の中の送る側を中断しないようにすると、`InvEndFramesAfterClose`・`InvNoSendAfterEnd` が破れます。
   - `Send` を retained の更新と publish の 2 歩に分け、`showRunning` が `showInterrupted` を待つ条件も外すと、`InvSendsSerializedPerKind` が破れます。どちらか片方だけでは破れません。

   `FAIL` にならない性質は書き直します。
6. **モデルの変更の行き先を決める。** 変更がそのまま入るなら、モデルの変更も同じ PR に入れます。そして、下の「最後に合わせた」をその PR の番号に書き換えます。書き換えてよいのは、モデルが変更後のコードをそのまま表していると、手順 2 で確かめ終えたときだけです。コードの不具合と判定して変更を入れないなら、モデルの変更も戻します。

## 範囲

最後に合わせた PR: #2050（2026-11-13）

この PR が main に入った後に次のファイルが変わっていたら、手順 2 から見直します。PR の squash コミットは件名の末尾に `(#2050)` が付くので、`git log "$(git log -1 --format=%H --grep='(#2050)$' origin/main)"..origin/main -- <ファイル>` で後の変更を出せます。

対象のファイル:

- `server/src/viewers.ts`: `END_FRAMES`・`retainedFrames`・`publish`・`forSession`（`sent`・finalizer・返す `send`）・`deliver`・`connect`
- `web/src/liveFeed.ts`: `createFeedState`（`DEFAULT_INTAKE`）・`applyFrame` の intake と screen-notice・`applyOpen`・`applyClose`
- `web/src/app/liveFeed/subscription.ts`: `connection`（onopen・onmessage・onclose）・`liveFeedStream`（`RECONNECT_MS` 後に接続し直す）
- `server/src/sessions.ts`: intake と screen-notice を送る場所（`showIntake` と、`start` がそれを Scope に fork する所、`showScreenNotice`）、`openSession` で `viewers.forSession` を Scope に足す順、`closeSession` の `Scope.close`、`stop` が state を stopping にする `current`

## 調べている範囲と前提

- 構成は 2 つです（`server/formal/viewer-single.cfg`・`viewer-resume.cfg`）。どちらも、画面は 1 つで、切断と接続し直しは 2 回までです。後から開いた画面の値は、retained から計算して比べます（`Fresh`）。そのため、画面を 2 つ並べなくても比べられます。
- セッションは 1 つです。フレームの種類は intake と screen-notice の 2 つです。intake は、web が接続・切断で消さない種類の代表です。screen-notice は、消す種類の代表です。送る側は各 1 回送ります。
- 含めていないもの:
  - `drained`（サーバーの終わり）
  - サーバーの再起動（retained が空になり、画面の intake が古いまま残りうる）
  - snapshot・diff-update など他の種類
  - どの値を送るかを決める側の順序。たとえば `live.intake` を書く順（`verify-session-lifecycle` が見ます）や、`sessionFiles.ts` が diff-update の状態を読んでから送るまでに別の Fiber が入ることは、このモデルの外です。
  - 字幕の期限
  - JSON の読み違い
- 通ったときに言えるのは、この範囲のモデルで成り立つということだけです。システム全体で成り立つとまでは言えません。

## 既知の発見

今は既知の発見はありません。
