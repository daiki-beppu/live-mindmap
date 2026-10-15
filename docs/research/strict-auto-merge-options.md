# strict と自動マージを両立させるやり方の比較（この規模で）

調査日: 2026-10-15 / issue #1178（map #1177 の子）

## 結論

1. **GitHub のマージキューは、今のままでは使えない。** 公式の提供条件は「organization が持つ public リポジトリ、または GHEC の organization の private リポジトリ」。個人アカウントの public リポジトリは対象外。使うには organization へ移す（transfer）しかない。
2. **ボットは、どれもこのリポジトリの「`gh pr merge --auto` で予約した PR を揃える」という形にそのままは合わない。** Mergify と Kodiak は自前のキュー（コメント・ラベル・規則）で PR を入れ、自分でマージする。bors-ng は保守終了（アーカイブ済み）で、README は GitHub のマージキューを使えと書いている。Mergify の無料枠（Open Source プラン）では batch が使えない。
3. **Actions で揃えるなら、既定の `GITHUB_TOKEN` ではなく GitHub App のトークン（または PAT）が要る。** `GITHUB_TOKEN` による PR の更新は、今は「承認待ち」の run を作るだけで、人が承認しないと CI が走らない（docs に明記。dotcom で順次展開中の機能）。
4. **この規模（1 日 30〜45 件、ピーク 1 時間 10 件、CI 中央値 3.5 分）には、「Actions で 1 件ずつ順に揃える」が合う。** 1 件ずつなら空回りはほぼ 0 で、追加の CI は多くて 1 日 30〜45 回。全部を一斉に揃えると、待っている予約が 3 件なら 1 日 30〜45 回、4 件なら 60〜90 回が空回りになる。Free プランの同時ジョブ上限 20 に対し、main 相当の全ジョブは 1 回 13 ジョブなので、一斉に揃えると runner の待ちで遅くもなる。
5. **strict をやめる案は CI の量が最も少ないが、壊れたときの影響が一番大きい。** 意味の衝突が main に入り、main が赤い間も他の PR はマージされ続ける（必須チェックは PR にしか効かない）。

## この規模の数字（このリポジトリで測った値）

| 項目 | 値 | 取り方 |
|---|---|---|
| 1 日のマージ数 | 10/14 は 44 件 | `gh pr list --state merged --search merged:2026-10-14` |
| ピークの 1 時間 | 10 件（10/14 04 時 UTC） | 同上を時刻で集計 |
| CI（check.yml）1 回 | 中央値 3.5 分。main の push は p90 4.6 分、PR は p90 9.4 分 | 直近 40 run（push・pull_request それぞれ） |
| main の push の失敗 | 直近 40 run 中 5 回 | 同上 |
| 全ジョブを走らせた run のジョブ数 | 13（うち macOS 1） | main の push の run |
| アカウントのプラン | Free | `gh api user --jq .plan.name` |
| 同時ジョブの上限（Free） | 合計 20、macOS 5 | GitHub Docs「Actions limits」 |

## 候補ごとの比較

### 1. GitHub のマージキュー

- **使えない理由**: 「Pull request merge queues are available in any public repository owned by an organization, or in private repositories owned by organizations using GitHub Enterprise Cloud.」 個人アカウントのリポジトリは条件に入っていない。
  — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue （本文の `product:` が参照する `data/reusables/gated-features/merge-queue.md`）
- **使えるようにする道**: 無料の organization を作り、リポジトリを移す。issue・PR・スター・secrets・webhook は一緒に移り、旧 URL・git の remote はリダイレクトされる。旧の場所に同名のリポジトリを作るとリダイレクトは消える。週に Actions を 100 回超使ったリポジトリは、旧の `OWNER/REPO` の名前が永久に引退する。
  — https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository
- **動き**: キューに入った PR を、最新の base と先行する PR の変更と合わせた一時ブランチ（`merge_group`）で検査し、通れば base に入れる。strict と同じ効果を、作者にブランチを揃えさせずに得る（「provides the same benefits as the Require branches to be up to date before merging」）。`Build concurrency`（1〜100）で同時に流す `merge_group` の数を絞れる。`Merge limits` は「merge_group の **build** はまとめない」と明記（まとめるのは base への取り込みだけ）。失敗した PR はキューから外れ、後ろの一時ブランチは作り直される。
  — 同上 managing-a-merge-queue
