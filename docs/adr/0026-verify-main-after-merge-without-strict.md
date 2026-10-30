# main の ruleset は strict を必須にせず、main の push の CI を案内役が見張って直す

main の ruleset の strict（PR の head に最新の main が入っていないとマージできない）を外す（[#1704](https://github.com/daiki-beppu/live-mindmap/issues/1704) で `false` にした）。自動マージを予約した PR は、BEHIND のままでも必須の `check` が通ればマージされる。main の push の CI は dotfiles の[案内役](https://github.com/daiki-beppu/dotfiles/blob/main/GLOSSARY.md)が見張り、落ちたら、落ちた job の 1 回の再実行 → main-fix（main から切った修正のセッションが、修正の PR を出して自動マージを予約する） → Discord の判断依頼、の順に直す。この repo では `align-behind.mjs` を動かさない。仕様 [#1682](https://github.com/daiki-beppu/live-mindmap/issues/1682) で決めた。[ADR 0021](0021-align-behind-prs-one-at-a-time-with-app-token.md) と、それを置き換えた [ADR 0022](0022-align-behind-prs-from-local-resident-script.md) を、この ADR で置き換える。

理由は dotfiles の [ADR 0004](https://github.com/daiki-beppu/dotfiles/blob/main/docs/adr/0004-verify-main-after-merge.md) にある。strict のもとでは、予約済みで BEHIND の PR を `align-behind.mjs` が 1 件ずつ揃えるので、takt-sequence の並列数を上げても出口で 1 件ずつに戻る。

## Considered Options

- **strict と align-behind で 1 件ずつ揃える（ADR 0021・0022）**: main は壊れにくいが、takt-sequence の並列数が出口で 1 件ずつに戻る
- **GitHub の merge queue**: 個人アカウントが持つ repo では使えない
- **strict を外し、main が赤くなったら人が直す**: 並列数を上げるほど、人が気づく前に壊れた main の上に PR が積まれる

## Consequences

- main は一時的に赤くなりうる。長くて、再実行と main-fix の修正の PR がマージされるまで
- ADR 0021 が strict を残す理由にした「PR 単独では通っても main と合わせると落ちる衝突」は、マージの前ではなく、main の push の CI で捕まえる
- CI は変更したパスで job を選ぶので、main が赤くても、壊れたパスに触れない PR は通る
- 戻すときは、ruleset の strict を `true` に戻し、desk で `align-behind.mjs` を立て直す。スクリプトは dotfiles の takt スキルに残る
