---
name: verify-session-lifecycle
description: セッションの受け付け（server/src/sessions.ts の Sessions.layer: state の idle・starting・live・recorded・stopping、claimIdle・claimStart・reserveDeps・openSession・stop・stopLive・stopRecorded・closeSession・concludeRecorded・resume・runLive の observe・書き込みの失敗を待つ fork）を変えたとき、または変える前に、TLA+ のモデルを TLC にかけて、依存の導入中にセッションを始めない・installations が予約の数と合う・セッションを閉じる者は 1 人・落ち着いたとき画面の取り込みの知らせが status と合い本当のことを言う・閉じた後に知らせが残らない・stop と resume がいつか返る、が成り立つか確かめる。start・stop・resume が重なったときの順序の不具合（画面に「再開しています」が残る、resume が返らない、二重に閉じる）を調べるときにも使う。
---

# セッションの受け付けを TLC で確かめる

`server/formal/SessionLifecycle.tla` は、`Sessions.layer`（`server/src/sessions.ts`）がセッションを始め、止め、取り込みを再開するまでのモデルです。モデルの 1 つの遷移は、コードの中で他の Fiber に割り込まれない 1 歩（`Ref.modify`・`Ref.set`・`Ref.get`・`send` の 1 回）か、I/O を待つ 1 回（`checks.prepare`・`running.end`・`writeOut` など）に当たります。Effect 4 の Fiber は `MaxOpsBeforeYield` ごとに順番を譲るので、同期の `Ref` の歩の間にも他の Fiber が入れます。遷移の条件の注釈に、対応する行を書いてあります。

モデルに入る者は、要求（`start`・`startRecorded`・`stop`・`resume`・`reserveDeps`。resume のうち新しい run を始めてからの歩は、`live.scope` に fork した Fiber）、取り込みの run（`intakeAttempts.ts` の `run` の body のうち、`sessions.ts` に見える `observe`・`reached`・`end` と `stopRequested` を見る条件だけ）、書き込みの失敗を待つ fork（`sessions.ts:329`）、録画の終わりを待つ fork（`afterPublish`）です。run の中身（ヘルパーの起動、指示の再送）は `verify-intake-attempts` スキル、画面への配信の順は `verify-viewer-feed` スキルが見ます。`shown` は Viewers の retained の intake、つまり後から開いた画面が受け取る値です。

resume は、新しい run を始めて画面に知らせ、`reached` を待つまでを、`live.scope` に fork した Fiber で行います（`sessions.ts:550-555`）。閉じた Scope への `Effect.forkIn` は、Fiber を始めずに中断します（`server/node_modules/effect/src/internal/effect.ts` の `forkIn`）。そのため、stop が先に Scope を閉じていれば、resume は何も始めず、何も送らずに Aborted を返します（`sessions.ts:556-557`）。fork した後に Scope を閉じると、その Fiber は forSession の終わりのフレームより前に中断され、resume は同じく Aborted を返します。モデルの `ResFork` と `CloseScope` はこれに合わせています。effect を上げたときは、この振る舞いが変わっていないか確かめます。

## 守っている約束

| 性質 | 平易に言うと | 破れたときの害 |
|---|---|---|
| `InvNoSessionWhileReserved` | 依存の導入中は、セッションを始めない | 入れている途中の依存（Claude の SDK・Chromium）を、始めたセッションが読む |
| `InvInstallationsCount` | idle の `installations` は、持たれている予約の数と同じ | 導入が終わった後も start が断られ続ける、または導入中に start が通る |
| `InvOneCloser`（recorded） | セッションを閉じる者は 1 人だけ | stop と録画の読み終わりが、同じセッションを二重に書き出して閉じる |
| `InvScreenMatchesStatus`（live） | 落ち着いたとき、画面の取り込みの知らせは CLI の `status` と同じことを言う | 画面は「途切れました。再開しています」、`status` は running と食い違う |
| `InvStatusTruthful`（live） | 落ち着いたとき、取り込みが止まっていれば `status` は stopped と言い、動いていれば stopped と言わない | 取り込みが止まっているのに「再開しています」のまま。利用者は待ち続け、resume も断られる |
| `InvScreenQuietWhenIdle`（live） | セッションが閉じて落ち着いたら、画面に取り込みの知らせが残らない | 止めた会議の画面や次に開いた画面に「途切れました」が残る |
| `PropStopReturns` | stop はいつか返る | `cli stop` が終わらず、書き出しが出ない |
| `PropResumeReturns`（live） | resume はいつか返る | `cli resume` が返らない |

