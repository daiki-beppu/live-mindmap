# 変更パスでジョブを飛ばしつつ必須チェック `check` を集約ジョブで満たす書き方

調査日: 2026-10-06 / issue #221（map #217 の子）

## 結論

1. **ワークフロー単位の `on.pull_request.paths` は使えない。** パスで飛ばされたワークフローのチェックは「Pending」のまま残り、必須チェック `check` が永遠に待機する。GitHub 自身が「飛ばされうるワークフローを必須にするな」と書いている。
2. **ジョブ単位の `if:` で飛ばす。** `if:` で飛ばされたジョブは「Success」を報告するので、必須チェックを止めない。
3. **集約ジョブ `check` は `if: always()` を必ず付け、`needs` 全体の結果を見て失敗・キャンセルなら `exit 1` する。** `always()` が無いと、依存ジョブが落ちたときに `check` 自体が「skipped」になり、skipped は Success 扱いなので**失敗した PR がマージできてしまう**（GitHub Docs が明記）。`!cancelled()` ではなく `always()` にするのは、キャンセル時にも `check` を走らせて失敗として報告させるため。
4. **パス判定はサードパーティなしの `git diff` 自前で足りる。** PR では `actions/checkout` が取るマージコミットの第 1 親（`HEAD^1`）がベースの先端なので、`fetch-depth: 2` で `git diff --name-only HEAD^1 HEAD` を取ればよい。astral-sh/ruff が同じ形（`${GITHUB_SHA}^1`）で運用している。判定ジョブの稼働は数秒（ruff の大きいリポジトリで全履歴を取っても 12 秒）。dorny/paths-filter を使うなら `ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d # v4.0.3` に SHA で留め、`pull-requests: read` を付ける。
5. **push to main は全部走らせる。** ruleset の必須チェックは PR のマージ判定にしか効かず、main の push は差分判定のずれ（積んだ PR、同時マージ）を拾う最後の網になる。OSS で分数は気にしないので、判定を省いて常に全ジョブを走らせるのが一番単純で安全。

## 根拠

### ワークフロー単位の `paths` は必須チェックを Pending で止める

- Workflow syntax の `on.<push|pull_request|pull_request_target>.<paths|paths-ignore>`:
  "If a workflow is skipped due to path filtering, branch filtering, or a commit message, then checks associated with that workflow will remain in a 'Pending' state."
  — https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- Troubleshooting required status checks の「Handling skipped but required checks」: パス・ブランチ・コミットメッセージでワークフローが飛ばされるとチェックが Pending のままマージを塞ぐ。対処は "Avoid requiring workflows that can be skipped."
  — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks

### `if:` で飛ばしたジョブは Success

- "A job that is skipped will report its status as 'Success'. It will not prevent a pull request from merging, even if it is a required check."
  — https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions
- 同じ性質が裏目に出るのが次項。

### 依存先が落ちると、`always()` の無い集約ジョブは skipped = Success になる

- `jobs.<job_id>.needs`: 必要なジョブが失敗または skip すると "all jobs that need it are skipped unless the jobs use a conditional expression that causes the job to continue."（例として `if: ${{ always() }}` を示す）
  — https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- Troubleshooting required status checks: "A job depends on a failed job" の場合 "The dependent job is skipped and may not block merging." 必須チェックが依存を持つなら `needs` と `always()` を使え、とある。
- re-actors/alls-green の README も同じ落とし穴を動機に挙げている（"in case when something fails, the `check` job's result is set to `skipped` and not `failed`"）。
  — https://github.com/re-actors/alls-green

### 結果の判定に使う値

- `needs.<job_id>.result`: "Possible values are `success`, `failure`, `cancelled`, or `skipped`."
  — https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
- `always()`: "Causes the step to always execute, and returns `true`, even when canceled."
  Docs は致命的な失敗がありうる処理には `if: ${{ !cancelled() }}` を勧めているが、集約ジョブは判定だけでキャンセル時も走って失敗を報告してほしいので `always()` が合う（`!cancelled()` だとキャンセル時に `check` が skipped = Success になりうる）。
  — https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
- `contains(search, item)` は配列に要素があれば true。`needs.*.result` のオブジェクトフィルタで全依存の結果を配列にできる（同ページ）。

### パス判定の手段

