# Actions で BEHIND の PR を揃えるときのトークンと起動イベント

issue #1179（地図 #1177）の調べ。2026-10-15 時点の一次資料（GitHub Docs、GitHub Changelog、`actions/create-github-app-token` の README、`gh` のソース）による。実機での試しはしていない（調べた時点で開いている PR が 0 件だった）。

## 答え（要約）

- **GITHUB_TOKEN で update-branch すると、PR の CI は「走らない」のではなく「承認待ちで止まる」。** 2026-06 の変更以降、GITHUB_TOKEN が作った・更新した PR の `opened`・`synchronize`・`reopened` は、書き込み権限のある人が承認するまで止まる run になる。必須チェック `check` は通らないままなので、自動マージは進まない。人が毎回承認するのでは目的に合わないので、PAT か App のトークンが要る。
- **トークンは自作の GitHub App + `actions/create-github-app-token` を勧める。** 要る権限は Pull requests: write だけ（＋念のため Workflows: write、後述）。トークンは 1 時間で切れ、ジョブの終わりに失効するので、漏れても被害の幅が小さい。秘密鍵は期限が無く、更新の運用が要らない。fine-grained PAT でも動く（同じく Pull requests: write）が、利用者本人として動き、期限を付ければ更新の手間、付けなければ長命の秘密が残る。
- **起動は `push`（main）を主にし、`pull_request` の `auto_merge_enabled` と `schedule` を補いに足す。** `workflow_run` は要らない。
- **フォークの PR は今の運用では来ない**（直近 200 件のマージはすべて daiki-beppu）。`pull_request_target` を使わずに済む。`push`・`schedule` のワークフローは main のコードで動き、シークレットも使えるので、フォークの PR も API で揃えられる（作者が「Allow edits from maintainers」を有効にしていれば）。
- **update-branch の API は 202 を返して非同期に揃える。** 衝突・HEAD の食い違いは 422。すでに最新のときの戻りは REST の文書に書かれていないので、`gh` と同じく先に比べて飛ばす。レート制限は 1 日 30〜45 件の規模ではまったく問題にならない。

## 1. GITHUB_TOKEN では CI が動かない、の正確な範囲

