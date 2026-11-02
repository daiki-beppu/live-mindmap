# 補足

補足を作る・反映する・測る処理を触るときに読む文書。触る場所は、呼び出しの引き金と段取り（`server/src/core/sessionSupplement.ts` の `supplementTargets`・`makeSessionSupplement`）、ログの `supplement` 行の反映（`reflection.ts` の `reflectSupplement`、`session.ts` の反映と `restoreState`）、計測（`supplementMetrics.ts`、`bench/supplementJudge.ts`、正解の `truth.json`）。約束のどれをどこで守っているか、保留の扱い、計測の数字の読み方、正解の作り方を書く。

- 用語: [補足・根拠・反映](../../GLOSSARY.md)
- ADR: [0027 補足はノードの種別にし、添える先の発言を根拠に持たせ、出どころで会議の外の知識を見分ける](../adr/0027-supplement-is-a-node-kind-with-origin.md)、[0024 差分更新の反映は、ログの `diff` の行を入力にした 1 つの純粋な関数にする](../adr/0024-reflect-diff-row-in-one-pure-fold.md)
- 関連する知識文書: [差分更新の反映](reflection.md)、[takt の run](takt-runs.md)

## 「同じ語の説明は 1 回だけ」は反映の側で守る。呼び出しに保留中の語を渡すのは、無駄な呼び出しを減らすためだけ

約束を守る場所は、「プロンプトが守らなくても成り立つか」で決めた。モデルは入力の「説明済みの語」を無視することがあるので、入力だけでは 1 回にならない。`reflectSupplement` は、`explainedTerms` にある語の追加を畳むときに落とす。これだけで約束は成り立つ。`makeSessionSupplement` が呼び出しに渡す `explainedTerms` には、まだ画面に足していない保留の補足の語も入れている。仕様の Formal Spec（Quint）の再検査では、こちらは安全性に効かず、無駄な呼び出しを減らすだけだと分かった。

そのため、反映の側の落とし方を緩める変更は、形式仕様の不変条件 `invTermOnce` が壊れる変更として扱う。入力の側の変更は、セッションのテストで呼び出しの数を見るだけでよい。

語は生の文字列のまま比べている。計測（`supplementMetrics.ts`）の重複の数え方は NFKC で正規化して空白を除くので、「ＳＬＡ」と「SLA」は、反映では別の語として両方通り、計測では重複として数えられる。

## 60 秒の間隔は、`supplement` 行を畳んで画面に足した時刻から測る。保留を置き換えるのは、操作のある応答だけ

呼び出しを 1 本の worker（`Queue.sliding(1)`）で回し、結果は保留（`retained.pending`）に置く。保留を書くのは、次の差分更新の反映のときか停止のときだ。追加・言い直しは、前の補足を足してから 60 秒経つまで書かない。消去と停止は待たない。保留は 1 件だけで、後から来た結果が前の保留を置き換える。