- **CI の側**: ワークフローは `merge_group` イベントで走らせる必要がある（「You **must** use the `merge_group` event」）。今の check.yml の `changes` ジョブは `pull_request` 以外を「全部走らせる」に倒すので、`merge_group` では毎回 13 ジョブの全量になる。main の push でも全量が走るので、PR 1 件あたり「PR の run + merge_group の全量 + main の push の全量」になる。
- **利点**: GitHub 自身の機能で、トークンもボットも要らない。`gh pr merge --auto` はそのままキューへの投入になる。
- **欠点**: リポジトリの移管が前提。移管の影響（URL、Orca・takt・dotfiles の参照、CI のバッジ等）を全部洗う必要がある。
- **CI の空回り**: 先行 PR が落ちたときだけ、後ろの merge_group を作り直す分。通常時は 0。
- **壊れたときの影響**: CI が `merge_group` に報告しないとキューはタイムアウトまで止まる（「Status check timeout」）。main は守られる。

### 2. 外部のボット

#### Mergify

- **料金**: 「Open Source」プランは $0、ユーザー数無制限。「Free」は $0 で private リポジトリの 5 人まで。価格表の機能行では、**Open Source は Batch・Scopes・Pause・優先度・Two-Steps CI・Monitoring が ✗、Parallel Checks は ✓**。個人アカウントの public リポジトリが Open Source プランに入るかは、公開ページに書かれていない（要問い合わせ）。
  — https://mergify.com/pricing （ページの機能表を HTML から読み取り）
- **strict との相性**: 「Require branches to be up to date before merging」は batch PR を使うキューと衝突する（GitHub は検査した batch PR ではなく元の PR にこの設定を当てるため）。衝突しないのは in-place checks（元の PR をそのまま検査する）で、条件は `batch_size = 1`・`max_parallel_checks = 1`・`mode = serial`・`max_checks_retries = 0`・two-step CI なし。つまり strict を残すなら「1 件ずつ順に揃える」形にしかならない。
  — https://docs.mergify.com/merge-queue/batches/
- **並列検査**: 累積の一時 PR（#1、#1+#2 …）で並列に CI を流す。「Wasted CI runs occur when a PR ahead in the queue fails」。
  — https://docs.mergify.com/merge-queue/parallel-checks/
- **入れ方**: `@mergifyio queue` のコメント等、Mergify 自身のキューに入れる。GitHub の auto-merge の予約をそのまま拾うという記述は docs に見当たらない。
  — https://docs.mergify.com/merge-queue/setup/
- **トークン**: Mergify は GitHub App として動くので、揃えた後の CI は普通に走る（`GITHUB_TOKEN` の制限は Actions のトークンにだけかかる）。
- **利点**: 無料でキューが手に入る。in-place なら strict を残せる。
- **欠点**: AGENTS.md の「`gh pr merge --squash --auto`」・takt の予約の流れを Mergify のキューに置き換える必要がある。外部サービスに contents 書き込みを渡す。Open Source プランでは batch が使えず、個人アカウントでの適用も未確認。
- **壊れたときの影響**: Mergify が止まると、キューの PR は一切マージされない（main は守られる）。

#### Kodiak

- **料金**: 「free for personal use and public repositories」。private の organization リポジトリは $4.99/アクティブユーザー/月。
  — https://kodiakhq.com/docs/billing
- **権限**: administration: read、checks: write、contents: write、issues: write、pull requests: write、commit statuses: read、workflows: read & write、members: read。git は使わず API だけで更新・マージする。
  — https://kodiakhq.com/docs/permissions
- **揃え方**: Kodiak にブランチを揃えさせるには strict（「Require branches to be up to date before merging」）を有効にする必要がある。既定では「only update a PR when necessary」で、内部キューは先着順＝事実上 1 件ずつ。`update.always` にすると「For N PRs against a target you will see at least N(N-1)/2 updates」。`merge.optimistic_updates` で検査中でも揃える。`update.require_automerge_label` で対象を `automerge` ラベル付きに絞る。
  — https://kodiakhq.com/docs/features 、https://kodiakhq.com/docs/config-reference
- **入れ方**: `automerge` ラベル。GitHub の auto-merge の予約は対象にしていない（features に記述なし）。2026-09 に GitHub のマージキュー対応を追加（このリポジトリでは使えない）。リポジトリ chdsbd/kodiak は 2026-09 にもコミットがあり保守されている。
  — https://github.com/chdsbd/kodiak
- **利点**: public は無料、strict 前提の設計で、既定で CI を節約する 1 件ずつ揃え。GitHub App なので揃えた後の CI が走る。
- **欠点**: 予約の仕組みが「ラベル」になり、`gh pr merge --auto` と二重になる。batch は無い。
- **壊れたときの影響**: Mergify と同じく、止まるとマージが止まる（main は守られる）。