| 資料 | 書いてあること |
|---|---|
| [GITHUB_TOKEN（Docs）](https://docs.github.com/en/actions/concepts/security/github_token)「When `GITHUB_TOKEN` triggers workflow runs」 | "events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following exceptions:" 例外は `workflow_dispatch` と `repository_dispatch`（常に run を作る）。PR を GITHUB_TOKEN で作成・更新したときの `pull_request`（`opened`・`synchronize`・`reopened`）は "creates workflow runs in an **approval-required** state"。書き込み権限のある人が PR の画面で承認できる。`labeled`・`edited`・`closed` などは run を作らない。承認なしで走らせたいなら "use a GitHub App installation access token or a personal access token instead of `GITHUB_TOKEN`" |
| [Triggering a workflow（Docs）](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)「Triggering a workflow from a workflow」 | 同じ内容。ワークフローから別のワークフローを起こすには App のインストールトークンか PAT を使う |
| [Changelog 2026-06-11: Bot-created pull requests can run workflows if approved](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/) | それまで `github-actions[bot]` の PR は CI を走らせられず、CI を通らずにマージされうる状態だった。承認があれば走るように変えた |

この repo に当てはめると:

- update-branch は PR の head に main をマージしたコミットを積むので、`check.yml` の `pull_request`（既定の `synchronize`）が起きる。GITHUB_TOKEN で呼ぶと、その run は承認待ちで止まり、必須チェック `check` が揃わない。結果として自動マージは止まったまま。
- changelog は「bot が作った PR」についての記事で、update-branch（`synchronize`）を名指ししてはいない。Docs の本文が「created or updated」と書いているので、update-branch も承認待ちになると読むのが自然。ただ実機では確かめていない。
- 逆に、自動マージの結果の main への push は、自動マージを予約した利用者の操作として起きる（GITHUB_TOKEN ではない）ので、`push` で起動するワークフローは普通に走る。予約を GITHUB_TOKEN で行うと、その push はワークフローを起こさない。

## 2. PAT と GitHub App の比較

| 観点 | fine-grained PAT | 自作 GitHub App + `actions/create-github-app-token` |
|---|---|---|
| update-branch に要る権限 | Pull requests: write（[fine-grained PAT の権限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)）。一覧の取得は Pull requests: read | Pull requests: write（[App の権限表](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)）。REST の文書は App について「head のリポジトリの contents への書き込み権限も要る」と書く（[update-branch](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch)）ので、Contents: write も付ける |
| 誰として動くか | 利用者本人。"Personal access tokens are intended to access GitHub resources on behalf of yourself."（[PAT の管理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)）。揃えのマージコミットは利用者の名前で積まれる | `<app-slug>[bot]`。利用者の操作と見分けられる |
| 対象リポジトリ | 個人アカウントを resource owner にし、「Only select repositories」でこの repo だけに絞れる | App をこの repo だけにインストールし、`create-github-app-token` の `repositories`・`permission-*` でさらに絞れる（既定ではインストールの全権限を継ぐ） |
| 有効期限 | 1〜366 日、または無期限。"Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy"（個人アカウントの repo には組織の方針が掛からない）。既定は 30 日 | インストールトークンは 1 時間で切れる。既定でジョブの終わり（post step）に失効させる（`skip-token-revoke` で止められる）。秘密鍵は "Private keys do not expire and instead need to be manually revoked"（[秘密鍵の管理](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)） |
| 更新の手間 | 期限を付けると、切れるたびに作り直してシークレットを差し替える。切れた日は揃えが止まる（気付く仕組みが要る） | 平常は無し。鍵を替えるときは新しい鍵を作ってから古い鍵を消す（鍵は 1 App に 25 個まで、最後の 1 個は消せない） |
| 作る手間 | 設定画面でトークンを作り、repo のシークレットに入れるだけ | App を登録（Webhook は不要）→ Pull requests・Contents の権限 → 秘密鍵を作る → 個人アカウントに、この repo だけでインストール → client ID を変数、秘密鍵をシークレットに入れる（[Actions から App で API を呼ぶ](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow)）。ワークフローに `actions/create-github-app-token@v3` の 1 ステップが増える |
| 秘密の保管 | repo のシークレット | repo のシークレット（README の推奨）。Docs は鍵を "the single most valuable secret for a GitHub App" と呼ぶ。鍵ファイルは中身（`-----BEGIN RSA PRIVATE KEY-----` から末尾まで）をそのまま入れる |
| 漏れたときの幅 | 期限まで、選んだ repo に対して本人の権限の範囲で使える | 鍵が漏れると App の権限で新しいトークンを作れる（期限なし）。トークンだけ漏れたなら最長 1 時間 |
| レート制限 | 本人の 5,000 件/時（他の作業と共有） | インストールごとに最低 5,000 件/時（[REST のレート制限](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)） |
| GitHub の推奨 | "for long-lived integrations, you should use a GitHub App"、"If you require more tokens or are building automations, consider using a GitHub App"（PAT の管理） | — |

### 未確認: Workflows 権限

main が `.github/workflows/` を変えたあと、そのコミットを PR にマージする update-branch が、Workflows 権限の無い App・PAT で断られるかは、一次資料で確かめられなかった。権限表の Workflows の節は contents・git refs・releases の API だけを挙げ、update-branch は載っていない。コミュニティでは「Workflows 権限の無い App はワークフローファイルを含む push を断られる」という報告が多い（一次資料ではない）。この repo は check.yml をよく変えるので、**Workflows: write も付けておく**か、実装の最初に「main で workflow を変えた直後の update-branch」を 1 回試して決める。

## 3. 起動するイベントと、それぞれの漏れ方

いずれも [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) による。

| イベント | 拾えるもの | 漏れ方 |
|---|---|---|
| `push`（`branches: [main]`） | main が進んだ瞬間に、予約済みで BEHIND の PR をまとめて揃える。主になる | (a) main が進んだ**後に**予約された PR（その時点ですでに BEHIND）は、次の push まで拾われない。(b) 揃えた PR の CI が落ちる・揃えの API が失敗したまま main が止まると、次の push まで再試行されない。(c) GITHUB_TOKEN で行った push は run を作らない（今の運用では自動マージは利用者の予約なので当たらない）。(d) 同時に 5,000 を超えるブランチの push など、この規模では起きない制限のみ |
| `pull_request` の `auto_merge_enabled` | 予約した瞬間に、その PR が BEHIND なら揃える。(a) を埋める | ワークフローは PR のマージ ref の定義で走る。"Workflows will not run on `pull_request` activity if the pull request has a merge conflict."（衝突している PR では起きない。どのみち揃えられない）。フォークの PR ではシークレットが渡らず、App・PAT のトークンが作れない（4 節）。予約を GITHUB_TOKEN で行った場合は run が起きない |
| `schedule` | 定期の拾い直し。(b) や API の一時的な失敗、上の 2 つの取りこぼしをまとめて埋める | 最短 5 分間隔。"can be delayed during periods of high loads"、"some queued jobs may be dropped"。既定ブランチでだけ走る。public repo は 60 日活動が無いと止まる（この repo では起きない） |
| `workflow_run` | 別のワークフロー（check.yml）が終わったときに起きる | この用途では要らない。main の CI の終わりで起こしても `push` より遅いだけ。"only trigger a workflow run if the workflow file exists on the default branch"、連鎖は 3 段まで。フォークの PR の CI から起きた場合も main のコードとシークレットで走るので、`pull_request_target` と同じ注意が要る（[pull_request_target を安全に使う](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)） |
| `workflow_dispatch` | 手で起こす | 手で起こさない限り走らない。GITHUB_TOKEN からでも run を作れるので、他のワークフローから呼ぶ口にもなる |

組み合わせの案: `push`（main）＋ `pull_request: types: [auto_merge_enabled]` ＋ `schedule`（例: 15 分ごと）＋ `workflow_dispatch`。どれから起きても同じ処理（予約済み・BEHIND の PR を列挙して揃える）にする。`concurrency` で同時に 1 本に絞る。

注: 揃えた PR は CI をやり直す。BEHIND の PR を全部同時に揃えると、最初にマージされた 1 件以外はまた BEHIND になり、CI がやり直しになる。全部か 1 件ずつかは仕様で決める（#1177 の「Not yet specified」）。

## 4. フォークからの PR とシークレット

- `pull_request` では "The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories"、"secrets are not passed to the runner when a workflow is triggered from a forked repository"。フォークの PR の `auto_merge_enabled` から起きた run では、App の秘密鍵も PAT も読めず、揃えられない。
- `pull_request_target` はシークレットを使えるが、"Running untrusted code on the `pull_request_target` trigger may lead to security vulnerabilities."。PR のコードを checkout・実行しなければ安全に使えるが、**public repo では既定の Actions event policy が `pull_request_target` を止める。2026-11-02 に強制になる**（[Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)、[Changelog 2026-09-17](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/)）。使うなら明示的に許可する方針が要る。
- **`pull_request_target` は使わずに済む。** フォークの PR の予約は、`push`（main）と `schedule` が拾う。この 2 つは main のワークフローとシークレットで走り、PR のコードを checkout しない（API を呼ぶだけ）。
- ただしフォークの PR を update-branch できるのは、作者が「Allow edits from maintainers」を有効にしているときだけ（[フォークの PR ブランチへの変更を許可する](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork)。push 権限のある人が PR を変更できる）。揃えのコミットはフォーク側の `pull_request` を起こし、その CI はシークレットなしで走る（今の check.yml はシークレットを使っていない）。
- 自動マージは "Auto-merge is disabled if someone without write permissions pushes new changes to the head branch"（[自動マージ](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)）。App・PAT は書き込み権限を持つので、揃えで予約は外れない。
- 現状: 直近にマージされた 200 件の作者はすべて daiki-beppu。フォークの PR は当面の想定外としてよい。

## 5. update-branch の API が返すもの

REST: `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch`（[Docs](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch)）

- 説明: "Updates the pull request branch with the latest upstream changes by merging HEAD from the base branch into the pull request branch."（マージで揃える。REST に rebase の指定は無い）
- 入力: `expected_head_sha`（任意）。PR の HEAD と合わなければ 422。既定は今の HEAD。
- 202 Accepted: 本文は `message` と `url`。**揃えは非同期**で、202 の時点ではまだ積まれていない。揃ったかは PR の head SHA の変化か `synchronize` で知る。
- 403 Forbidden: 詳細の記載なし（権限不足など）。
- 422: "Validation failed, or the endpoint has been spammed." `expected_head_sha` の食い違いもここ。
- **衝突のとき・すでに最新のとき**: REST の文書には書かれていない。`gh pr update-branch` のソース（[cli/cli@819f972 `pkg/cmd/pr/update-branch/update_branch.go`](https://github.com/cli/cli/blob/819f972eff771d5ec433c8d03c369cc43f1eab49/pkg/cmd/pr/update-branch/update_branch.go)）は、API を呼ぶ前に
  - `mergeable == CONFLICTING` なら "Cannot update PR branch due to conflicts" で止める
  - compare API の `behind_by == 0` なら "PR branch already up-to-date" で何もしない
  - API は GraphQL の `updatePullRequestBranch`（`expectedHeadOid` と `updateMethod`: MERGE / REBASE）を使い、衝突は "merge conflict between base and head (updatePullRequestBranch)" のエラー文字列で見分ける（ソースのコメントいわく "best effort"）。
  - 自前のワークフローも同じく、`mergeStateStatus == BEHIND` の PR だけを選んで呼び、`DIRTY`（衝突）は揃えずに知らせる側へ回すのが確実。`gh pr update-branch` をそのまま呼べば上の分岐がそのまま手に入る。
- レート制限（[REST のレート制限](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)）: 一次は PAT 5,000 件/時、App インストール 5,000 件/時以上（非 Enterprise は 12,500 まで）、GITHUB_TOKEN 1,000 件/時/repo。二次は同時 100 リクエスト、900 点/分、内容を作るリクエスト 80 件/分・500 件/時。update-branch は内容を作る側に数えられると見ておく。1 日 30〜45 件のマージで、1 回の起動で数件を揃える規模なら、どの上限にも遠い。

## 資料一覧

- https://docs.github.com/en/actions/concepts/security/github_token
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
- https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/
- https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch
- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow
- https://github.com/actions/create-github-app-token/blob/main/README.md
- https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
- https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork
- https://github.com/cli/cli/blob/819f972eff771d5ec433c8d03c369cc43f1eab49/pkg/cmd/pr/update-branch/update_branch.go
