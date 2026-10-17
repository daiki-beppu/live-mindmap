# 予約済みで BEHIND の PR は、手元の常駐スクリプトが利用者の gh で 1 件ずつ揃える

自動マージを予約した BEHIND の PR を揃えるのは、GitHub Actions ではなく、利用者の Mac に常駐させるスクリプト（dotfiles の takt スキルの `align-behind.mjs`）にする。利用者の `gh` の認証で `update-branch` を呼ぶので、GitHub App も PAT も secrets も要らない。揃える規則（作者を問わず、予約の古い順に 1 件ずつ。揃えた 1 件がマージされるか落ちるまで次は揃えない。DIRTY には head ごとに 1 回知らせる）は、仕様 [#1188](https://github.com/daiki-beppu/live-mindmap/issues/1188) のまま変えない。takt-sequence 側の揃えは外し、揃える仕組みをこのスクリプトに一本化する。ADR 0021 の「Actions が App のトークンで揃える」は、この ADR で置き換える。親 [#1190](https://github.com/daiki-beppu/live-mindmap/issues/1190) で、利用者が App を作らない方を選んだ。

利用者の gh で揃えた push は、GITHUB_TOKEN の push と違って、揃えた後の CI が承認待ちにならずに普通に走る（[#1179](https://github.com/daiki-beppu/live-mindmap/issues/1179)）。

## Considered Options

- **Actions + 自作の GitHub App（ADR 0021）**: Mac が止まっていても揃うが、App の作成・インストール・秘密鍵の保管が要る。利用者はこの手間を避けた
- **Actions + fine-grained PAT**: App は要らないが、本人として動く長命の秘密を secrets に置き、期限を付ければ作り直し続けることになる
- **Actions + `GITHUB_TOKEN` で揃え、`check` を `workflow_dispatch` で起こす**: 秘密は要らないが、dispatch した run が必須チェックとして数えられるかを一次資料でも実機でも確かめていない

## Consequences

- Mac が起きていて、スクリプトが動いている間しか揃わない。PR を作って予約するのも、ほとんどが同じ Mac の takt なので、止まるときは両方が止まる。動いていない間は、今までどおり手で `gh pr update-branch` を打つ
- イベントは受け取らず、60 秒ごとに GitHub から今の状態を読み直す。止めて流し直しても、状態はなくならない
- 揃えたのがボットだとは見分けられない（揃えた操作は利用者として残る）。仕組みの記録は、スクリプトのタブの出力で見る
- 同じ repo に 2 本走らないよう、PID のロックで 1 本に絞る