#### bors-ng と後継

- bors-ng は 2024 にアーカイブ。README: 「new features will not be accepted」「If you want to implement a workflow like this, use GitHub's built-in merge queue.」
  — https://github.com/bors-ng/bors-ng
- 後継の rust-lang/bors（homu の Rust 版）は、Rust プロジェクト用に自分たちでホストするもので、GitHub App・PostgreSQL を自前で用意する（README の設定表）。この規模に持ち込む利点はない。
  — https://github.com/rust-lang/bors
- batch（rollup）はできるが、ホスティングの手間が釣り合わない。

### 3. Actions で、予約済みで BEHIND の PR を揃える

- **トークン**: `GITHUB_TOKEN` で起きたイベントは新しい run を作らない。例外は `workflow_dispatch`・`repository_dispatch` と、`GITHUB_TOKEN` で PR を作成・更新したときの `pull_request`（opened / synchronize / reopened）。後者は **approval-required** で作られ、書き込み権限のある人が「Approve workflows to run」を押すまで走らない。承認なしで走らせたいなら「GitHub App installation access token か PAT を使え」と docs が書いている。
  — https://docs.github.com/en/actions/concepts/security/github_token （本文の reusable `actions-do-not-trigger-workflows`。機能フラグ `actions-github-token-pull-request-approval` は「currently rolling out on dotcom」）
- App のトークンは `actions/create-github-app-token`（v3.3.0）で発行する。
  — https://github.com/actions/create-github-app-token
- **既成の Action**:

| Action | 揃える対象 | 一度に揃える数 | トークン | 保守 |
|---|---|---|---|---|
| adRise/update-pr-branch | auto-merge 有効（既定 true）・承認数（既定 2。0 に変える必要あり）・チェック緑（検査中は `allow_ongoing_checks`）・衝突なし・BEHIND | **1 件**（既定は最新。`sort: created` + `direction: asc` で最古） | PAT か GitHub App。「you can't use `GITHUB_TOKEN`」 | node24、v0.11.1（2026-06） |
| chinthakagodawita/autoupdate | `PR_FILTER: auto_merge` で auto-merge 有効の PR | **全部** | README の例は `GITHUB_TOKEN`。「Branch updates events caused by this action will not trigger any subsequent workflows」と自分で制限を書いている | docker、最終 push 2024-07 |
| tibdex/auto-update | auto-merge 有効の PR | **全部** | 既定 `github.token`（入力で差し替え可） | node16、最終 push 2024-02 |

  — 各 README / action.yml（https://github.com/adRise/update-pr-branch 、https://github.com/chinthakagodawita/autoupdate 、https://github.com/tibdex/auto-update ）

- **自作**: `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`（`gh pr update-branch`）を、`push: main` で 1 件だけ（最古の予約・緑・BEHIND）に当てる。今の takt-sequence がやっていることを、作者を問わず Actions に移す形。
- **注意（1 件ずつの落とし穴）**: `push: main` だけを引き金にすると、揃えた 1 件が CI で落ちたとき、次の main の push まで誰も揃えない（tibdex のワークフロー例も「push だけを聞く」と明記）。`check` の完了（`workflow_run` / `check_suite`）や定期実行も引き金に足す必要がある。
- **利点**: 今の `gh pr merge --auto` の運用を変えない。Actions の分数は無料。外部サービスなし。
- **欠点**: トークン（App の秘密鍵または PAT）の保管と更新が要る。自作ならキューの公平さ・失敗時の次への進め方を自分で書く。
- **壊れたときの影響**: 動かなければ今と同じ「BEHIND で止まる」に戻るだけ。main は守られる。

### 4. strict をやめ、main の CI と revert（直しの PR）で守る

- GitHub Docs の整理: Loose は「Status checks may fail after you merge your branch if there are incompatible changes with the base branch」。Strict は「More builds may be required」。
  — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- **利点**: 揃えの仕組みが要らない。CI の追加は 0。マージが最速。
- **欠点**: #1106 と #1085 のような意味の衝突がそのまま main に入る。check.yml は PR では変更パスのジョブしか走らせないので、PR の緑が main の緑を意味する度合いはさらに下がる。
- **壊れたときの影響**: 最大。main が赤い間も、他の予約済み PR は自分の緑だけでマージされ続け、赤の上に積まれる。気付き・revert は人（またはエージェント）頼み。ただし strict でも main は赤くなる（10/15 は helper の IT が main の push で 3 回落ちた。直近 40 回中 5 回失敗）ので、main の CI を見張る仕組みはどの案でも別途要る。