| 手段 | PR での差分の取り方 | 要るもの | 備考 |
| --- | --- | --- | --- |
| ワークフローの `on.pull_request.paths` | 3 点差分 | — | 必須チェックが Pending で止まるので**不可** |
| `git diff` 自前 | マージコミット `HEAD` と第 1 親 `HEAD^1`（＝ベース先端）の 2 点差分 | `actions/checkout`（`fetch-depth: 2`） | 依存なし。ruff の前例あり |
| dorny/paths-filter v4 | REST API で PR の変更ファイル一覧を取得 | `pull-requests: read`。PR では checkout 不要 | 3,350 stars、2026-08 に v4.0.3（node24）。SHA ピン留めが要る |

- dorny/paths-filter README: pull_request では "Changes are detected against the pull request base branch"、"Uses GitHub REST API to fetch a list of modified files"、"Requires pull-requests: read permission"。push では git コマンドで判定し checkout が必要。出力は各フィルタ名に `'true'`/`'false'`、`changes` に該当フィルタ名の JSON 配列。
  — https://github.com/dorny/paths-filter（action.yml は `runs.using: node24`）
- v4.0.3 のリリースに `list-files` の shell/csv 出力でファイル名がエスケープされない脆弱性の修正（GHSA-7hc6-8hq5-9q2m）がある。`*_files` 出力を使わない（true/false だけ使う）なら影響しないが、使うなら v4.0.3 以上。
- astral-sh/ruff `.github/workflows/ci.yaml` の `determine_changes` ジョブ: PR では `sha="$(git rev-parse "${GITHUB_SHA}^1")"`（"The first parent contains any preceding layers in a stacked pull request."）、その後 `git diff --quiet "${MERGE_BASE}...HEAD" -- <pathspec>` で各フラグを `$GITHUB_OUTPUT` に出す。集約ジョブ `required-checks-passed` は `if: always()` で、`toJSON(needs)` を jq で見て success/skipped 以外があれば `exit 1`。
  — https://github.com/astral-sh/ruff/blob/main/.github/workflows/ci.yaml
- `gh stack` で積んだ PR でも、`pull_request` の `HEAD^1` は PR のベースブランチ（下の層）の先端なので、その層の差分だけを見る。dorny も PR ではベースブランチ相手に判定するので同じ。

### 判定ジョブ・集約ジョブの所要時間

ruff の PR の run（25507839411, 2026-05-07）の実測:

- `Determine changes`（ubuntu、全履歴を `--unshallow` で取得）: キュー 10 秒、稼働 12 秒（Set up job 1 秒、checkout 5 秒、fetch 4 秒、diff 群 1 秒）。
- `all required checks passed`（`ubuntu-slim`）: キュー 4 秒、稼働 1 秒。

このリポジトリは小さく、`fetch-depth: 2` で済むので判定ジョブは 5 秒前後の見込み（試作で実測する）。

- `ubuntu-slim`: 1 CPU / 5 GB、VM ではなくコンテナ、"The job timeout for single-CPU runners is 15 minutes."、public でも使える。判定・集約のような軽いジョブ向け。
- public リポジトリの `ubuntu-latest` は 4 コア / 16 GB、`macos-26` は 3 コア（M1）/ 7 GB。
  — https://docs.github.com/en/actions/reference/runners/github-hosted-runners

### サードパーティアクションの SHA ピン留め

- "Pinning an action to a full-length commit SHA is currently the only way to use an action as an immutable release."、SHA はフォークでなく本家リポジトリのものか確認すること。リポジトリ・組織の設定で SHA ピン留めを必須にできる。
  — https://docs.github.com/en/actions/reference/security/secure-use
- このリポジトリの設定は `allowed_actions: all`、`sha_pinning_required: false`（`gh api repos/daiki-beppu/live-mindmap/actions/permissions`）。今の `check.yml` は `actions/checkout@v7` などタグ参照。必須ではないが、新しく入れるサードパーティ（dorny 等）は SHA で留めるのが Docs の推奨。
- 参考 SHA（`gh api repos/<owner>/<repo>/tags` で確認、2026-10-06 時点）:
  - dorny/paths-filter v4.0.3 = `ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d`（`v4` タグも同じ）
  - re-actors/alls-green v1.3.0 = `b5b5b37504aa4183270bd3d855c52a67f212be35`

### ruleset 側の前提

