# 差分更新の反映

差分更新 1 回の結果（ログの `diff` の行）をセッションの状態に当てる処理を触るときに読む文書。触る場所は、`server/src/core/reflection.ts` の `reflectDiff` と、それを呼ぶライブ（`session.ts` の `callUpdater`）・復元（`restoreState`）・計測（`logMetrics.ts`）。規則を変えるときの直し方、呼ぶ側の失敗の扱い、どのテストで確かめるか、順序に頼っている所を書く。

- 用語: [反映・差分操作・一時停止](../../GLOSSARY.md)
- ADR: [0024 差分更新の反映は、ログの `diff` の行を入力にした 1 つの純粋な関数にする](../adr/0024-reflect-diff-row-in-one-pure-fold.md)、[0007 中核は Effect 本体に依存する](../adr/0007-core-session-on-effect.md)
- 関連する知識文書: [差分更新の問い合わせの続き](diff-continuation.md)、[過去のセッションのフォルダの読み側](session-folder-reading.md)

## 処理した発言の数え方・印・履歴の進め方は `reflectDiff` の中だけで直す。呼ぶ側に手順を書かない

消費する数（エラーの回は `fresh` の全部、成功の回は `processedRemarks ?? fresh.length`）、印（round は前 + 1、時刻は消費した発言の `end` の最大）、`applyOps`、エラーの無い回だけ `recordRound`、は `reflectDiff` が持つ。`stampOf` は外へ出していない。呼ぶ側に同じ手順を書き足すと、3 か所の写しが食い違っていた前の状態に戻る（計測だけが処理数の超過を切り詰めて数字を出していた）。

呼ぶ側に残すのは、反映の外のものだけだ。

| 呼ぶ側 | 反映の外で持つもの | 反映の失敗 |
|---|---|---|
| ライブ `callUpdater` | `attributePeople`（行を組む前に 1 回）、`InvalidProcessedRemarks` の判定、話者名の受け入れ、一時停止からの戻り、`nextRetryAt`・`reflecting`・前回の応答・`pending` の残り | `Result.getOrThrowWith` で例外にし、defect |
| 復元 `restoreState` | 共有画面のキューの操作（[共有画面のキュー](screen-queue.md)）、一時停止からの戻り | 行の位置つきの `InvalidLogEvent` |
| 計測 `logMetrics` | 書き換えの数え方（`rewrittenIds`）、閉じていない兄弟の数 | 行の位置つきの `InvalidLogEvent` |

## ライブでは、反映を既存の `Ref.modify`・`Ref.update` の中で呼ぶ。`Ref.get` で先に読まない

`Ref` の操作の間には別の Fiber が割り込めるので、読むのと書くのを分けると、古い状態で畳むおそれがある。差分更新の呼び出しの TLA+ のモデル（`verify-diff-update-scheduler` スキル）は、`Ref` の操作 1 回を 1 つの遷移にしている。#1596 は反映を既存の 2 か所のコールバックに入れたので、操作の回数・順序が変わらず、モデルの遷移は直さずに済み、TLC は 6 つの性質を 11 の構成ですべて通した。

## TLA+ のモデルの注釈の行番号は、ずれている前提で読む。関数の名前と `Ref` の操作で探す

`server/formal/DiffUpdateScheduler.tla` は遷移ごとに `session.ts` の行番号を注釈に書いている。スキルは `Ref` の操作の回数・順序・条件が変わらない変更では TLC を回さなくてよいとしているので、行がずれるだけの変更では注釈を誰も直さない。#1596・#1597 の後にもずれ（成功の回の `Ref.modify` が 1 行、`runCall :422` が別の行）が残り、#1654 で合わせ直したときには 80 行前後ずれていた（`startDiffIfReady` は `:393–409` ではなく `:312–328`）。スキルの「最後に合わせた PR」（今は #1674）から `git log` で後の変更を出せば、ずれの有無はわかる。対応を探すときは、注釈の行番号ではなく、`callUpdater` の中の `Ref.modify(ref` などで引く。

## 検査は新しい値を作る前に全部済ませる。失敗の回は入力の状態を書き換えない

`reflectDiff` は、`fresh` の id をすべて台帳で引き（消費しない残りの id も）、処理数を確かめてから、新しい Set と配列を作る。前の復元の `consumeFresh` は台帳をその場で書き換えながら進み、途中で落ちると半分だけ書き換わった台帳が残りえた。`reflection.test.ts` の成功の回・エラーの回・失敗の回のテストは、入力の状態（成功の回は行も）を `structuredClone` で取っておき、呼んだ後に変わっていないことを見る。規則を足すときも、この順を崩さない。

