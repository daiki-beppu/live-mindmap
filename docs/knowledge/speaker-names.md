# 話者の名前の包み

話者のラベルに付く名前の所有者と、入力・保存・配信・書き出しへの経路を説明する。名前の表は `server/src/core/session.ts` の `SessionState` が持つ。採否の規則は `core/speakerNames.ts`、ファイル保存と frame の配信は `sessionFiles.ts` が担当する。現在の分担は仕様 [#1637](https://github.com/daiki-beppu/live-mindmap/issues/1637) と実装 [#1656](https://github.com/daiki-beppu/live-mindmap/issues/1656) に従う。

- 用語: [話者・話者の名前・再生・エクスポート](../../GLOSSARY.md)
- 関連: [セッションの開始とブラウザへの送り口](session-start-and-viewers.md)、[セッションの sink](session-sink.md)

## 名前の変更は `Session.nameSpeaker` を通す

名前の表はラベルごとに `{ name, source }` を持つ。画面の手入力は sink がラベルと空名を検査してから `session.nameSpeaker` に `source: "手入力"` で渡す。推定名は core が差分反映後の `known` と根拠の発言を照合し、受理した名前を同じ操作に `source: "推定"` で渡す。名前行は diff 行の後に書く。

`nameSpeaker` は既存の純粋関数で採否を決め、変更時だけ状態を更新して `SessionLog.write` に名前行を渡す。名前は trim し、空なら変更しない。手入力は推定で替えず、推定どうしの別名への変更は名乗りの場合だけ受け入れる。同じ名前・同じ source の再送では行を増やさない。`basis` は採否にだけ使い、表にも名前行にも保存しない。

状態更新からログへの引き渡しは、core の既存の直列化区間で中断されないように実行する。推定名の操作は diff の区間を抜けた後に呼び、同じ semaphore を取り直さない。

## core が次の入力と export に現在名を渡す

差分更新を呼ぶとき、core は自分の表から `DiffInput.speakerNames` を作る。`session.exportJson` も同じ表を `toJsonExport` に渡す。表が空なら export に `speakerNames` キーを出さない。shell に名前表や updater・export の decorator は置かない。

ライブ・録画・再生・評価・bench は同じ core の名前操作を使う。再生は空の表から始め、元ログの名前を持ち越さない。`restoreState` も名前行を読み飛ばし、名前表は空で返す。名前行の復元は後続の #1657 の範囲となる。

## shell が名前行と export を保存し、frame を送る

`openLogged` が `SessionLog.write` で名前行を受けると、ほかの行と同じ `serialized` の下で `writeLogLine` と `writeExport` を続けて実行する。その後、セッションの `exportJson.speakerNames` から現在の表を組み立て、`speaker-names` の frame を送る。開いた直後の空の frame も維持する。名前専用の表・ロック・callback は持たない。

名前変更が完了した時点で、追加の発言がなくてもディスクの `export.json` は更新済みとなる。最後の名乗りの後に発言がない場合も、名前を保存する必要がある。[PR #1517](https://github.com/daiki-beppu/live-mindmap/pull/1517) では、名前の操作が export を保存しないとこの条件を満たせないことが分かった。

`appendLog` は自分で `serialized` を取るため、その中から呼ばない。ロックの中では `writeLogLine` と `writeExport` を使う。保存失敗は defect として伝える。

ライブと `recordPlayback` は、書き出しへ渡す名前をどちらも `session.exportJson.speakerNames` から作る。Markdown はこの名前を案の提案者などに使う。HTML はログを埋め込み、見返し画面が名前行から最後の名前を読む。

## テストは所有する契約の入口から観測する

`server/test/session.test.ts` は、偽 updater と偽ログを使い、手入力・推定名の名前行、diff 後の順序、次回入力、export を観測する。表の Ref やロックは覗かない。純粋な採否規則の組み合わせは `speakerNames.test.ts` が担う。

`loggedSessionLog.it.test.ts` と `speakerNames.it.test.ts` は shell の保存と frame、sink の受付を観測する。名前変更直後、次の発言を入れる前にディスクの export を読む。中断と競合はログの書き込みを Deferred で止めて順序を決め、export 保存失敗は書き込み先にディレクトリを置いて確認する。

再生の配線は `server/test/eval.it.test.ts` の play と eval の検査が担う。CLI から再生し、生成 Markdown の名前欄と HTML の埋め込み名前行を読む。play の frame と eval が送り口を開かないことも観測する。

## 名前が入力に載ると、名前は当たり、TODO の担当の一致は下がった（1 回の比較）

#1447 の run が、合成の会議 1 本（23 分、`~/live-mindmap-samples/synth/screen`）で、変更前の main と変更後を同時に流した。差分更新は Claude、判定は使わない。値は 1 回ずつで、合否は無い。

| 指標（`peopleAccuracy`・`cli eval`・`mapShape`） | 前（名前なし） | 後（名前つき） |
|---|---:|---:|
| 名前が付いたラベル / 正しい | 0 / n/a | 2 / 100% |
| 最初の発言から名前が付くまで（中央値） | — | 522.6 秒 |
| TODO の再現 | 7/7 | 6/7 |
| TODO の担当が合う | 57.1% | 33.3% |
| TODO の担当が人なし | 0.0% | 16.7% |
| 子が 1 つのノード | 43（18%） | 62（26%） |

「名前が載れば担当も名前で合う」という見込みとは逆に動いた。理由は調べていない。名前の推定や、名前を載せた後の差分更新のプロンプトを触るときは、この前後を同じ素材で取り直して比べる。

## 出典

- [開発ログ: 話者の名前の包みをログを開く口に集めたとき](../devlog/2026-10-25.md#speaker-name-wrap)
- 仕様 [#1437](https://github.com/daiki-beppu/live-mindmap/issues/1437)（Formal Spec のコメントを含む）、決定の一次資料 [#1425](https://github.com/daiki-beppu/live-mindmap/issues/1425)、親 [#1443](https://github.com/daiki-beppu/live-mindmap/issues/1443)
- チケット [#1447](https://github.com/daiki-beppu/live-mindmap/issues/1447)・[PR #1517](https://github.com/daiki-beppu/live-mindmap/pull/1517)（マージの run `20261024-160015-merge-pr-1517-obxbck` の `coding-review.md`・`fix-plan.md`・`fix-report.md`）、[#1448](https://github.com/daiki-beppu/live-mindmap/issues/1448)・[PR #1520](https://github.com/daiki-beppu/live-mindmap/pull/1520)、[#1449](https://github.com/daiki-beppu/live-mindmap/issues/1449)・[PR #1521](https://github.com/daiki-beppu/live-mindmap/pull/1521)
- #1447 の takt の run（`20261024-150123-issue-1447-no-no-miworoguwo-ku-yghm6h`）の計画・実装の報告と、`.takt/issue1447-validation/evals/` の Evals のログ
