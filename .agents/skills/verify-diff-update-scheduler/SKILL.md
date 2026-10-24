---
name: verify-diff-update-scheduler
description: 差分更新の呼び出しの段取り（server/src/core/session.ts の startDiffIfReady・runCall・callUpdater・scheduleRetry・idle・flush・setLifecycleState）を変えたとき、または変える前に、TLA+ のモデルを TLC にかけて、同時に 2 つ呼ばない・発言を落とさず二重に反映しない・flush の後に呼び出しが残らない・停止から戻らない・flush がいつか抜ける、が成り立つか確かめる。差分更新の一時停止・再試行・Apple Intelligence の再起動まわりの順序の不具合を調べるときにも使う。
---

# 差分更新の呼び出しの段取りを TLC で確かめる

`server/formal/DiffUpdateScheduler.tla` は、`openSession`（`server/src/core/session.ts`）が差分更新をどう呼ぶかのモデルです。モデルの 1 つの遷移は、コードの中で他の Fiber に割り込まれない 1 歩、つまり `Ref.modify`・`Ref.update`・`Ref.get` の 1 回に当たります。Effect 4 の Fiber は `MaxOpsBeforeYield`（既定 2048 回）ごとに順番を譲るので、同期の処理が続いていても、`Ref` の操作の間には他の Fiber が入れます。`forkIn(..., { startImmediately: true })` で始めた呼び出しは、fork から戻る前に終わることもあります（たとえば `appleDiffUpdater.ts` の `running()` が停止をすぐに返したとき）。遷移ごとの注釈に、対応する `session.ts` の行を書いてあります。

`startDiffIfReady` は push・flush・呼び出しの onExit・再試行の待ちの 4 か所から呼ばれ、モデルではどこから呼ばれても同じ `StartTake`・`StartSwap` を通ります。`startDiffIfReady` の中を変えたら、この 2 つを直せば 4 か所すべてに効きます。

## 守っている約束

| 性質 | 平易に言うと | 破れたときの害 |
|---|---|---|
| `InvOneCallAtATime` | 差分更新を同時に 2 つ呼ばない | 同じマップに 2 つの応答が重なって、操作が食い違う |
| `InvNoStaleInFlight` | 呼び出し中の印は、終わった呼び出しを指さない | `idle` が抜けられず、次の呼び出しも始まらず、止める操作も終わらない |
| `InvRemarksConserved` | 入った発言は、たまり・呼び出し中・反映済みのちょうど 1 か所にある | 発言がマップに載らないまま消える、または二重に反映される |
| `InvQuietAfterFlush` | flush が抜けた後は呼び出しが残っておらず、止まっていなければたまりも空 | 書き出しが最後の発言を含まず、Scope を閉じたときにその呼び出しが中断される |
| `PropStoppedStays` | stopped からは戻らない | 再起動の上限に達した後も Apple Intelligence を呼び続ける |
| `PropFlushReturns` | flush はいつか抜ける | stop が終わらない |

今のコードでは、どの性質も成り立ちます。直さずに残す不具合を見つけたときは、その性質を `check.sh` の `known` に足して issue を立て、末尾に「既知の発見」の節を作って反例を書きます。`check.sh` は `known` の性質を `KNOWN` と出し、終了コードに数えません。

## 手順

1. **変更がモデルの範囲に触れるか見る。** 下の「範囲」の関数か、そこから呼ぶ `Ref` の操作の順番・条件を変えたら触れています。共有画面の選び方やマップの中身だけを変えたのなら触れていないので、ここで終えます。
2. **モデルをコードに合わせる。** 変わった歩を、モデルの対応する遷移に移します。`Ref` の操作が 1 回増えたら遷移を 1 つ分け、1 回にまとめたら遷移を 1 つにします。新しい条件や状態は、コードの名前のまま変数や条件に足します。遷移の注釈の行番号も直します。直さずに済むのは、`Ref` の操作の回数・順番・条件が変わっていない変更（名前の変更、ログの文言など）だけです。
3. **検査する。** repo のルートで `bash server/formal/check.sh` を流します。性質を絞るときは名前を並べます（例 `bash server/formal/check.sh InvRemarksConserved`）。1 回目は TLC（tla2tools.jar 1.7.4、SHA-256 を照合）を `server/formal/.tla/` に取ってきます。Java 11 以上が要ります。全体で 1 分ほどかかります。出力の行は `pass`（成り立つ）・`FAIL`（新しく破れた）・`KNOWN`（既知の発見のとおり破れた）・`PASS?`（既知の発見が通るようになった）・`ERROR`（TLC が調べ切れない）のどれかです。終了コードは、`FAIL` が無ければ 0、あれば 1、`ERROR` があれば 2 です。
4. **結果を読む。** `FAIL`・`KNOWN` には、反例の手順（遷移の名前の列）と、全文のファイル `server/formal/.tla/traces/<性質>-<構成>.txt` が付きます。反例と状態図は pstack の `/statechart` スキルで読みます。`/statechart` が使えないときは全文のファイルを開き、`State N: <遷移の名前 line ...>` ごとに、`pending`・`inFlight`・`status`・`calls` の pc が前の状態からどう変わったかを追います。`calls` や `starts` は複数行にわたるので、行ごとの grep では切れます。`/statechart` は、反例を平易な最短の手順に直し、変更がどの違反を直すかを示します。通ったときは、状態がどう移るかの図を描きます。そのうえで、次のどちらかを決めます。
   - **コードの不具合**: 反例の手順をコードの行で辿れて、各遷移が実際の 1 歩と合っている。性質もモデルも弱めずに、反例を手順で報告します。product のコードを直すのは、頼まれたときだけです。
   - **モデルの書き違い**: 反例の中に、コードでは 1 歩で起きることが 2 歩に分かれている遷移や、コードには無い条件がある。モデルを直して、手順 3 に戻ります。

   `PASS?` が出たら、変更が既知の発見を直しています。`check.sh` の `known` からその性質を外し、「既知の発見」の節からその項を消します。
