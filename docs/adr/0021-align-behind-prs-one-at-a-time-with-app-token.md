# 予約済みで BEHIND の PR は、Actions が App のトークンで 1 件ずつ揃える

> ADR 0022 で、揃える場所を手元の常駐スクリプトに置き換えた。揃える規則と strict を残す理由は、この ADR のまま。

main の ruleset は strict（PR の head に最新の main が入っていないとマージできない）のまま残す。自動マージを予約した PR が BEHIND で止まらないよう、GitHub Actions のワークフローが自作の GitHub App のトークンで `update-branch` を呼び、PR を 1 件ずつ順に揃える。揃えた 1 件の CI が終わる（マージされる、または落ちる）まで、次の PR は揃えない。揃える対象は、自動マージを予約したすべての PR で、作者は問わない。仕組みができたら takt-sequence 側の揃えは外し、揃える仕組みをこのワークフローに一本化する。地図 [#1177](https://github.com/daiki-beppu/live-mindmap/issues/1177) のチケット [#1182](https://github.com/daiki-beppu/live-mindmap/issues/1182) で決めた。

strict を残すのは、PR 単独では通っても main と合わせると落ちる本物の衝突を捕まえるためだ。strict にしてから約 12 時間で、揃えた後の CI が fallow の衝突を 2 件捕まえた（[#1180](https://github.com/daiki-beppu/live-mindmap/issues/1180)）。

## Considered Options

- **GitHub のマージキュー**: 使えるのは organization が持つリポジトリだけで、このリポジトリは個人アカウントが持つ public リポジトリなので使えない（[#1178](https://github.com/daiki-beppu/live-mindmap/issues/1178)）。organization へ移すなら、まずこれを考え直す
- **Kodiak・Mergify などの外部ボット**: 予約がボットのラベルやコメントになり、`gh pr merge --auto` の予約と二重の仕組みになる。strict を残す以上、ボットも 1 件ずつ揃えることになり、Actions より得るものがない
- **strict をやめ、main の CI と revert で守る**: CI は増えないが、main が赤い間も他の PR がマージされ続け、壊れたときの影響が一番大きい。上の本物の衝突も捕まえられない
- **予約済みの BEHIND を一斉に揃える**: 1 件が入るたびに残りがまた BEHIND になり、空回りする。待ちが 3 件なら空回りは 1 日 30〜45 回になる（#1178 の見積もり）。実測でも、strict 後の 20 回の update-branch のうち 7 回が揃え直しだった（#1180）。1 件ずつなら上限は 1 時間 12〜15 件で、ピークの 1 時間 10 件に収まる
- **`GITHUB_TOKEN` で揃える**: 揃えた後の CI が承認待ちになり、必須の `check` がそろわないので、自動マージが進まない（[#1179](https://github.com/daiki-beppu/live-mindmap/issues/1179)）
- **fine-grained PAT**: 利用者本人として動くうえ、期限を更新し続けるか長命の秘密を持つことになる。App のトークンは 1 時間で切れ、秘密鍵の更新は要らず、揃えたのがボットだと見分けられる

## Consequences

- ワークフローを起動するイベントは 4 つ。`push`（main）で次を揃える。`pull_request` の `auto_merge_enabled` で、push の後に予約された PR を拾う。check の `workflow_run`（completed）で、揃えた 1 件の CI が落ちたときに次へ進む。`schedule` で取りこぼしを拾い直す。1 件ずつ揃える以上、CI が落ちたときには main への push が来ないので、`workflow_run` を外すと列が止まる（一斉に揃える前提の #1179 は、`workflow_run` は要らないとしていた）
- PR の CI は、変更したパスのジョブだけを流すまま残す。main が赤い間も、揃える仕組みは止めない。main が赤くなったら、落ちたジョブを 1 回だけ流し直す。通れば揺れとして fix-forward し、また落ちれば原因の PR を revert する（[#1181](https://github.com/daiki-beppu/live-mindmap/issues/1181)）
- 揃える順、DIRTY（衝突）の PR の知らせ方、揃えに失敗したときの通知、App の権限（Workflows 権限が要るか）、takt-sequence から揃えを外す手順、漏れの見張り方は、仕様で決める
