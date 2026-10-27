# 共有画面のキュー

差分更新に添える共有画面の扱いを触るときに読む文書。触る場所は、`server/src/core/screenQueue.ts` の `ScreenQueue` と、それを呼ぶライブ（`session.ts` の `pushScreen`・`callUpdater`）と復元（`restoreState`・`restoreSession`）。規則を変えるときの直し方、ログの行とキューの操作の順の守り方、テストの置き場所を書く。

- 用語: [共有画面・差分更新・一時停止](../../GLOSSARY.md)
- ADR: [0025 共有画面は 1 つの純粋なキューで扱い、消費はログの `diff` の行を入力に行う](../adr/0025-screen-queue-select-without-state-consume-by-diff-row.md)、[0024 差分更新の反映](../adr/0024-reflect-diff-row-in-one-pure-fold.md)、[0011 共有画面を直接取り込む](../adr/0011-capture-shared-screen-directly.md)
- 関連する知識文書: [差分更新の反映](reflection.md)、[差分更新の問い合わせの続き](diff-continuation.md)

## キューの状態を変えたら、ログの行を書く側と同じ区間に入れる。どちらか片方だけの区間では、復元とライブがずれる

ライブは Session ごとに 1 つの `Semaphore`（`screenTransitions`）を持ち、ログの行を書くこととキューの操作をその permit の中で行う。囲んでいるのは次の 4 か所だ。

| 区間 | 順 |
|---|---|
| `pushScreen` | `screen` の行を書く → `receive`（`Effect.uninterruptible` も掛ける） |
| 成功の回 | `Ref.modify` の中で `reflectDiff` と `consume` → `diff` の行 |
| エラーで終わった回 | `consume` → エラーつきの `diff` の行 |
| 一時停止の回 | `markPaused` → `diff-update-paused` の行 |

