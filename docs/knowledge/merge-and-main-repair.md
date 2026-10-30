# マージと main の修復

`main` の ruleset を変えるとき、予約済みの PR がどうマージされたかを確かめるとき、案内役の main の修復が効いているかを確かめるときに読む文書。手順は [`docs/agents/checks.md`](../agents/checks.md) の「When main goes red」にある。

- 用語: 無し（案内役・main-fix・desk は dotfiles の [GLOSSARY](https://github.com/daiki-beppu/dotfiles/blob/main/GLOSSARY.md) にある）
- ADR: [0026 main の ruleset は strict を必須にせず、main の push の CI を案内役が見張って直す](../adr/0026-verify-main-after-merge-without-strict.md)

## 案内役が main を読めるかは、状況の一覧ではなく読み取りの関数の戻り値で確かめる。緑の main は一覧に出ない

案内役の状況の一覧は、main が赤いときだけ main の行を出す。main が緑なら何も出ないので、「出ない」は読めた証拠にならない。[#1704](https://github.com/daiki-beppu/live-mindmap/issues/1704) では、案内役が使う読み取り（dotfiles の takt スキルの `github.mjs` の `readMain` と、`main-state.mjs` の `requiredChecks`・`mainState`）を live-mindmap に向けて直に呼び、`required: ["check"]`・`state: "green"` を得た。必須チェックの名前は ruleset から読んでいるので、ruleset の必須チェックを変えたときも同じ呼び方で確かめる。

## 常駐の案内役は、起動した時点のコードで動く。dotfiles の修復のコードを変えたら、起動し直してから確かめる

#1704 の時点で動いていた案内役は 10/27 23:14 の起動で、main の修復の実装（dotfiles#420・#422・#423・#424、10/28 23:17 までにマージ）より前のコードだった。dotfiles の main にコードがあっても、常駐のプロセスは読み込んでいない。PID を名指しで止め、desk の同じペインで起動し直してから確かめた。修復の流れが効いているかを見るときは、マージの時刻と常駐の起動の時刻の両方を見る。

## strict が無いと、遅れている PR の `mergeStateStatus` は `CLEAN` になる。遅れは `compare` の `behind_by` で見る

GitHub は、ruleset が最新の取り込みを求めていなければ、main より遅れている PR にも「マージできる」と答える。#1704 の訓練の [PR #1726](https://github.com/daiki-beppu/live-mindmap/pull/1726) は、[#1725](https://github.com/daiki-beppu/live-mindmap/pull/1725) のマージの後、`gh api repos/daiki-beppu/live-mindmap/compare/main...<branch>` が `behind_by: 1` なのに、`gh pr view --json mergeStateStatus` は `CLEAN` を返した。`mergeStateStatus` の `BEHIND` を待つ手順やスクリプトは、この repo ではもう遅れを見つけられない。`DIRTY`（main とテキストで競合）は今も出て、その PR はマージされない。

## 「揃えずにマージされた」を示すには、揃える者を止めたうえで、head の SHA と timeline の出来事を残す

起きなかったことは、出力を 1 つ見ても示せない。#1704 では、`align-behind.mjs` を先に止めてから #1726 を予約し、head（`7986d7f`）が予約からマージまで変わらず、timeline の出来事が `committed`・`closed`・`merged` の 3 つだけで、ブランチの更新も force push も無いことを残した。予約からマージまでは 19 秒だった。訓練の PR が足したファイルは、別の PR（[#1727](https://github.com/daiki-beppu/live-mindmap/pull/1727)）で消す。

## strict を戻すときは、ruleset を戻して desk を起動し直す。desk は ruleset を読んで `align-behind.mjs` を立てるかを決める

desk は repo の `main` の ruleset（`gh api repos/<repo>/rules/branches/main`）を読み、必須チェックのどれかが strict の repo でだけ `align-behind.mjs` のペインを立てる（[dotfiles#410](https://github.com/daiki-beppu/dotfiles/issues/410)）。repo 名で分けていないので、strict を戻すのに desk の変更は要らない。`gh api` が失敗すると desk は止まる。strict かどうかを推測で決めないためで、desk が起動しないときはまず ruleset が読めるかを見る。ruleset の変更は `strict_required_status_checks_policy` だけを書き換え、変更前後の `required_status_checks` を残す（#1704 の resolution コメントに前後の JSON がある）。

## 出典

- 仕様 [#1682](https://github.com/daiki-beppu/live-mindmap/issues/1682)、親 [#1703](https://github.com/daiki-beppu/live-mindmap/issues/1703)
- 子 [#1704](https://github.com/daiki-beppu/live-mindmap/issues/1704) の resolution コメントと訓練の [PR #1725](https://github.com/daiki-beppu/live-mindmap/pull/1725)・[#1726](https://github.com/daiki-beppu/live-mindmap/pull/1726)・[#1727](https://github.com/daiki-beppu/live-mindmap/pull/1727)
- 子 [#1705](https://github.com/daiki-beppu/live-mindmap/issues/1705)・[PR #1728](https://github.com/daiki-beppu/live-mindmap/pull/1728)
- 子 [dotfiles#410](https://github.com/daiki-beppu/dotfiles/issues/410)・[dotfiles PR #429](https://github.com/daiki-beppu/dotfiles/pull/429)
- [main の ruleset の strict を外したとき](../devlog/2026-10-30.md#drop-strict)
