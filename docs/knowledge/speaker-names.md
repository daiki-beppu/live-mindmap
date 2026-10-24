# 話者の名前の包み

相手の話者のラベルに付く名前（AI の推定と画面からの手入力）を、どこで持ち、どこへ出すかを触るときに読む文書。名前の表・`log.jsonl` の `speaker-name` の行・`speaker-names` の frame・`export.json`・差分更新の入力の `speakerNames` を変える処理（`server/src/sessionFiles.ts` の `openLogged` の `nameSpeaker`）と、それを使うライブ・録画からのセッション・`cli play`・`cli eval`・bench の `sttReplay` が対象になる。名前の付け方の規則（手入力は推定で変えない、推定の付け替えは名乗りのときだけ、付いた名前は外れない）は core の `speakerNames` にあり、ここでは扱わない。決定そのものは仕様 [#1437](https://github.com/daiki-beppu/live-mindmap/issues/1437) と、その元の [#1425](https://github.com/daiki-beppu/live-mindmap/issues/1425) の解決コメントにある。

- 用語: [話者・話者の名前・再生・エクスポート](../../GLOSSARY.md)
- ADR: 無し（仕様が、`openLogged` の中の配線で後から戻せると決めている）
- 関連: [セッションの開始とブラウザへの送り口](session-start-and-viewers.md)（`send` と開いた直後の空の frame）、[セッションの sink](session-sink.md)

## 名前を変える経路は `openLogged` が返す `nameSpeaker` の 1 つだけにする。呼び出し側に表や decorator の写しを作らない

ライブ・録画からのセッション（`sessionSinks`）、再生と評価（`cli` の `recordPlayback`）、bench（`sttReplay`）は、どれも `openLoggedSession`・`openLoggedTranscriptSession` を通る。名前の表の `Ref`、名前のロック、差分更新の入力に名前を載せる decorator、frame の送りは、その中に置いてある。呼び出し側がすることは、送り口 `send`（省略できる）を渡し、返ってきた `nameSpeaker` を呼ぶことだけだ。AI の推定名は `openLogged` が core から受けて `source: "推定"` で、画面の手入力は sink が `source: "手入力"` で、同じ `nameSpeaker` に入れる。

前は 3 か所が別々だった。sink は包みを持ち、bench は「ライブと共有する」と注に書いた写しを持っていたが、写しにはロックと frame が無かった。`cli play`・`cli eval` は包みを通らず、AI が返した名前を捨てていたので、`cli eval` は差分更新のプロンプトを本番と違う名前なしの入力で測っていた。「`cli play` は渡さない」に理由は書かれておらず、配線が抜けていただけだった（#1437 の Problem Statement）。

経路ごとに違うのは `send` を渡すかどうかだけにしてある。ライブ・録画・`cli play` は渡し、`cli eval` と bench は渡さない。再生は元のログの `speaker-name` の行を読まず、空の表から始める（`loadSessionLog` が選ぶ行に `speaker-name` が無い）。

## 名前の見え方は 4 つある。名前を変える区間の中で、ログの行・表・`export.json` を同じ書き込みのロックの下で続けて書く

名前の表には、表そのもののほかに見え方が 4 つある。`log.jsonl` の `speaker-name` の行、ブラウザへの `speaker-names` の frame、`export.json`（`session.exportJson` が今の表を足して返し、`cli export` はディスクのファイルを読む）、次の差分更新の入力の `speakerNames` だ。

`export.json` は、core がログに 1 行書くときにも書き直される。けれども推定名の経路では、core は diff の行を書いて `export.json` を保存した後で名前を通知する。名前の操作で `export.json` を書かないと、最後の名乗りの後に発言が無いとき、ディスクの `export.json` に名前が無いか、前の名前が残る。[PR #1517](https://github.com/daiki-beppu/live-mindmap/pull/1517) の takt の PR レビューがこれを挙げ、マージの前に、名前の操作の中で `serialized` の下で `writeLogLine` → `Ref.set` → `writeExport` を続けて書くように直した。frame はそのロックを出た後、名前のロックの中で送る。

#1437 の形式仕様（Quint のモデル、仕様のコメント）が揃うと証明しているのは、表・ログの行・frame の 3 つだけで、`export.json` はモデルに無い。`export.json` は、実装の計画が書き出しの名前を残すために `exportJson` を包むと決めたときに増えた見え方だった。run の中の 5 人のレビューはどれも APPROVE で、PR の後の 1 人のレビューが「名前の更新はログ・表・frame だけを変える」「`exportJson` は今の表を読む」「`cli export` はディスクを読む」の 3 点を突き合わせて見つけた。名前の見え方をさらに足すときは、`nameSpeaker` の区間の中で書き、形式仕様のモデルにもその変数を足してから性質を見直す。

## 名前の操作のロックは「名前 → ログ」の順に取る。ログのロックの中では `appendLog` でなく `writeLogLine` を呼ぶ

名前のロック（`namesLock`）は、名前を付けている途中の呼び出しを 1 つにする。ログのロック（`serialized`）は、ログの行と `export.json` の書き込みを 1 つずつにする。`nameSpeaker` は名前のロックを取ってから、その中でログのロックを取る。ログの側から名前のロックを取る所は作らない。公開する `exportJson` は表を `Ref.get` で読むだけで、名前のロックを取らない。

`appendLog` は自分で `serialized` を取る。どちらのロックも許可は 1 つで、取り直しはできないので、`serialized` の中で `appendLog` を呼ぶと、自分の許可を待ち続けて止まる。ロックの中では、ロックを取らない `writeLogLine` と `writeExport` を呼ぶ。

## 名前のテストは、名前を変えた直後、次の発言を入れる前に見る

`server/test/loggedSessionLog.it.test.ts` の「ログを開いたセッションの名前」が、`openLoggedSession` の口を偽の updater で叩いて、ログの行・frame・次の入力・`export.json` を見ている。

- 「モデル付き / 地図なしでも手入力の初回設定・変更を追加発言なしで保存し、変化したときだけ名前を送る」: `nameSpeaker` を呼んだ直後に、`session.exportJson` とディスクの `export.json` の両方を見る。次の発言を入れてから見ると、その発言の保存で漏れが埋まって通ってしまう。#1517 の修正の計画は、これを「追加の発言によって保存漏れを補わせない」と書いた
- 「推定後の手入力がログ待ちの間に中断されても…」: ログの書き込みを `Deferred` で止め、その間に中断と別ラベルの名前を入れる。待ちを解いた後、3 件目の発言を入れる前に、両ラベルの名前が揃っていることを見る
- 「名前変更時にexportだけ保存できないときはdefectになる」: `export.json` の場所にディレクトリを置いて書けなくし、名前の操作が成功で返らないことを見る

表の `Ref` やロックは覗かない。再生の配線は `server/test/eval.it.test.ts` の「`play` / `eval` は保存済みの名前を持ち越さず、新しい推定名をログと後続入力へ渡す」が、`cli` の入口から確かめている。`play` は frame（空の表 → 推定名）が届くこと、`eval` は送り口を開かないことも見る。

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