「落ち着いたとき」は、利用者や外から起きること（要求の始まり、ヘルパーが勝手に終わる、書き込みの失敗）を除いて、どの者も次の歩を進められない状態（`Settled == ~ENABLED System`）です。

今のコードでは `InvScreenMatchesStatus`・`InvStatusTruthful` が破れます（末尾の「既知の発見」）。どれも `server/formal/SessionLifecycle.checks` に `known` として載せてあり、`check.sh` は `KNOWN` と出して終了コードに数えません。直さずに残す不具合を新しく見つけたときは、その性質を `known` に足し、「既知の発見」に反例を書きます。

## 手順

1. **変更がモデルの範囲に触れるか見る。** 下の「範囲」の関数か、そこから呼ぶ `state`・`live.intake`・`live.running` の `Ref` の操作、`send({ type: "intake" })`、`controller.stop`・`running.end`・`running.reached` の待ちの順番・条件を変えたら触れています。マップ・字幕・共有画面の知らせ・話者・書き出しの中身だけを変えたのなら触れていないので、ここで終えます。
2. **モデルをコードに合わせる。** 変わった歩を、モデルの対応する遷移に移します。`Ref` の操作や I/O の待ちが 1 回増えたら遷移を 1 つ分け、1 回にまとめたら遷移を 1 つにします。要求の入口で見る条件（`current`・`claimIdle` の `switch`）を変えたら、`StartClaim`・`StopClaim`・`ResCurrent`・`ReserveAcquire` を直します。新しい条件や状態は、コードの名前のまま変数や条件に足します。注釈の行番号も直します。直さずに済むのは、操作の回数・順番・条件が変わっていない変更（名前の変更、ログの文言など）だけです。
3. **検査する。** repo のルートで `bash server/formal/check.sh --model SessionLifecycle` を流します。性質を絞るときは名前を並べます（例 `bash server/formal/check.sh --model SessionLifecycle InvOneCloser`）。1 回目は TLC（tla2tools.jar 1.7.4、SHA-256 を照合）を `server/formal/.tla/` に取ってきます。Java 11 以上が要ります。全体で 1〜2 分かかり、そのほとんどは live の構成（約 100 万状態）です。変更が触れない性質は名前を並べて外せます。出力の行は `pass`（成り立つ）・`FAIL`（新しく破れた）・`KNOWN`（既知の発見のとおり破れた）・`PASS?`（既知の発見が通るようになった）・`ERROR`（TLC が調べ切れない）のどれかです。終了コードは、`FAIL` が無ければ 0、あれば 1、`ERROR` があれば 2 です。
4. **結果を読む。** `FAIL`・`KNOWN` には、反例の手順（遷移の名前の列）と、全文のファイル `server/formal/.tla/traces/SessionLifecycle-<性質>-<構成>.txt` が付きます。反例と状態図は pstack の `/statechart` スキルで読みます。`/statechart` は、反例を平易な最短の手順に直し、変更がどの違反を直すかを示します。通ったときは、状態がどう移るかの図を描きます。`/statechart` が使えないときは全文のファイルを開き、`State N: <遷移の名前 line ...>` ごとに、`state`・`intake`・`shown`・`runs`・`stopper`・`resumer` が前の状態からどう変わったかを追います。`runs` は複数行にわたるので、行ごとの grep では切れます。そのうえで、次のどちらかを決めます。
   - **コードの不具合**: 反例の手順をコードの行で辿れて、各遷移が実際の 1 歩と合っている。性質もモデルも弱めずに、反例を手順で報告します。I/O の待ちを挟まずに同期の歩の間へ別の Fiber が入る必要がある反例は、起きにくさも書き添えます。product のコードを直すのは、頼まれたときだけです。
   - **モデルの書き違い**: 反例の中に、コードでは 1 歩で起きることが 2 歩に分かれている遷移や、コードには無い条件がある。前のセッションの者が次のセッションの値を読んでいないか（run・`intake`・`running` はセッションごとに `gen` で分けてある）も見ます。モデルを直して、手順 3 に戻ります。

   `PASS?` が出たら、変更が既知の発見を直しています。`SessionLifecycle.checks` の `known` からその性質を外し、「既知の発見」の節からその項を消します。