## CI の空回りの見積もり

前提: 1 日 N = 30〜45 件。k = あるマージの瞬間に予約済みで待っている PR の数（マージされる 1 件を含む）。takt 並列 2 と手で引き取った分で、普段 k = 2〜3、ピークで 4 程度と置く（実測ではない）。CI 1 回 3.5 分。「追加の run」は strict のために増える CI、「空回り」はそのうち結果が使われずに捨てられる run。

- **全部を一斉に揃える**（main に 1 件入るたびに、BEHIND の予約を全部 update-branch）: 1 回のマージで k−1 件を揃え、次にマージされるのはその 1 件だけなので、残り k−2 件の run は次のマージで捨てられる。
  - 追加の run = N(k−1)、空回り = N(k−2)
- **1 件ずつ順に揃える**（最古の 1 件だけ揃え、それが入ったら次）: 1 回のマージで多くて 1 件。揃えた 1 件が落ちたときだけ無駄が出る。
  - 追加の run ≦ N、空回り ≒ 0（揃えた PR の CI 失敗分のみ）

| k | 一斉: 追加 / 空回り（回/日） | 一斉の空回りの CI 時間 | 1 件ずつ: 追加 / 空回り |
|---|---|---|---|
| 2 | 30〜45 / 0 | 0 | 30〜45 / ≒0 |
| 3 | 60〜90 / 30〜45 | 約 1.8〜2.6 時間 | 30〜45 / ≒0 |
| 4 | 90〜135 / 60〜90 | 約 3.5〜5.3 時間 | 30〜45 / ≒0 |

- 一斉の方式では、同時に k−1 本の run が走る。全量なら 1 本 13 ジョブなので、Free の 20 ジョブ上限では 2 本目から runner 待ちになり、他の PR の CI も遅れる（PR の run は変更パスで減るので、実際は 13 より少ないことが多い）。
- 1 件ずつの方式の上限: 揃え → CI（3.5 分、p90 4.6 分）→ マージで 1 件 4〜5 分、1 時間 12〜15 件。ピークの 10 件/時は収まるが、ピークでは待ち行列ができ、後ろの PR は k × 4〜5 分待つ。
- 一斉の方式の利点は、先頭が落ちたときに次がすでに揃っていること。この規模では、k ≧ 3 のときの空回りと runner 待ちの方が重い。

## どれがこの規模に合うか

| 候補 | 今すぐ使えるか | 予約（`gh pr merge --auto`）を変えずに済むか | 空回り | 壊れたとき |
|---|---|---|---|---|
| GitHub のマージキュー | ✗（organization への移管が要る） | ○ | 通常 0（merge_group は毎回全量） | キューが止まる、main は安全 |
| Mergify（Open Source） | △（個人アカウントの可否が未確認、batch なし） | ✗（Mergify のキュー） | in-place なら ≒0 | マージが止まる、main は安全 |
| Kodiak | ○（public は無料） | ✗（ラベル） | 既定で ≒0 | マージが止まる、main は安全 |
| Actions・一斉 | ○（App トークン要） | ○ | k=3 で 30〜45 回/日 | 今と同じ止まり方に戻る |
| Actions・1 件ずつ | ○（App トークン要） | ○ | ≒0 | 今と同じ止まり方に戻る |
| strict をやめる | ○ | ○ | 0 | main が赤いまま積まれる |

この地図の決定（「揃える対象は予約済みの全 PR、作者を問わない」「takt-sequence 側の揃えは外して一本化」）と規模からは、**Actions で 1 件ずつ順に揃える（GitHub App のトークンを使い、`push: main` に加えて CI 完了も引き金にする）** が最も合う。既成なら adRise/update-pr-branch（1 件ずつ・auto-merge 限定・App トークン対応・node24 で保守中）が形に近いが、承認数の既定 2 を 0 にし、`sort`/`direction` で最古を選ぶ設定が要る。将来 organization へ移すなら、GitHub のマージキューに置き換えるのが本筋。

## 確かめていないこと

- 個人アカウントの public リポジトリが Mergify の Open Source プランに入るか（公開ページに記述なし）。
- `GITHUB_TOKEN` による update-branch の承認待ち run を、API で承認して走らせられるか（docs は fork の承認手順へのリンクのみ）。
- k（同時に待つ予約の数）の実測。今回は takt 並列 2 からの見積もり。