## 時刻は 2 種類ある。共有画面の境は `fresh` 全体、反映の印は消費した発言だけ

一部だけ処理した回（`processedRemarks` が `fresh` より少ない）では、2 つの時刻が違う。共有画面を選ぶ・消費する境（`ScreenQueue.select`・`consume` に渡す `cutoff`）は `fresh` 全体の `end` の最大、反映の印は消費した発言だけの `end` の最大だ。中身のない発言も、消費していれば印の時刻に数える。`reflection.test.ts` の「部分成功では…残りの end を stamp に使わない」は、消費しない側に遅い `end`（90）を置き、取り違えたら落ちるようにしている。

## 復元では、共有画面の締め切りを `reflectDiff` の後に求める

`restoreState` は、`ScreenQueue.consume` に渡す締め切りを `ledger.byId.get(id)!.end` で求める。台帳に無い id は直前の `reflectDiff` が先に弾くので安全だが、その安全は型ではなく呼ぶ順で守られている。並びを入れ替える、締め切りを別の所で求める、のどちらかをするなら、id の検査もそこに持たせる。

## 反映の中身は `reflection.test.ts` の期待値で、外は `restore.test.ts` の往復 1 本で確かめる。往復を足して反映の誤りを探さない

ライブと復元が同じ関数で同じ行を畳むので、反映に誤りがあっても往復は一致して通る。往復で落ちるのは、行の組み立て・書き込み・読み戻しの誤りだけだ。反映の規則を変えたら、`reflection.test.ts` に入力の行と前の状態から期待値を書く（前例は `applyOps.test.ts`）。今の議題・時刻・ノードの印が元と一致するかを往復で見るテストは、#1596 で 3 本消した。同じ値は `session.test.ts` と `applyOps.test.ts` が期待値で持っている。

計測の失敗の位置は `logMetricsPartial.test.ts`、復元の失敗の位置は `restore.test.ts` の「diff が挙げた発言がログに無ければ…」が見る。失敗の理由の中身は `reflection.test.ts` だけが見る。

## 計測の `rewrittenIds` は、操作の区切りごとに反映を呼ぶ。区切りの反映は失敗しないので、`Result` の失敗の経路は通らない

`rewrittenIds` は、操作の列を先頭から 1 件、2 件と区切り、どれも反映前の同じ状態から `reflectDiff` にかけ、前後で本文が変わったノードを数える。`reflectDiff` の出力を広げずに「1 回の応答の中で何回書き換わったか」を数えるための形だ（#1597 の計画で、検査だけ足す案と出力を広げる案を捨てた）。

`reflectDiff` の検査は `fresh` と `processedRemarks` しか見ず、`ops` に依らない。行全体の反映が先に通っているので、区切りの反映は失敗しない。`rewrittenIds` が返す `Result` の失敗は、今は通らない経路だ。また、区切りごとに `recordRound`（変わったことの連結）と既知の Set の複製が走るので、1 行の仕事は操作の数 × 履歴の長さで増える。長いログで計測が遅くなったら、まずここを見る。

## 出典

- 仕様 [#1593](https://github.com/daiki-beppu/live-mindmap/issues/1593)（Formal Spec のコメントを含む）、親 [#1594](https://github.com/daiki-beppu/live-mindmap/issues/1594)
- [#1595](https://github.com/daiki-beppu/live-mindmap/issues/1595)・[PR #1598](https://github.com/daiki-beppu/live-mindmap/pull/1598)、[#1596](https://github.com/daiki-beppu/live-mindmap/issues/1596)・[PR #1599](https://github.com/daiki-beppu/live-mindmap/pull/1599)、[#1597](https://github.com/daiki-beppu/live-mindmap/issues/1597)・[PR #1600](https://github.com/daiki-beppu/live-mindmap/pull/1600) と、それぞれの takt の run（`20261026-061655-issue-1595-wo-1-tsuno-mi-minis-2ryel7`・`20261026-072819-issue-1596-raibuno-no-wo-no-mi-ufij5c`・`20261026-094505-issue-1597-logmetrics-wo-no-mi-uu6mix`）の計画・決定ログ・報告
- [開発ログ](../devlog/2026-10-26.md#reflect-fold)、[共有画面をキューにしたときの開発ログ](../devlog/2026-10-27.md#screen-queue)