5. **性質が空振りしていないか確かめる**（性質を足した・変えたとき、または遷移や変数を足した・消したとき。既存の遷移の条件や代入を変えただけなら要りません）。その性質が守っている条件をモデルから 1 か所だけ外した版を scratchpad に作り、`bash server/formal/check.sh --spec <その版の .tla> <性質>` が `FAIL` になることを見ます。たとえば `Ready` から `inFlight.kind = "none"` を外すと、`InvOneCallAtATime` が破れます。`FAIL` にならない性質は書き直します。
6. **モデルの変更の行き先を決める。** 変更がそのまま入るなら、モデルの変更も同じ PR に入れます。そして、下の「最後に合わせた PR」をその PR の番号に書き換えます。書き換えてよいのは、モデルが変更後のコードをそのまま表していると、手順 2 で確かめ終えたときだけです。main は squash マージなので、コミットではなく PR の番号で記録します。コードの不具合と判定して変更を入れないなら、モデルの変更も戻します。

## 範囲

最後に合わせた PR: #1458（2026-10-24）

この PR が main に入った後に次のファイルが変わっていたら、手順 2 から見直します。PR の squash コミットは件名の末尾に `(#1458)` が付くので、`git log "$(git log -1 --format=%H --grep='(#1458)$' origin/main)"..origin/main -- <ファイル>` で後の変更を出せます。

- `server/src/core/session.ts`: `openSession` の中の `setLifecycleState`・lifecycle の購読・`takeStep`・`startDiffIfReady`・`scheduleRetry`・`runCall`・`callUpdater`（状態を変える `Ref` の操作の部分）・`idle`・`push`（`pending` に足す歩）・`flush`、と `takeFresh`・`PACED_CALL_REMARKS`
- `server/src/appleDiffUpdater.ts`: lifecycle に流す通知（`restarting`・`running`・`DiffUpdateStopped`）
- `server/src/core/diffUpdate.ts`: `DiffUpdateState`・`DiffUpdateLifecycle`
- `server/src/sessions.ts`: `stopLive` で `drain` の後に `flush` を呼ぶ順番（モデルは、flush が始まる前に push が終わっている前提です）

## 調べている範囲と前提

- 構成は 2 つです（`server/formal/cloud.cfg`・`apple.cfg`）。cloud は一時停止と再試行があり lifecycle が無い（ChatGPT・Claude）。apple は lifecycle と停止があり一時停止が無い（Apple Intelligence）。本番に無い組み合わせ（同じ updater が一時停止と停止の両方を返す）は調べていません。
- 発言は 3 件、一時停止は 2 回まで、lifecycle の running / restarting の通知は 2 回までです。それを超える振る舞いは調べ切れていません。
- 呼び出しの結果は、成功（1 件から全件までのどれだけを反映してもよい）・失敗・一時停止・停止のどれでもよいとしています。
- `takeFresh` は、全件を取るか、先頭 `PACED_CALL_REMARKS` 件を取るかを、たまりの印に関わらず両方許しています（実際より広く調べます）。
- 含めていないもの: 共有画面の選び方、マップの中身、Scope を閉じたときの中断、時刻（再試行の待ちは「いつか起きる」とする）、`restoreSession` からの再開、push の中の `remarks` への追加とログ。
- 通ったときに言えるのは、この範囲のモデルで成り立つということだけです。システム全体で成り立つとまでは言えません。
