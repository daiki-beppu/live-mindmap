# 話者の名前の表

話者のラベルに付く名前を持つ・付ける・保存する・配信する・書き出す・復元する処理を触るときに読む文書。名前の表は `server/src/core/session.ts` の `SessionState` が持ち、名前を付ける経路は `Session.nameSpeaker` の 1 つだけ。採否の規則と、ログの行を畳む関数は `core/speakerNames.ts`、ファイルの保存と frame の配信は `sessionFiles.ts` の `openLogged` が受け持つ。今の分担は仕様 [#1637](https://github.com/daiki-beppu/live-mindmap/issues/1637)（実装 [#1656](https://github.com/daiki-beppu/live-mindmap/issues/1656)・[#1657](https://github.com/daiki-beppu/live-mindmap/issues/1657)）に従う。

- 用語: [話者・話者の名前・再生・エクスポート・反映](../../GLOSSARY.md)
- 関連: [差分更新の反映](reflection.md)、[セッションの開始とブラウザへの送り口](session-start-and-viewers.md)、[セッションの sink](session-sink.md)、[過去のセッションのフォルダの読み側](session-folder-reading.md)

## 表の持ち主は、ログを読み戻す core に置く。書き手がみな通る口（`openLogged`）に置くと、復元の経路が名前を落とす

#1437 は表を `openLogged` に置いた。名前を書く 3 つの経路（ライブと録画、再生と評価、bench）がどれもそこを通るからだった。けれども、ログを読んで状態に戻す 3 つの経路（`cli restore`・`restoreSession`・見返しの `reviewSnapshot`）は `openLogged` を通らず、core の `restoreState` を直に呼ぶ。そのため `cli restore` は `export.json` から `speakerNames` を消していた（[#1523](https://github.com/daiki-beppu/live-mindmap/issues/1523)）。[#1531](https://github.com/daiki-beppu/live-mindmap/issues/1531) で表を core に移し、`restoreState` が `speaker-name` の行も畳むようにすると、3 つの経路は配線を足さずに名前を保つようになった。

名前を出す新しい経路を足すときも、名前はセッション（`session.exportJson` の `speakerNames`、`session.nameSpeaker`）から読む・渡す。経路の側で `speaker-name` の行を拾って足す継ぎ当ては、持ち主を増やすのでしない（#1523 の triage で断った）。`cli play` が書き出しに空の `Map` を渡していた抜けも、ライブと同じく `exportJson` から読むようにして直った。

## 名前の変更は `Session.nameSpeaker` を通す

表はラベルごとに `{ name, source }` を持つ。画面の手入力は sink がラベルと空名を検査してから `session.nameSpeaker` に `source: "手入力"` で渡す。推定名は core が差分反映後の `known` と根拠の発言を照合し、受け入れた名前を同じ操作に `source: "推定"` で渡す。名前の行は `diff` の行の後に書く。

`nameSpeaker` は `speakerNames.ts` の純粋な関数で採否を決め、表が変わったときだけ状態を変えて `SessionLog.write` に名前の行を渡す。名前は trim し、空なら変えない。手入力は推定で替えず、推定どうしの別名への付け替えは名乗りのときだけ受け入れる。同じ名前・同じ source の再送では行を増やさない。`basis`（名乗りか、呼びかけへの応答か）は採否にだけ使い、表にも行にも残さない。

core が差分更新を呼ぶときは、自分の表から `DiffInput.speakerNames` を作る。`session.exportJson` も同じ表を `toJsonExport` に渡し、表が空なら `speakerNames` のキーを出さない。

## 名前の操作は差分の反映と同じ区間に相乗りする。区間の中から `nameSpeaker` を呼ばない

名前のためだけのロックと「名前 → ログ」の取る順の決まりは、#1656 で無くなった。`nameSpeaker` は、core が共有画面の出し入れと差分の反映に使う semaphore（`screenTransitions`）の中で、中断されないように「表を変える → 行を書く」を行う。

この semaphore は取り直せない。推定名の受け入れは反映の区間の中で決まるが、そこで `nameSpeaker` を呼ぶと同じ区間を取り直して止まる。今は受け入れた推定名を区間の戻り値として外へ出し、抜けてから `nameSpeaker` に渡している。名前の行が `diff` の行の後になる順も、これで守られる。反映の区間に名前の処理を足すときは、この形を崩さない。

## 復元は `speaker-name` の行を規則に通し直さず、ラベルごとの後勝ちで畳む

`restoreState` は `diff` の分岐と並ぶ `speaker-name` の分岐で行を `SpeakerNameLogEvent` として読み、`restoreSpeakerName`（表と行から次の表を返す純粋な関数）で畳む。行の `name`・`source` をそのまま入れ、規則は通さない（[#1532](https://github.com/daiki-beppu/live-mindmap/issues/1532)）。

通し直せないし、通し直す必要も無い。行に `basis` は無く、規則が `basis` を読むのは入ってくる変更の側だけだ。行は表が変わったときだけ変わった後の 1 件を書くので、後勝ちで畳めば書いた時点の表と一致する。行は表を変えるのと同じ中断されない区間で書くので、戻した表が書いていない名前を持つことも無い。戻した表は `source` を持つので、復元の後の `nameSpeaker` にもふだんと同じ規則が効く。web の見返し（`reviewTimeline.ts`）も同じ後勝ちで畳む。片方を変えるなら両方を揃える。

壊れた行は、ほかの行と同じく位置つきの `InvalidLogEvent` で止める。名前の行だけ黙って捨てると、#1523 と同じく名前が消えたことに気づけない。`speaker-name` の行は反映（`reflectDiff`）で畳まない（[差分更新の反映](reflection.md)）。`diff` の行と互いの結果を読まないので、ログの中の順に依らず同じ表とマップに戻る。

再生（`cli play`）は空の表から始め、元のログの名前を持ち越さない。元のログから選ぶ行に `speaker-name` は入っていない。

## shell が名前の行と export を保存し、frame を送る

`openLogged` が `SessionLog.write` で名前の行を受けると、ほかの行と同じ `serialized` の下で `writeLogLine` と `writeExport` を続けて流す。その後、セッションの `exportJson.speakerNames` から今の表を組み立て、`speaker-names` の frame を送る。開いた直後の空の frame も送る。名前の表・ロック・callback の写しは持たない。

名前を変えた時点で、続きの発言が無くてもディスクの `export.json` は書き直されている。最後の名乗りの後に発言が無くても、名前を残す必要がある。[PR #1517](https://github.com/daiki-beppu/live-mindmap/pull/1517) で、名前の操作が export を保存しないとこれを満たせないことが分かった。

`appendLog` は自分で `serialized` を取るので、その中から呼ばない。ロックの中では `writeLogLine` と `writeExport` を使う。保存の失敗は defect として伝える。

ライブと `recordPlayback` は、書き出しへ渡す名前をどちらも `session.exportJson.speakerNames` から作る。Markdown はこの名前を案の提案者などに使う。HTML はログを埋め込み、見返しの画面が名前の行から最後の名前を読む。

## テストは契約を持つ入口から見る。今の振る舞いを固定したテストは、直しの前に契約のテストへ置き換える

`server/test/session.test.ts` は、偽の updater と偽のログで、手入力・推定名の名前の行、`diff` の行の後の順、次の入力、export を見る。表の `Ref` やロックは覗かない。採否の規則の組み合わせは `speakerNames.test.ts` が純粋な関数で持ち、`Session` の単体には配線を 1 件ずつ足すだけにする。後勝ちの畳み方も `speakerNames.test.ts` が見る。

復元は `restore.test.ts` の往復で見る。元のセッションで手入力と推定の名前を付け、そのログから戻したセッションの `snapshot`・`exportJson`・続きの `push` の `DiffInput.speakerNames` が元と等しいこと、名前の行を `diff` の行の前後に動かしても同じに戻ること、復元の後も手入力の名前が推定で変わらず行が増えないこと、壊れた行が位置つきで落ちることを見る。

`speakerNames.it.test.ts` には、#1657 まで「`restoreState` は名前の行を読み飛ばす」を確かめるテストが 2 つあった。守りたかったのは「マップと発言が元どおりに戻る」ことだったが、「表が空で戻る」ことまで固定していて、#1523 を直すと落ちた。今の振る舞いを確かめるテストを見つけたら、守りたい契約を書き直し、直しの PR で置き換える。

推定名のテストの根拠の発言には、名乗り（「田中です」）を使う。「はい」は中身の無い発言として差分更新の対象から外れるので、推定名の根拠にならない。#1656 の前のテストは「はい」を使っていて、推定名が付かない理由を、確かめたい規則とは別の所で得ていた。

`loggedSessionLog.it.test.ts` と `speakerNames.it.test.ts` は shell の保存と frame、sink の受け付けだけを見る。名前を変えた直後、次の発言を入れる前にディスクの export を読む。中断と競合はログの書き込みを Deferred で止めて順を決め、export の保存の失敗は書き込み先にディレクトリを置いて確かめる。core に移った契約を確かめていた IT は #1656 で消した（`speakerNames.it.test.ts` は +22 −259 行）。

再生の配線は `server/test/eval.it.test.ts` の play と eval の検査が持つ。CLI から再生し、生成した Markdown の名前の欄と HTML に埋め込んだ名前の行を読む。play の frame と、eval が送り口を開かないことも見る。

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
- [開発ログ: 話者の名前の表を「ログを開く口」からセッションへ移し直したとき](../devlog/2026-10-27.md#speaker-names-in-session)
- 地図 [#1530](https://github.com/daiki-beppu/live-mindmap/issues/1530) の決定 [#1531](https://github.com/daiki-beppu/live-mindmap/issues/1531)・[#1532](https://github.com/daiki-beppu/live-mindmap/issues/1532)・[#1630](https://github.com/daiki-beppu/live-mindmap/issues/1630)、不具合 [#1523](https://github.com/daiki-beppu/live-mindmap/issues/1523)、仕様 [#1637](https://github.com/daiki-beppu/live-mindmap/issues/1637)・親 [#1655](https://github.com/daiki-beppu/live-mindmap/issues/1655)
- チケット [#1656](https://github.com/daiki-beppu/live-mindmap/issues/1656)・[PR #1676](https://github.com/daiki-beppu/live-mindmap/pull/1676)、[#1657](https://github.com/daiki-beppu/live-mindmap/issues/1657)・[PR #1677](https://github.com/daiki-beppu/live-mindmap/pull/1677) と、その takt の run（`20261027-113254-issue-1656-no-no-wo-core-noses-r56ecr`・`20261027-122913-issue-1657-de-speaker-name-no-1xwjc1`）の計画・決定ログ・報告