- `gh api repos/daiki-beppu/live-mindmap/rulesets/24566654`: `required_status_checks: [{context: "check", integration_id: 15368}]`、`strict_required_status_checks_policy: false`。
- チェック名はジョブの `name:`（無ければジョブ ID）。集約ジョブの ID を `check` のままにし、他のジョブやマトリクスに `check` という名前を使わない。integration 15368（GitHub Actions）が出したチェックでないと "was not set by the expected GitHub App" で満たされない（Troubleshooting required status checks）。
- 同名のチェックとコミットステータスがあると両方通る必要がある（同ページ）。

## 試作で使う YAML 断片

フィルタの中身（どのパスで何を走らせるか）とジョブの分け方は試作の側で決める。ここでは形だけ示す。docs 判定は「既知の docs パス以外が 1 つでもあれば走らせる」向きにして、知らないパスは安全側（走る）に倒す。

```yaml
name: check

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  changes:
    runs-on: ubuntu-slim
    outputs:
      ts: ${{ steps.filter.outputs.ts }}
      swift: ${{ steps.filter.outputs.swift }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 2 # PR ではマージコミットとその親（ベース先端と PR 先端）まで
          persist-credentials: false
      - id: filter
        run: |
          if [ "$GITHUB_EVENT_NAME" != pull_request ]; then
            # push to main は全部走らせる
            echo "ts=true" >> "$GITHUB_OUTPUT"
            echo "swift=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          # HEAD はマージコミット、HEAD^1 はベースブランチの先端
          files=$(git diff --name-only HEAD^1 HEAD)
          code=$(printf '%s\n' "$files" | grep -Ev '^(docs/|LICENSE$)|\.md$' || true)
          if [ -n "$code" ]; then ts=true; else ts=false; fi
          if printf '%s\n' "$code" | grep -Eq '^(helper/|\.github/workflows/)'; then swift=true; else swift=false; fi
          echo "ts=$ts" >> "$GITHUB_OUTPUT"
          echo "swift=$swift" >> "$GITHUB_OUTPUT"
          printf 'changed:\n%s\n-> ts=%s swift=%s\n' "$files" "$ts" "$swift"

  server-test:
    needs: changes
    if: needs.changes.outputs.ts == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo ...

  swift-test:
    needs: changes
    if: needs.changes.outputs.swift == 'true'
    runs-on: macos-26
    steps:
      - run: echo ...

  # ruleset の必須チェック。ジョブ ID（チェック名）を変えない
  check:
    if: always() # 依存が落ちても・キャンセルされても走らせ、skipped（= Success）にさせない
    needs: [changes, server-test, swift-test] # 全ジョブを列挙する。changes も入れる
    runs-on: ubuntu-slim
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        env:
          NEEDS_JSON: ${{ toJSON(needs) }}
        run: |
          echo "$NEEDS_JSON"
          exit 1
      - run: echo ok
```

dorny/paths-filter を使う場合の `changes` ジョブ（PR は API、push は git）:

```yaml
  changes:
    runs-on: ubuntu-slim
    permissions:
      contents: read
      pull-requests: read
    outputs:
      ts: ${{ github.event_name == 'push' || steps.filter.outputs.ts == 'true' }}
      swift: ${{ github.event_name == 'push' || steps.filter.outputs.swift == 'true' }}
    steps:
      - if: github.event_name == 'pull_request'
        uses: dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d # v4.0.3
        id: filter
        with:
          predicate-quantifier: some-with-excludes
          filters: |
            ts:
              - '**'
              - '!docs/**'
              - '!**/*.md'
              - '!LICENSE'
            swift:
              - 'helper/**'
              - '.github/workflows/**'
```

（`outputs` の式は文字列 `'true'`/`'false'` になる。`some-with-excludes` は v4.0.3 で入った値なので、それ未満では使えない。ここは試作で確かめる。）

## 気をつけること

- `needs` に新しいジョブを足し忘れると、そのジョブが落ちても `check` は通る。ジョブを足すときは `check.needs` も更新する（alls-green を使っても列挙は要る）。
- `check` に `if: always()` 以外の条件（例: ruff の `github.ref != 'refs/heads/main'`）を足すと、条件が偽のとき `check` は skipped = Success になる。PR で偽になる条件は入れない。
- `pull_request` はマージコミットが作れない（コンフリクト中の）PR では走らない。今と同じ挙動。
- `changes` のフィルタに `.github/workflows/**` を入れておくと、CI 自体を書き換える PR で全ジョブが走り、書き換えの検証になる。
- 差分のファイル名を `$GITHUB_OUTPUT` やシェルにそのまま流さない（PR 側が付けたファイル名は信頼できない）。上の断片は true/false だけを出している。
