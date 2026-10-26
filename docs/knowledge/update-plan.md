# 更新の計画

差分更新のモデルと判定のモデルの選び方（`server/src/updatePlan.ts` の `resolvePlan`・`acceptPlan`・`needsTransferToken`・`planLayer`）と、それを呼ぶ CLI の `start`・`recorded`・`play`・`eval`、server の `/session/start`・`/session/recorded` の配線を触るときに読む文書。振り分けるかの条件をどこに置くか、server が本文をどう検めるか、判定の鍵をどのプロセスで見るか、どの層のテストで確かめるかを書く。決定そのものは仕様 [#1306](https://github.com/daiki-beppu/live-mindmap/issues/1306)（Formal Spec のコメントを含む）と、その元の [#1239](https://github.com/daiki-beppu/live-mindmap/issues/1239) の解決コメントにある。

- 用語: [更新の計画・振り分け・判定・判定のモデル・差分更新のモデル・ローカルモード](../../GLOSSARY.md)
- ADR: [0020 判定は判定のモデルを差し替えられる口の後ろに置き、無くても動くようにする](../adr/0020-judge-behind-swappable-port-optional.md)、[0014 ローカルモードで選べる差分更新のモデルは、live-mindmap が起動する子プロセスだけにする](../adr/0014-local-mode-only-own-child-processes.md)
- 関連する知識文書: [CLI と server の受け渡し](server-protocol.md)

## 振り分けるかは `resolvePlan` の 1 か所で決める。条件は 3 つで、「組み込みの claude のまま」も外せない

`resolvePlan` は設定を 1 回だけ読み、次の 3 つがそろったときだけ `routed` を返す。どれかが欠ければ `single`。

- **判定が選ばれている**: `off` でなく、ローカルモードで判定を明示しなかったのでもない（ローカルモードでクラウドの判定を明示したら、計画を作らずに断る）
- **差分更新のモデルを名指ししていない**: `--model`・`LIVE_MINDMAP_MODEL`・設定の `default` のどれも無い（`namedByUser`）
- **モデルが組み込みの claude のまま**: 設定の `models.claude` で中身（`model`・`maxTokens`・`images`・`extraBody`）を替えていない（`isBuiltInClaude`）

仕様は「`modelChosenByUser` と `isBuiltInClaude` の 2 つの規則を無くす」と書いていたが、[#1309](https://github.com/daiki-beppu/live-mindmap/issues/1309)（[PR #1328](https://github.com/daiki-beppu/live-mindmap/pull/1328)）は 2 つとも `updatePlan.ts` に移して残した。設定で claude の中身を替えるのは名指しではないが、振り分けの先は組み込みの Sonnet 5.5 / Haiku 5.5 なので、替えた中身が黙って捨てられてしまう。`updatePlan.test` の「設定で claude の中身を替えていたら、名指ししなくても single で、替えたモデルを持つ」がこの条件を見ている。

`resolvePlan` は判定の鍵を見ない。鍵が環境に無くても `routed` を返す（「何も指定しなければ jev で routed になる。鍵が環境に無くても single にしない」）。

## server は本文を `acceptPlan` で検めるだけ。別の計画へ読み替えず、受けられない組み合わせは 400 で断る

`acceptPlan` は設定も環境変数も読まない。本文の `judge` があれば `routed`、無ければ `single` として受ける。CLI が作らない組み合わせも、手で組んだ本文では届く。そういう本文は、`single` に直して受けたりせずに断る。

- **ローカルモードのモデルと `judge`**: 断る（形式仕様の `invAcceptNeverRoutesLocally`）
- **組み込み以外のモデルと `judge`**: 断る。CLI の `planBody` は `routed` の本文に必ず組み込みの claude を載せるので、この組み合わせは手で組んだ本文からしか来ない。#1309 のレビューでこれが新しい 400 として挙がったが、裁定は「根拠なし」で修正を求めなかった

server の側で黙って読み替えると、CLI が知らせた計画と実際の計画がずれる。仕様が直そうとしたのは、このずれだった。

## 判定の鍵は `planLayer` だけが見る。効くのは layer を作るプロセスの環境

`planLayer` は、セッションを動かすプロセスで呼ぶ。`start`・`recorded` は server（`server.ts` が `StartupChecks.layer` の `prepareUpdater` に渡す）、`play`・`eval` は CLI。`routed` で鍵が足りなければ、判定なしの組み込みの claude で始め、`missingKeyNotice` の 1 行を `notice` で返す。

- **`start`・`recorded`**: `StartupChecks.prepare` が確認の警告の後ろに `notice` を一度だけ足す。`sessions.ts` は、その `warnings` を開始の応答で CLI へ返す
- **`play`・`eval`**: CLI が `writeWarnings` で出す

前は、CLI の `selectJudge` が CLI の環境で鍵を確かめて知らせを出し、server の `prepareRouted` は server の環境に鍵が無いと黙って振り分けなしにしていた。CLI の環境にだけ鍵があると、CLI は鍵が無いという知らせを出さず、server は振り分けずに組んでいた。利用者には振り分けているように見えていた。鍵を見るのを 1 か所にしたので、知らせは実際に layer を作った環境の結果だけになる。鍵を見る処理を足すときも、`planLayer` の外には置かない。

## セッションに渡すのは計画だけ。モデルが要るところは `planModel` で導く

`SessionStart` と `RecordedStart` は `plan` を持ち、`model` の欄を持たない。ログ・`StartupChecks` に渡す経路・`sessionMode` の `local` に要るモデルは、`planModel(plan)` で導く（`routed` なら組み込みの claude）。`model` を `plan` と並べて持たせると、2 つが食い違う形をまた作ることになる。

[#1310](https://github.com/daiki-beppu/live-mindmap/issues/1310)（[PR #1370](https://github.com/daiki-beppu/live-mindmap/pull/1370)）の前は、`RecordedStart` だけが `model` を持ち、`sessions.ts` が `{ kind: "single", model }` を組んで `sinks.prepare` に渡していた。録画からのセッションで判定が届かなかったのは、この形のせいだった。

## 選び方は `updatePlan.test`、鍵の有無は `judgeRouting.test`、配線は偽の `prepareUpdater` が受けた計画で見る

| 確かめること | 置き場所 |
|---|---|
| `single` / `routed` の分かれ方、判定の選択順、ローカルモードの拒否、`acceptPlan` の断り、`planBody` との往復、転送用トークンの規則 | `updatePlan.test`（test ConfigProvider とメモリ上の設定） |
| 鍵が無い・空・空白のときの `notice`、Cloudflare の 2 つの鍵 | `judgeRouting.test`（偽の SDK で `planLayer` を呼ぶ） |
| 計画が `StartupChecks` の `prepareUpdater` まで届くこと | `sessions.test`（録画の判定を含む計画をそのまま渡す） |
| `notice` が確認の警告の末尾に一度だけ入ること | `startupChecks.test`（公開の準備操作） |
| CLI の引数が本文の `judge` になること、ローカルモードで要求を送る前に断ること | `cliRecorded.it` |

`ServerOptions.prepareUpdater` は `StartupChecks.layer` に渡す。`SessionSinks` は準備の依存を持たず、準備済みの `updaterLayer` を受け取ってセッションの Scope で開く。

配線の層では、環境変数に鍵を置いて分岐させない。偽の `prepareUpdater` に受けた計画を記録させ（`prepared`）、知らせが要るテストでは `notice` を返させる。鍵の有無で分かれる規則は `planLayer` の unit だけが見る。

## IT の CLI は `LIVE_MINDMAP_JUDGE=off` で動く。既定の判定を試すときは、その環境変数を消す

`cli.it`・`cliRecorded.it`・`eval.it`・`startupDeps.it` などの CLI の環境は、どれも `LIVE_MINDMAP_JUDGE: "off"` を入れている。上書きしないと、どのテストも判定なしの `single` で走る。#1310 は `cliRecorded.it` の `CliOptions.env` に `undefined` を渡せるようにし、`{ LIVE_MINDMAP_JUDGE: undefined }` でこの既定を消してから、「判定を省くと jev を送り…」を試した。

既定の `jev` や選択順を IT で見るときは、まずこの環境変数を消すか上書きする。消し忘れても、テストは `off` のまま通ってしまう。

## `cli eval` は振り分けを通さない。`--model` は名指しなので、計画はいつも `single` になる

`eval` は `--model` を付けたときだけ元のログを再生し直し、その `--model` を `resolvePlan` に渡す。名指しなので、計画は必ず `single` になる。`--judge` のフラグも無い。#1309 の完了条件の「`cli eval` を前後に回し、計画が同じなら結果は変わらないはず」は、振り分けについては比べようがない。形式仕様の `invRoutesInEveryCommand`（どのコマンドでも、名指しなしなら振り分ける）も、`eval` では前提が成り立たない。

振り分けを含めて差分更新を回すのは、`play`（`--judge` がある）・`start`・`recorded`。振り分けの規則を変えたときの前後の比較を `eval` だけで済ませない。

## 出典

- 仕様 [#1306](https://github.com/daiki-beppu/live-mindmap/issues/1306)（Formal Spec のコメントを含む）、親 [#1307](https://github.com/daiki-beppu/live-mindmap/issues/1307)
- チケット [#1309](https://github.com/daiki-beppu/live-mindmap/issues/1309)・[PR #1328](https://github.com/daiki-beppu/live-mindmap/pull/1328)、[#1310](https://github.com/daiki-beppu/live-mindmap/issues/1310)・[PR #1370](https://github.com/daiki-beppu/live-mindmap/pull/1370) の差分
- PR のレビューの takt の run（`20261018-022556-evaluate-pull-request-1328-usi`・`20261020-025344-evaluate-pull-request-1370-usi`）のレビューと裁定