復元はログを行の順に読み、行ごとに同じ操作を呼ぶ。ライブのキューの操作の順がログの行の順とずれると、復元だけが違う状態になる。仕様 [#1638](https://github.com/daiki-beppu/live-mindmap/issues/1638) の formal-spec では、受け取りを行の後に回しただけのモデルで、TLC が 6 手の反例を出した。行を書く → 一時停止（印は空）→ 再試行の `diff` → 受け取る（動いている状態なので印なし）。復元は `screen` → `diff-update-paused` の順に読むので、印を画面に付ける。片方の区間だけを囲んだモデルにも反例が残った。両方を囲んだモデルは 591,236 状態をすべて通った。

新しくキューを変える操作を足すとき、またはキューを変える場所でログの行を書くときは、同じ permit に入れる。`select` は状態を変えないので区間の外でよい。画像の読み戻しや AI の応答の待ちを区間に入れると、その間 `pushScreen` が止まる。

## 排他だけでは足りない。`pushScreen` の区間は中断もできなくする

`screen` の行を書いた直後・`receive` の前に Fiber が中断されると、その画面は「ログにはあるが、ライブのキューには無い」状態になる。復元すると、ライブでは添えなかった画面を添える。TLA+ のモデルは中断を扱わないので、反例には出てこない。#1654 は区間を `Effect.uninterruptible` で包み、中断のテストを `sessionScreenOrdering.test.ts` に 1 件置いた。区間の書き方を変えるときは、途中で止まったら何が残るかも確かめる。

## 消費は `seq` で区切る。締め切りだけで外すと、呼び出し中に届いた古い時刻の画面を添えずに捨てる

`consume` は、`diff` の行の `screenCount`（選んだ時点で受けていた数）より `seq` が小さく、かつ締め切りまでの画面だけを外す。呼び出しの間に届いた画面は、時刻が締め切りより前でも残る。`sessionScreen.test.ts` の後着の画面のテストは、最初の回の締め切りを 30 にし、呼び出し中に時刻 10・20 の画像と 21 の「なし」を届けて、次の回の入力が `[10, 20, 21]` になることを見る。締め切りだけで外す誤りは、このテストで落ちる。

`screenCount` が受けた数より大きい `diff` の行は、`consume` が失敗を返す。復元ではその行の位置の `InvalidLogEvent`、ライブでは defect になる。

## 追いつきの印は、`unsent` の中の同じ要素への参照で持つ。`unsent` を写し直すと印が黙って外れる

`consume` は `unsent.includes(queue.catchUp)` で印の画面が残っているかを見る。比べるのはオブジェクトの同一性だ。`unsent` の要素を `map` などで作り直すと、同じ画面でも一致せず、印が外れて 3 件上限に戻る。今は復元したキューを変換せずに `openSession` へ渡している（`RestoredScreens` は `queue` と `files` だけ）。#1652 の途中、復元の結果をライブの旧来の形に写していた間は、印を `unsent[queue.unsent.indexOf(queue.catchUp)]` で引き直す必要があった。キューの外で状態を組み立て直す処理を足すなら、印も作り直した配列の中の同じ要素を指させる。

## 追いつきのテストは、上限より多い 4 枚の画面で書く

追いつきの印があるかどうかで変わるのは、`SCREENS_MAX`（3）を外すかどうかだけだ。画面が 3 枚以下なら、印の有無で添える画面は変わらない。`sessionScreenOrdering.test.ts` と、`restore.test.ts` の「一時停止のログから復元しても…全部添える」は、4 枚以上を使う。仕様 #1638 の formal-spec のモデルの `invCapUnlessCatchUp` も、上限を 2 に縮めた構成で同じことを確かめている。

## 規則の中身は `screenQueue.test.ts` の期待値で、Session のテストには配線だけを置く

キューの操作の入力と出力だけで確かめられる規則（締め切りと境界、時刻順、3 件上限、10 秒の間隔と持ち越し、1 度だけ添える、印の選び方、画像を添えない）は `screenQueue.test.ts` に置く。Session も偽の更新器も通さない。Session のテスト（`sessionScreen`・`sessionPause`・`sessionScreenOrdering`）と `restore.test.ts` には、キューの interface から見えない配線だけを置く。ログの行と画像のファイル、どの結末で消費するか、受け取りと結末の順、行の種類ごとの「復元した続き = 元の続き」だ。同じ規則を両方の層で確かめない。

「ライブ = 復元」は同じ行で同じ操作を呼ぶ作りで成り立つので、持ち越しや 10 秒の起点が元と一致するかを規則ごとに見るテストは足さない（#1652 で 4 件消した）。

## 更新器へ渡す画像の id はファイル名。id の形を前提にしたテストは、対象のファイルの外にもある

#1653 で、画像の id は helper の id から保存したファイル名（`0005.0.jpg` など）に変わった。対象の 5 ファイルのテストは通ったが、ルートの `pnpm test` で `remarkFlow.test.ts` の 2 件が落ちた。helper の id の形を前提にしていた。直すときは、そのテストが守りたいもの（画像のバイト列が feed を通って届くこと）を見る形にし、id の形を写さなかった。id の形は Session のテストが確かめている。画面の id や行の形を変えたら、対象のファイルだけでなくルートの `pnpm test` まで回す。

## TLC が通っても、共有画面の順の約束は保証しない

`verify-diff-update-scheduler` の TLA+ のモデルは、差分更新の呼び出しの段取りだけを持つ。共有画面・ログ・復元は含まない。#1653・#1654 で TLC（11 検査）が示したのは、段取りを変えていないことだけだ。ログの行とキューの順は `sessionScreenOrdering.test.ts` が確かめる。このテストは、偽のログの書き込みを `Deferred` で止め、更新器の応答も止めて割り込みを作り、ライブの続きと `restoreSession` の続きが添える画面（時刻・ファイル名・バイト列）を比べる。

formal-spec の反例をそのまま写した 1 件は、実装の前から緑だった。この反例が狙うのは、順を入れ替えただけの実装だ。番人として効いているかは、その実装に対して落ちるかを見ないとわからない。区間を書き換えるときは、片方の区間を外した実装でこのテストが落ちることを確かめる。

## 出典

- 仕様 [#1638](https://github.com/daiki-beppu/live-mindmap/issues/1638)（Formal Spec のコメントを含む）、親 [#1651](https://github.com/daiki-beppu/live-mindmap/issues/1651)
- [#1652](https://github.com/daiki-beppu/live-mindmap/issues/1652)・[PR #1672](https://github.com/daiki-beppu/live-mindmap/pull/1672)、[#1653](https://github.com/daiki-beppu/live-mindmap/issues/1653)・[PR #1673](https://github.com/daiki-beppu/live-mindmap/pull/1673)、[#1654](https://github.com/daiki-beppu/live-mindmap/issues/1654)・[PR #1674](https://github.com/daiki-beppu/live-mindmap/pull/1674) と、それぞれの takt の run（`20261027-074139-issue-1652-nokyuuwo-ri-restore-itiaf5`・`20261027-084931-issue-1653-raibu-session-no-wo-66bcbk`・`20261027-101629-issue-1654-pushscreen-wo-scree-7q88my`・`20261027-104833-merge-pr-1674-j8t7cz`）の計画・決定ログ・報告
- [開発ログ](../devlog/2026-10-27.md#screen-queue)
