# 個人 repo で使える Actions の仕組みの制約（merge queue・schedule・concurrency）

調査日: 2026-10-28。issue [#1695](https://github.com/daiki-beppu/live-mindmap/issues/1695)（map [#1694](https://github.com/daiki-beppu/live-mindmap/issues/1694)）。

前提（2026-10-28 に `gh api` で確認）:

- `daiki-beppu/live-mindmap` は個人アカウント（`owner.type: User`）所有の公開 repo。アカウントのプランは `free`。
- ruleset「main: CI を必須にする」は `required_status_checks` に `check`（GitHub Actions）を 1 つ置き、`strict_required_status_checks_policy: true`（up-to-date を求める）。
- `.github/workflows/check.yml` は `pull_request` と `push`（main）で動き、`concurrency` は書いていない。集約ジョブ `check` は `if: always()`。

## 結論

| 問い | 答え |
|---|---|
| merge queue | **使えない**。公開 repo では組織所有に限られる。今の「up-to-date を求める ruleset + align-behind」は置き換えられない |
| `schedule` | 既定ブランチの最新コミットでしか動かない。毎時 0 分付近は遅れやすく、負荷が高いと取りこぼす。公開 repo は 60 日 repo に活動が無いと自動で無効になる。最短間隔 5 分、既定は UTC（`timezone` 指定可） |
| 同じ PR の古い run を止める | `concurrency` + `cancel-in-progress: true` で止められる。`workflow_run` は向かない（既定ブランチのワークフローで動き、PR の head とは別の SHA で走る） |
| 同時実行の上限 | Free プランで全体 20 ジョブ、うち macOS は 5 ジョブ（Pro でも macOS は 5） |

## merge queue

- 可用性: GitHub Docs の可用性の定型文（`data/reusables/gated-features/merge-queue.md`）は「Pull request merge queues are available in any public repository owned by an organization, or in private repositories owned by organizations using GitHub Enterprise Cloud.」。個人アカウント所有の repo は対象外。
  - 出典: <https://github.com/github/docs/blob/main/data/reusables/gated-features/merge-queue.md>（docs.github.com の本文 API はこの定型文を落とすので、ソースで確認した。表示先は <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue> の冒頭）
  - GA の告知も同じ範囲: 「available on private and public repos on the GitHub Enterprise Cloud plan and all public repos owned by organizations」<https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/>
  - 2026-10 までの changelog に、個人 repo へ広げた告知は見当たらない（2026-10-01 の async merge API、2026-10-06 の stacked PR GA も merge queue に触れるが可用性は変えていない）。
- 参考（使えた場合の関係。今の repo では使えない）:
  - merge queue は「Require branches to be up to date before merging と同じ利点を、作者に更新と待ちを求めずに得る」もの。
  - Actions で必須チェックを出しているなら、`on:` に `merge_group` を足す必要がある。足さないと queue に入れた PR でチェックが走らず、必須チェックが報告されずにマージが失敗する。`merge_group` は `pull_request`・`push` とは別のイベント。
  - 出典: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>、<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group>
- この repo への含意: 段を分けても「main に入る前に up-to-date で `check` を通す」のは今と同じく PR の `pull_request` の run が担う。align-behind（ADR 0021・0022）と `gh pr update-branch` は残る。組織へ移管すれば使えるが、それは map の範囲外の判断。

## `schedule`（cron）

出典: <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>

- 遅れ・取りこぼし: 「can be delayed during periods of high loads … High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped.」毎時 0 分を避けるよう勧めている。遅れや取りこぼしの上限・保証は書かれていない（落ちても再実行されない前提で組む）。
- 既定ブランチのみ: 「This event will only trigger a workflow run if the workflow file exists on the default branch.」「Scheduled workflows will only run on the default branch.」`GITHUB_SHA` は既定ブランチの最新コミット。PR のブランチで cron の変更を試すことはできない（`workflow_dispatch` を併記して手で試すのが普通）。
- 60 日の無活動: 「In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days.」何を活動と数えるかは Docs に定義が無い。再有効化は <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows#enabling-a-workflow>（UI か `gh workflow enable`）。この repo は毎日コミットがあるので当面は当たらないが、開発が止まると Nightly・Weekly が黙って止まる。
- 間隔とタイムゾーン: 最短 5 分。既定は UTC、IANA の `timezone` を指定できる。夏時間で飛ぶ時刻は次の有効な時刻へずれる（Asia/Tokyo は夏時間が無いので関係しない）。
- 失敗の拾い方（map の範囲にある「定期実行の失敗を拾う仕組み」に関係）: `schedule` の run には PR が無く、必須チェックとしても効かない。失敗は Actions の通知か、別の仕組みで issue 化する必要がある（本調査の範囲外、別 ticket で決める）。

## 同じ PR の古い run を止める: `concurrency`・`cancel-in-progress`・`workflow_run`

出典: <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>

- 同じ concurrency group で走れるのは常に 1 つ。新しい run が来ると、既定でも `pending` の run は取り消される。`cancel-in-progress: true` で実行中の run も取り消す。ワークフロー単位でもジョブ単位でも書ける。
- Docs の例: `group: ${{ github.head_ref || github.run_id }}` は `pull_request` でだけ古い run を取り消し、`push` では run ID に落ちて取り消さない。`cancel-in-progress` は式で条件付きにできる（例: main への push は取り消さない）。
- `queue: max`（最大 100 件の pending を保つ）と `cancel-in-progress: true` は併用不可（検証エラー）。上限は <https://docs.github.com/en/actions/reference/limits>。
- group 名は大文字小文字を区別しない。順序は待ち始めた順の FIFO だが保証はない。
- この repo で書くときの注意: 集約ジョブ `check` は `if: always()`。`always()` は「even when canceled」でも true になる（<https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#always>）ので、取り消された古い run でも `check` は走り、依存の `cancelled` を見て failure を古い head SHA に付ける。ruleset が見るのは新しい head SHA の `check` なのでマージは妨げないが、ubuntu-slim の短いジョブが 1 つ余分に動き、PR の古いコミットに赤が残る。
- `workflow_run` は向かない: 「only trigger a workflow run if the workflow file exists on the default branch」、`GITHUB_SHA` は既定ブランチの最新コミット、連鎖は 3 段まで。後続の run は PR の head に付く必須チェックにならず、古い run の取り消しにも使えない（取り消すなら API を叩く自前の仕組みになる）。出典: <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run>

## 同時実行の上限（標準の GitHub ホストランナー）

出典: <https://docs.github.com/en/actions/reference/limits>

| プラン | 全体の同時ジョブ | macOS の同時ジョブ |
|---|---|---|
| Free（この repo の所有者） | 20 | 5 |
| Pro | 40 | 5 |
| Team | 60 | 5 |
| Enterprise | 500 | 50 |

- macOS の上限は標準ランナーと larger runner で共有。Docs に公開 repo だけ別枠という記述は無い（上限はアカウント単位で、公開 repo でも同じ表が効く）。上げたいときはサポートに依頼できると書かれている。
- 他の上限: ジョブの実行は 6 時間まで、ワークフローの run は待ち時間込みで 35 日まで。GitHub ホストランナーのキュー待ちの上限は書かれていない（24 時間はセルフホストの値）。
- この repo への含意: 今の PR 1 本で ubuntu が最大 7 ジョブ前後（changes・ts・heavy×3・e2e・check）と macOS 1 ジョブ。PR が 3 本ほど同時に走ると全体 20 に近づき、Nightly・Weekly を同じ時間に重ねると PR がランナー待ちになる。macOS 5 の上限は helper ジョブの段の振り分け（map の未決事項）に効く。古い run を `cancel-in-progress` で取り消すと、この枠の無駄が減る。