5. **性質が空振りしていないか確かめる**（性質を足した・変えたとき、または遷移や変数を足した・消したとき。既存の遷移の条件や代入を変えただけなら要りません）。その性質が守っている条件をモデルから 1 か所だけ外した版を scratchpad に作り、`bash server/formal/check.sh --model SessionLifecycle --spec <その版の .tla> <性質>` が `FAIL` になることを見ます。版のファイル名は `SessionLifecycle.tla` のままにします。例: `StartClaim` から `state.inst = 0` を外すと `InvNoSessionWhileReserved` が、`ReserveRelease` の減らす式を `state` にすると `InvInstallationsCount` が、`ConcludeClaim` の条件を `state.kind \in {"recorded", "stopping"}` に広げると `InvOneCloser` が、`StopIntake` の `stopReq'` を `stopReq` のままにすると `PropStopReturns` が破れます。既知の発見の 4 つは、今のコードで破れることがその確かめを兼ねます。`FAIL` にならない性質は書き直します。
6. **モデルの変更の行き先を決める。** 変更がそのまま入るなら、モデルの変更も同じ PR に入れます。そして、下の「最後に合わせた」記録をその PR の番号に書き換えます。書き換えてよいのは、モデルが変更後のコードをそのまま表していると、手順 2 で確かめ終えたときだけです。main は squash マージなので、PR の番号で記録します。コードの不具合と判定して変更を入れないなら、モデルの変更も戻します。

## 範囲

最後に合わせた PR: #2011（2026-11-09）

この PR が main に入った後に次のファイルが変わっていたら、手順 2 から見直します。PR の squash コミットは件名の末尾に `(#2011)` が付くので、`git log "$(git log -1 --format=%H --grep='(#2011)$' origin/main)"..origin/main -- <ファイル>` で後の変更を出せます。

- `server/src/sessions.ts`: `State`・`current`・`claimIdle`・`reserveDeps`・`runLive` の `observe`・`claimStart`・`openSession`・`start`（`Ref.set(live.running)` と書き込みの失敗を待つ fork）・`closeSession`・`concludeRecorded`・`startRecorded` の `afterPublish`・`stopLive`・`stopRecorded`・`stop`・`resume`（`live.scope` への fork と、その Fiber の中断の扱い）・`status`
- `server/src/intakeAttempts.ts`: `run` の body のうち、`observe` に渡す遷移、`reached` を決める所、`end` が返る条件、`stopRequested` を見る所（:107-110・:116-124・:129-133・:144-153）
- `server/src/viewers.ts`: `forSession` の `sent` と終わりのフレーム（Scope を閉じたときに intake を none にする）
- `web/src/intake.ts`: `intakeNoticeText`（どの値が画面に知らせを出すか。モデルの `Notice`）
- `server/node_modules/effect/src/internal/effect.ts`: `forkIn` の、閉じた Scope での振る舞い（effect を上げたとき）

## 調べている範囲と前提