置き換えるのは、操作のある応答（`op` が `null` でない）だけにする。takt の最初の実装は、何もしない応答でも保留を上書きしていた。60 秒待ちの補足が、後から来た「何もしない」に消される。[PR #1818](https://github.com/daiki-beppu/live-mindmap/pull/1818) のレビューで見つかり、`if (decoded.op !== null)` を足した。テスト「操作なし応答の後も保留を維持し、通常diff/停止で反映する」は、`TestClock.adjust(59_999)` で境目を固定している。保留や間隔の扱いを変えるときは、このテストを先に読む。

呼び出しを待つ間に、添える先の本文か `planStatus` が変わっていたら、結果を捨てる（`validateSupplement` の「補足を待つ間に添える先が変わった」）。これは仕様に無く、実装で足した決まりだ。

## 補足のトークンの列は、記録された分だけを数える。何もしない応答・捨てた結果・失敗した呼び出しは、ログに行が無い

ログに `supplement` 行が書かれるのは、保留を反映に回したときだけだ。何もしない応答は保留にならない。検査で捨てた結果（`SupplementInvalid`）と失敗した呼び出しは、`Effect.ignore` で警告を出して終わる。どれも usage がログに残らないので、`cli eval` の補足のトークンの 4 列は、補足の呼び出し全体の費用ではない（[`server/bench/README.md`](../../server/bench/README.md)）。

[#1776](https://github.com/daiki-beppu/live-mindmap/issues/1776) の初回の計測でも、そうなった。補足が 0 件の回はトークンの列が `-` で、別の回では「この語は説明済み」で反映を断った警告が 2 件あったが、その分の usage は無かった。費用を比べるときは、欠測を 0 にしない。総費用が要るなら、何もしない応答と捨てた結果の usage も行として書く変更が先に要る。

## 呼び出しの引き金は、議題・論点・決定の追加と案の却下だけ。再現率が低いときは、モデルより先に引き金を見る

`supplementTargets` が呼び出しの対象にするのは、次のノードだ。

- 補足がまだ無いノード: 追加された議題・論点・決定と、`却下` に変わった案
- 補足がすでにあるノード: 本文が変わったもの

要点と、検討中の案は対象にならない。#1776 の略語の多い合成会議では、正解の場面に合う要点が 6 件と 5 件（2 回）あったが、どれにも補足が付かなかった。正解の場面に合った議題には、2 回とも付いた。再現率は合わせて 3/32 で、その大半は「モデルが説明できない」ではなく、「呼び出しに渡していない」と見ている。

用語集の[補足](../../GLOSSARY.md)は「案が `却下` になったら、補足も言い直すか消す」と書くが、今の `supplementTargets` は、補足がすでに付いた案を、本文が変わらない限り呼ばない。補足の付いた案が、本文を変えずに却下になると、補足は却下の前のまま残る。引き金を変えるときは、この食い違いも一緒に直す。

## 補足の正解は、生成を見る前に台本と発言の時刻表から作る。既存の正解ファイルには、元の JSON の値を保って足す

正解は `truth.json` の任意のキー `補足` に、場面ごとの `from`・`to`（発言の時刻の範囲）と `keywords` で書く。形の正本は `server/src/core/evaluate.ts` の `Truth` と `server/src/truthFile.ts`、書き方は [`server/bench/README.md`](../../server/bench/README.md) にある。

生成された補足から正解を逆算すると、生成されなかった場面（再現率の分母）を数えられない。#1776 では、合成会議 2 本に 8 件ずつ、生成の前に台本から作った。16 件すべてで、範囲の両端が発言の時刻と一致することを確かめた。

`readTruthFile` は知らないキーを捨てる。既存の正解ファイルを読み込んで保存し直すと、決定の担当者や案の提案者のような、読み込みの型に無い情報が消える。足すときは JSON に直接書き、元の値が変わっていないことを元の JSON どうしで比べる。

## 少ない回数の結果は、分子と分母を合算して書く。並行して流した遅れは、単独の値として扱わない

補足は 1 回の再生で数件しか出ないので、回ごとの割合はぶれる。#1776 は会議ごとに 2 回ずつ流し、再現率を件数の合算（3/32）で出した。判定器の 5 ラベルも合算した（12 件中 要る 9・誤り 1・根拠なし 2）。百分位どうしは平均しない。4 回を並行して流したので、遅れ（p50 で 15.8〜33.3 秒）は単独で流したときの値ではないと断った。補足のプロンプト・モデル・引き金を変えたときの前後の比べ方は、AGENTS.md の Evals の `supplementJudge` に従う。

評価の CLI には、セッションのフォルダを絶対パスで渡す。`pnpm cli` は中で `cd server` するので、相対パスは「セッションのマップがありません」で落ちる。

## 出典

- [聞かれる前に AI が答える「補足」を作ったとき](../devlog/2026-11-02.md#supplement-spec)
- 仕様 [#1755](https://github.com/daiki-beppu/live-mindmap/issues/1755)（Formal Spec のコメントを含む）、親 [#1769](https://github.com/daiki-beppu/live-mindmap/issues/1769)
- [#1770](https://github.com/daiki-beppu/live-mindmap/issues/1770)・[PR #1777](https://github.com/daiki-beppu/live-mindmap/pull/1777)、[#1771](https://github.com/daiki-beppu/live-mindmap/issues/1771)・[PR #1781](https://github.com/daiki-beppu/live-mindmap/pull/1781)、[#1772](https://github.com/daiki-beppu/live-mindmap/issues/1772)・[PR #1782](https://github.com/daiki-beppu/live-mindmap/pull/1782)、[#1773](https://github.com/daiki-beppu/live-mindmap/issues/1773)・[PR #1805](https://github.com/daiki-beppu/live-mindmap/pull/1805)、[#1774](https://github.com/daiki-beppu/live-mindmap/issues/1774)・[PR #1818](https://github.com/daiki-beppu/live-mindmap/pull/1818)、[#1775](https://github.com/daiki-beppu/live-mindmap/issues/1775)・[PR #1840](https://github.com/daiki-beppu/live-mindmap/pull/1840)
- [#1776](https://github.com/daiki-beppu/live-mindmap/issues/1776) の takt の run（`20261101-133733-issue-1776-no-truth-json-ni-no-474pu8`）の計画・実装の報告
