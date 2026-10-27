# 取り込みの試行

server の取り込みの試行（`server/src/intakeAttempts.ts`）と、それを呼ぶ `Sessions` の配線（`server/src/sessions.ts` の `start`・`startRecorded`・`stop`・`resume`）を触るときに読む文書。試行とは、ヘルパーの起動 1 回分のことで、起動・落ちたときの起動し直し・停止・試行中の指令を含む。規則をどちらに置くか、どの層のテストで確かめるか、ライブと録画からのセッションの経路をまとめるときにどこで取り違えやすいかを書く。決定そのものは仕様 [#1305](https://github.com/daiki-beppu/live-mindmap/issues/1305)（Formal Spec のコメントを含む）と、その元の [#1238](https://github.com/daiki-beppu/live-mindmap/issues/1238)・[#1294](https://github.com/daiki-beppu/live-mindmap/issues/1294) の解決コメントにある。

- 用語: [取り込みの途切れ・録画からのセッション・一時停止](../../GLOSSARY.md)。「取り込みの試行」は実装の言葉で、用語集には載せない（仕様の決定）
- ADR: [0008 ヘルパーのライフサイクルは、stop を印で、サーバーの終了を Scope で止める](../adr/0008-helper-lifecycle-on-effect.md)（Considered Options に、Service にせず内側のモジュールにした理由がある）
- 関連する知識文書: [セッションの sink](session-sink.md)、[helper のイベントの見本](helper-events.md)

## 試行の規則は `intakeAttempts` に置き、`intakeAttempts.test` で確かめる。`Sessions` には種類ごとの引数と手続きだけを書く

ライブと録画からのセッションは、同じ `openIntake` を呼び、`run` に渡す引数だけが違う。

| | ライブ | 録画からのセッション |
|---|---|---|
| `commands` | `self-pause: "pending-once"` | `reading-pause: "sticky"` |
| `exitZero` | `"restart"` | `"finish"` |
| `observe(crashed)` | drain・`clearSpeaking`・`lastInterruptedAt` | `from` に `sink.drainForRestart` の結果を入れる |
| `end` の扱い | stop だけが受ける | finished → drain + finishBacklog、gaveUp → discardBacklog + finishBacklog（`concludeRecorded` の claim を通す） |

60 秒の判断・終了コード 75 の窓・接続の失敗の数え方・接続と stop の競合・指令の持ち方は、`intakeAttempts` の中にしかない。直すときは `intakeAttempts.test` に足す。偽の `Helpers`（`server/test/fixtures/intakeHelpers.ts`）と TestClock で、in-process に試せる。`sessions.test` には、状態機械と配線（argv・sink の呼び出しの順・claim・status）だけを書く。前は起動し直しのループがライブと録画で 2 本あり（約 200 行）、録画の側は CLI を通す IT でしか試していなかった（[#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316)、[PR #1367](https://github.com/daiki-beppu/live-mindmap/pull/1367)）。

再開位置の決め方（`drainForRestart` が返す `TrackEnds`）と、その位置より前を捨てる処理（`applyRecordedEventFrom`）は、録画の側に残す。`intakeAttempts` は sink を知らず、受け取るのはログの書き先（`log`）だけにする。

## 接続前の失敗と、接続した後の終了を、同じ結果にまとめない

2 本のループを 1 本にしたとき、#1316 の run の最初の実装は、接続できなかった回（`HelperLaunchFailure`）を、読み終えた回と同じ `served` で返していた。takt のレビューは、そこから出た 2 つの退行を止めた。

- **録画の正常完了の取り違え**: 接続する前に終了コード 0 で落ちた回が `exitZero: "finish"` の判定に入り、`finished` になった。CLI まで成功として返った
- **ライブの途切れの時刻の上書き**: 接続前の失敗でも `observe(crashed)` を通知したので、status の `lastInterruptedAt` が、途切れた時刻 T から T+20 秒へずれた。前のコードでは、この時刻を更新するのは接続できた回の後だけだった

今は `readNext` が `served`・`connectionFailed`・`stopped` の 3 つを返す。`finished` になるのは、接続できた回が終了コード 0 で終わり、`exitZero` が `"finish"` のときだけになっている。`observe(crashed)` を呼ぶのも、接続できた回が終わったときだけにしている。確かめているのは、`intakeAttempts.test` の「録画の接続前コード0は失敗に数え、接続後コード0だけ正常完了する（接続成功=%s）」と、`cliRecorded.it` の「ヘルパーが接続前コード%sで落ち続けて諦めると、CLIは進んだ位置と最後の標準エラーを出して失敗する」。

別々だった経路をまとめるときは、旧経路ごとの後処理（時刻の更新、正常完了の判定、ログ）を表にして、まとめた後の経路と 1 行ずつ照らす。

## 試行の Scope は読み終えたら閉じる。偽物の fiber をその Scope に置くと、後の stop を待つテストが進まない

試行の Scope は、読み終えて exit と stderrTail を受け取った後に閉じる（仕様の振る舞いの変更。前の録画の側は、起動し直すときかセッションの終わりまで残していた）。閉じると、その Scope の中で fork した fiber も止まる。#1316 の実装では、録画の偽のヘルパー（`server/test/fixtures/recordedHelper.ts`）が stop の知らせを試行の Scope の中の fiber で待っていた。そのため、ヘルパーが終わった後にセッションの stop を待つ IT が進まなくなった。

本番の Scope を延ばすのは仕様に反するので、テストの側を直した。偽物の `stop` そのものからも `stopSeen` を立て、待つのはヘルパーを接続したまま保った回だけにした。偽物に、試行より長く生きる見張りを持たせない。

## `sticky` の指令は、接続のたびに既定と違うときだけ送り直す。初めの回へは送り直さない

`send` は、送り先と覚えている指令を `SynchronizedRef` 1 つで持つ。

- **`pending-once`（ライブの self-pause）**: 接続待ちの間の最新の値だけを、接続した回へ 1 回送り、送ったら忘れる
- **`sticky`（録画の reading-pause）**: 求める状態をいつも覚えておき、新しい回に接続したとき、既定（`paused: false`）と違えば送り直す。終わった前の回へは送らない

「接続したら送り直す」を素直に書くと、`openIntake` が最初の回をつないだ直後と、`run` が同じ回を読み始めるときの 2 回、同じ回へ送る。#1316 の実装はこれで `intakeAttempts.test` の 3 件を落とした（`expected length 1 but got 2`）。今の `connect` は、送り先が同じ回なら何もしない。

`pending-once` と `sticky` の違いは、同じ `Intake` を「接続 → 切れる → 指令を変える → 接続 → また接続」と続けて動かす 1 本のテストで見る。条件ごとに `Intake` を作り直すと、次の回へ持ち越すかどうかが見えない。

## `startRecorded` の配線は、本物の `Sessions` と `openIntake` を通し、偽の `Helpers` と偽の sink の境界で見る

`sessions.test` の「録画の開始と再送の配線」は、`openIntake` をモックしない。モックすると、argv の評価・指令の送り先・end を待つ順を迂回してしまう。偽の `Helpers`（台本付き）と偽の `SessionSinks` に届いた呼び出しの順を記録して見る（[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317)、[PR #1368](https://github.com/daiki-beppu/live-mindmap/pull/1368)）。

- **再開位置**: 偽の sink の `drainForRestart` は `Effect.succeed(ends)` で固定の値を返す。settling や溜まりの規則を偽物に写さない。差し替えは `openRecorded` の戻り値を `Effect.map` で包む
- **異常終了**: 台本の `unexpectedExit: { afterMs: 1, ... }` を `TestClock.adjust(1)` で起こす
- **作成日時の基準**: `sessions.ts` は `DateTime.nowUnsafe()` で実時刻を読むので、TestClock では測れない。呼ぶ前と後の実時刻を取り、`base − logShiftMs` がその間に入ることを見る
- **自然な終わりと stop の重なり**: どちらが先に claim を取るかを、`finishBacklog` や書き出しの中の Deferred で止めて決める。自然な終わりが先に取った後の `sessions.stop` は、成功ではなく失敗で返る
- **後片付け**: どのテストも最後に `sessions.stop` からイベント列の fiber の join まで行う。開始の準備だけを見るテストでも、イベント列を読みながら stop しないと Scope が閉じない

フォルダの採番と時刻のずらしの適用はファイルを書く側の話で、`loggedSessionLog.it` に残る。

## stop の順を見るテストは、ヘルパーの終わりも記録する。記録しないと end を待つことを証明しない

#1317 の前の `sessions.test` は、録画の stop の順を `[discard, helper-stop, finish, flush, exports]` で見ていた。ヘルパーが終わる（end）時点が列に無いので、`finishBacklog` が end を待たずに走っても通る。今のテストは、偽のヘルパーの終わりを `stopDelayMs: 100` で遅らせ、`exit` に `Effect.tap` で `"end"` を記録する。stop の印に届いた時点で `[discard, helper-stop]` だけであることを見てから、`TestClock.adjust(100)` で進め、`[discard, helper-stop, end, finish, flush, exports]` になることを見る。

順を約束する手続きをテストするときは、待つ相手の完了も列に入れる。

## わざと壊して timeout で落ちたら、境界を 1 ミリ秒ずらした反例で assertion にして確かめ直す

移したテストは、移した先でわざと壊して赤になることを確かめる（仕様の完了条件）。#1316 の 22 回の破壊のうち 3 回（60 秒の判断・75 の窓・シグナル付きの 75）は、assertion ではなく 20 秒の test timeout で落ちた。終わるべき 60000 ミリ秒の側が起動し直しへ進み、`end` を待ち続けたためで、依存や構文の誤りではなかった。そこで同じ境界の 60001 ミリ秒の側で 1 ミリ秒ずらす破壊を足し、起動の回数の assertion（4 に対して 3、12 に対して 11）で落ちることを確かめた（[PR #1367](https://github.com/daiki-beppu/live-mindmap/pull/1367) の報告）。

timeout は、壊したところ以外の理由（台本の数が尽きた、待ちの合図を取りこぼした）でも出る。timeout だけを「検出した」根拠にしない。

## 知らない helper のイベントは、試行ごと・type ごとに 1 度だけ標準エラーに知らせて読み飛ばす。数える集合は試行のたびに作る

`decodeHelperEvent` は、最上位の `type` が文字列で server の union に無いとき `{ kind: "unknown", type }` を返す。`handleEvent` はその type を、試行ごとの集合（`openIntake` が試行のたびに作る `Ref`）で数え、初めての type だけ「ヘルパーの知らないイベント「<type>」を読み飛ばしました。ヘルパーを作り直してください（swift build -c release --package-path helper）」を出す。セッションは止めない。直す手段は helper を作り直して起動し直すことなので、起動し直したら空から数える。集合をセッションや server の寿命で持たない。

最上位に文字列の `type` が無い入力（`{"payload":{"type":"remark"}}`・配列・`{"type":1}`）は、知らない type ではなく `SchemaError` になり、今までの読み飛ばしの文面で記録される。入れ子の `type` で分類しない。

確かめているのは `server.heavy.test.ts` の「未知イベントは起動ごと・typeごとに一度知らせ、再起動をまたいで同じ会議の発言を受け取る」で、偽の helper のスクリプトを `SIGKILL` で落として起動し直させる。仕様 [#1609](https://github.com/daiki-beppu/live-mindmap/issues/1609) はこれを `intakeAttempts.test` の層で確かめると決めていたが、実装（[PR #1643](https://github.com/daiki-beppu/live-mindmap/pull/1643)）は heavy に置き、`intakeAttempts.test` には知らせのテストが無い。知らせの規則を変えるときは、heavy のこのテストを `pnpm --filter @live-mindmap/server exec vitest run test/server.heavy.test.ts` で流すか、`intakeAttempts.test` に偽の `Helpers` で同じ場面を足す。

## 出典

- 仕様 [#1305](https://github.com/daiki-beppu/live-mindmap/issues/1305)（Formal Spec のコメントを含む）、親 [#1315](https://github.com/daiki-beppu/live-mindmap/issues/1315)
- チケット [#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316)・[PR #1367](https://github.com/daiki-beppu/live-mindmap/pull/1367)、[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317)・[PR #1368](https://github.com/daiki-beppu/live-mindmap/pull/1368)
- #1316 の takt の run（`20261019-223538-implement-using-only-the-files-k85l61`・`20261019-224050-implement-using-only-the-files-zgghr9`）の計画・実装の報告と決定ログ・レビューと裁定・修正の報告
- #1317 の takt の run（`20261020-004956-implement-using-only-the-files-4gxc99`）の計画・実装の報告と決定ログ・破壊検証の記録
- 仕様 [#1609](https://github.com/daiki-beppu/live-mindmap/issues/1609)、チケット [#1618](https://github.com/daiki-beppu/live-mindmap/issues/1618)・[PR #1643](https://github.com/daiki-beppu/live-mindmap/pull/1643) の差分、[開発ログ](../devlog/2026-10-27.md#seam-contract-tests)