- 構成は 2 つです（`server/formal/session-live.cfg`・`session-recorded.cfg`）。live は会議（start・stop・resume、ヘルパーが落ちる、書き込みの失敗）、recorded は録画（startRecorded・stop・読み終わり・起動し直しを諦める）です。live と recorded が入れ替わる流れは調べていません。
- セッションは 2 つまで、resume は 1 回まで、ヘルパーが勝手に終わる回数（起動の失敗を含む）は 1 セッションに 2 回まで、`reserveDeps` は 1 回まで、書き込みの失敗は 1 回までです。それを超える振る舞いは調べ切れていません。
- 要求を出す者は種類ごとに 1 人です（start を 2 つ同時に出す、stop を 2 つ同時に出す、は調べていません。どちらも `Ref.modify` の 1 歩で片方が断られます）。
- `decideIntakeRestart` の結果は、起動し直す・諦めるのどちらでもよいとしています（実際より広く調べます）。
- 含めていないもの: マップ・字幕・共有画面の知らせ・話者・書き出しの中身、時刻（`SCREEN_NOTICE_MS` など）、HTTP の切断による要求の中断（stop は `serverScope` に fork するので中断されません。resume は中断され得ます）、`status`・`checkResume`・`setSelfPause`・`setSpeakerName`、サーバーの終わり（`drained`）、ヘルパーの子プロセスそのもの。
- 通ったときに言えるのは、この範囲のモデルで成り立つということだけです。システム全体で成り立つとまでは言えません。

## 既知の発見

どれも、反例の手順を `sessions.ts` の行で辿り、各遷移が実際の 1 歩に合うことを確かめてあります。実機での再現はしていません。

1. **書き込みの失敗と resume が重なると、取り込みが止まったまま「再開しています」と出続ける**（`InvStatusTruthful`、構成 live）
   1. ヘルパーの起動し直しを諦め、`live.intake` が stopped になる（`intakeAttempts.ts:107`）。
   2. 利用者が resume する。`writeError` は無く、`intake` は stopped なので先へ進み、`checks.prepare` を待つ（`sessions.ts:538-541`）。
   3. その間にディスクへの書き込みが失敗し、待っていた fork が `controller.stop` を呼び、`intake` を stopped にして画面に送る（`sessions.ts:330-337`）。
   4. `prepare` が終わる。`state` は live のままなので、resume は `intake` を stopped から interrupted に書き換える（`sessions.ts:542-545`）。
   5. 新しい run は `stopRequested` が立っているのですぐ終わり（`intakeAttempts.ts:129`）、resume は画面に interrupted を送って Aborted を返す（`sessions.ts:553-560`）。
   6. 結果: 取り込みは止まっているのに、`status` は interrupted、画面は「音声の取り込みが途切れました。再開しています」のまま変わらない。

   起きやすさ: 2 と 4 の間は `checks.prepare` の I/O（数百 ms〜数秒）なので、その間に書き込みが失敗すれば起きます。書き込みの失敗そのもの（ディスクが一杯など）はまれです。

2. **resume の画面への知らせが、新しい取り込みの「動いている」より後に届く**（`InvScreenMatchesStatus`、構成 live）
   1. 起動し直しを諦めて stopped になった後、resume が `intake` を interrupted にし、`runLive` で新しい run を始める（`sessions.ts:544-551`）。
   2. resume が `Ref.set(live.running)` と `send` に進む前に、新しい run がヘルパーを起動してつながり、`intake` を running にして画面に running を送る（`intakeAttempts.ts:116-124`、`sessions.ts:249-250`）。
   3. resume が画面に interrupted を送る（`sessions.ts:553`）。
   4. 結果: `status` は running なのに、画面は「途切れました。再開しています」のまま。

   起きやすさ: resume の `runLive` から `send` までは同期の歩だけなので、その間にヘルパーの起動（子プロセスとソケットの I/O）が終わる必要があります。実際にはまず起きません。
