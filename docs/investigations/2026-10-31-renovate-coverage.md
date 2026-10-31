# Renovate がこの repo の 6 系統の依存をどこまで扱えるか（Issue #1823）

map #1822 の調査 ticket。Renovate（Mend が hosted する GitHub App、無料の Community Cloud を想定）で、この repo の 6 系統の依存をどこまで追えるかを一次資料で確かめた。

一次資料（docs.renovatebot.com とその元の `renovatebot/renovate` の docs・ソース）に加えて、Renovate CLI 44.198.3（2026-10-31 時点の npm の最新。hosted は「数時間〜1 週間遅れで追う」と docs にある）をこの repo の main（55e654e）の写しに `--platform=local --dry-run=lookup` で当て、何を抽出してどの更新を出すかを実際に見た。lookup までなので、lock の再生成（artifacts）は走らせていない。hosted だけの挙動（allowedCommands の中身、pnpm 12 の導入）は hosted のログでしか確かめられない。

## 結論

| 系統 | 判定 | どう扱うか |
|---|---|---|
| pnpm workspace（server・web・e2e・root）、root の `packageManager` | 扱える（lock は条件付き） | npm マネージャが 8 つの `package.json` と `pnpm-workspace.yaml` を読み、`pnpm-lock.yaml` は `pnpm install --lockfile-only --recursive --ignore-scripts --ignore-pnpmfile` で作り直す。pnpm の版は `packageManager`（`pnpm@12.11.2`）から決まり、`packageManager` 自体も更新候補になる（12.11.2→12.16.1 を出した）。`pnpm-workspace.yaml` の設定は pnpm 自身が読むので消えないが、`peerDependencyRules.allowedVersions` の `4.0.6` は依存として抽出されないので、custom regex manager で effect と同じグループに入れる必要がある |
| workspace 外の npm lock（`server/managed-deps/claude`・`chromium`） | 扱える | 2 つの `package.json` を別の npm プロジェクトとして読み、`package-lock.json` は `packageManager: npm@11.19.1` の npm で作り直す。`npm` の `packageManager` も更新候補になる（11.21.1、major 12.2.1） |
| Swift の FluidAudio（`revision:` 固定） | 扱えない | swift マネージャの抽出は `from:`・`exact:`・`.exact()`・範囲だけ。`revision:` は値を読み違えて `invalid-value` で飛ばした。固定している commit は v0.17.6 以降のタグに含まれるので、`exact: "0.17.6"` などタグ指定に移せば追える（`Package.resolved` も Renovate が書き換える） |
| AEC3 のビルド元（`build-webrtc-apm.sh` の `COMMIT=`） | 条件付きで扱える | custom regex manager + `git-refs` datasource で `master` の先頭 commit を追える（抽出を確認。今は `COMMIT` が `master` の先頭と同じなので更新は出ない）。`git-refs` は公開日時を持たないので、`minimumReleaseAge` を全体にかけるなら、この依存だけ外す設定が要る |
| GitHub Actions・`node-version`・ランナー | 扱える | `actions/*@v7` などの major タグは次の major（v8）が出たときに更新が出る。`astral-sh/setup-uv@v10.2.0` は 10.3.x を出した。`node-version: 24` は Node のリリースとして 26 への major を出す。`runs-on` の `ubuntu-24.04` は 26.04 への major を出し、`macos-26` は抽出されている（今は最新なので更新なし）。`ubuntu-slim` は抽出されない |
| 同じ版をそろえる（effect 系、Claude SDK、playwright-core） | 扱える（設定が要る） | 同じパッケージ名が複数ファイルにあれば 1 つのブランチに入る。effect 系は既定ではパッケージごとに別ブランチになるので `groupName` で束ねる。テストの期待値など `package.json` 以外に書いた版は custom regex manager で同じ依存として抽出すれば、同じブランチで書き換わる（hosted の無料枠では `postUpgradeTasks` が使えないので、これが代わりになる） |

hosted の無料枠で残る穴は 3 つ。

1. **任意のコマンドを走らせられない。** `postUpgradeTasks` は Mend が許した少数のコマンドだけで、無料枠は追加を頼めない。scripts も走らない。手順で版をそろえる箇所が regex で表せないもの（生成物、ビルドで作るもの）は Renovate の PR では直らない。
2. **Swift の `revision:` 固定は追えない。** タグ指定に移すか、手で追う。
3. **pnpm 12 での lock の再生成は hosted で一度流してみるまで分からない。** 仕組みの上では `packageManager` の版の pnpm を入れて走らせるが、pnpm 12 を名指しした記述は docs に無い。

## 系統ごとの詳細

### 1. pnpm workspace と root の `packageManager`

- npm マネージャは `pnpm-workspace.yaml` を既定で読む（`managerFilePatterns` に `/(^|/)pnpm-workspace\.yaml$/`）。`overrides` と catalog を依存として抽出する。lock の更新は「`npm`・`pnpm`・Yarn のうち lock があるものの CLI に任せる」。`packageManager` は `packageManager` という depType で抽出される。出典: [npm マネージャ](https://docs.renovatebot.com/modules/manager/npm/)。
- pnpm の版の決め方と実行するコマンドは、ソースの `lib/modules/manager/npm/post-update/pnpm.ts`（配布物では `dist/modules/manager/npm/post-update/pnpm.js`）にある。版は「upgrade 中の pnpm の版 → `constraints.pnpm` → `package.json` の `packageManager` → lock の `lockfileVersion`」の順で決まる。`pnpm-workspace.yaml` に `packages` があれば `--recursive` を付け、scripts を許していなければ `--ignore-scripts --ignore-pnpmfile` を付けて `pnpm install --lockfile-only --no-frozen-lockfile` を走らせる。
- したがって `ignoredOptionalDependencies`・`peerDependencyRules` は pnpm 12 自身が読んで lock に反映する。Renovate がこれらを書き換えたり消したりはしない。
- ただし `peerDependencyRules.allowedVersions` の `foldkit>effect: 4.0.6` などは、Renovate から見ると依存ではないので、effect を 4.0.7 に上げても `4.0.6` のまま残る。custom regex manager で `effect`・`@effect/platform-browser` の依存として抽出すれば、effect のグループと同じブランチで書き換わることを確かめた（下の設定例。4 行とも抽出され、effect と同じ `renovate/effect` ブランチに入った）。
- Node の版: repo に `.nvmrc`・`.node-version`・`engines` が無いので、Renovate が lock の再生成に使う Node は Renovate の既定になる。pnpm 12 が要る Node より古いと落ちるので、`engines.node` か `constraints.node` を書いておくのが確実。
- pnpm 12 を名指しした対応表は docs に無い。仕組みの上では `packageManager` の版の pnpm を入れるので動くはずだが、hosted で最初の PR の `renovate/artifacts` が通るかで確かめる。

dry-run で出た更新（`minimumReleaseAge` なし）: effect 系 4.0.6→4.1.1、`@effect/tsgo` 0.56.0→0.63.0、foldkit 0.167.0→0.170.0、`@foldkit/vite-plugin` 0.27.0→0.29.0、fallow 3.33.1→3.38.0、e2e 0.18.0→0.22.0、`pnpm` 12.11.2→12.16.1 など。`pnpm -r outdated` の 22 件と同じものを拾っている。

### 2. workspace 外の npm lock（`server/managed-deps/*`）

- 2 つの `package.json` はそれぞれ別の npm プロジェクトとして抽出された。`@anthropic-ai/claude-agent-sdk` 0.3.288→0.3.316、`playwright-core` 1.63.0→1.64.1、`npm`（`packageManager`）11.19.1→11.21.1 と major 12.2.1。
- `package-lock.json` の再生成は npm の CLI に任せ、版は `packageManager` から決まり、`--package-lock-only --no-audit --ignore-scripts` で走る（`post-update/npm.ts`）。README の手順（`npm install --package-lock-only --ignore-scripts`）と同じ形になる。
- `packageManager` の npm を上げる PR は、README の「現在は `npm@11.19.1`」と確認コマンドの `11.19.1` を置き去りにする。regex manager に入れるか、npm の `packageManager` は自動マージせず手で直す。

### 3. Swift の FluidAudio

- swift マネージャの抽出（`lib/modules/manager/swift/extract.ts`）は、`.package(url:, ...)` の後に `from:`・`exact:`・`.exact(`・文字列の範囲（`"1.0.0"..<"2.0.0"`）だけを読む。`revision:` も `branch:` も無い。datasource は `github-tags`・`gitlab-tags`・`git-tags` で、`pinDigests: false`。出典: [swift マネージャ](https://docs.renovatebot.com/modules/manager/swift/) とソース。
- dry-run では、`revision:` の後の文字列を範囲として拾い、`"ea63ac36…"` を版として読めず `skipReason: invalid-value` で飛ばした。更新は出ない。
- `Package.resolved` は swift マネージャの `artifacts.ts` が、更新先のタグの commit を引いて pin を書き換える。タグ指定にすれば `Package.swift` と `Package.resolved` が同じ PR でそろう。
- 固定している `ea63ac36`（2026-10-07）は、FluidAudio の v0.17.6・v0.17.7・v0.18.0（2026-10-28）に含まれる（GitHub の compare で、v0.17.5 以前には含まれない）。`exact: "0.17.6"` などに移せば Renovate で追える。FluidAudio のタグは `v` 付きなので、SwiftPM と Renovate の両方で読めるかは移すときに確かめる。話者分離の結果に効くので、版を動かすときは `speakerAccuracy` を回す前提になる。

### 4. AEC3 のビルド元（`COMMIT=`）

- custom regex manager で `REPO_URL` と `COMMIT` を 1 つの match で取り、`datasourceTemplate: "git-refs"`・`currentValueTemplate: "master"`・`currentDigest` にすると、`master` の先頭 commit を追う digest 更新になる。出典: [Custom Manager Support using Regex](https://docs.renovatebot.com/modules/manager/regex/)、[git-refs datasource](https://docs.renovatebot.com/modules/datasource/git-refs/)。
- dry-run で `https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git`・`master`・`d0569cfa50` として抽出された。`git ls-remote` で見ると `master` の先頭は今の `COMMIT` と同じなので、更新は出ていない。
- `git-refs` は公開日時を返さない（[Minimum Release Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/) の対応表に無い）。既定の `minimumReleaseAgeBehaviour=timestamp-required` では、`minimumReleaseAge` をかけると更新がずっと保留になる。この依存だけ `minimumReleaseAge: null` にするか `timestamp-optional` にする。
- `master` の先頭を追うので、タグの無い途中の commit に上がる。AEC3 を変えると音の処理が変わるので、自動マージはせず手順（`build-webrtc-apm.sh` と helper のテスト、必要なら評価）に回すのが妥当。

### 5. GitHub Actions・Node・ランナー

- github-actions マネージャは `uses:` の action、`runs-on:` のランナー、`actions/setup-node` の `node-version` などを読む（dry-run の depType は `action`・`github-runner`・`uses-with`）。出典: [github-actions マネージャ](https://docs.renovatebot.com/modules/manager/github-actions/)。
- `actions/checkout@v7`・`actions/cache@v6`・`pnpm/setup@v3` のような major だけのタグは、同じ major の中では更新が出ず、次の major が出たときに major 更新になる。`astral-sh/setup-uv@v10.2.0` は 10.3.x の minor 更新を出した。
- `node-version: 24` は Node 26 への major 更新を出した。`runs-on: ubuntu-24.04` は 26.04 への major。`macos-26` は抽出されたが更新なし。`ubuntu-slim` は版を持たないので抽出されない。
- `pnpm/setup` に版を書いていないので、pnpm の版は root の `packageManager` だけで決まる（`unspecified-version` で飛ばされる）。
- ワークフローを書き換えるには App に Workflows の write 権限が要る（下の権限の表）。

### 6. 同じ版をそろえる仕組み

- Renovate は同じ依存名・同じ更新先を 1 つのブランチにまとめる。dry-run では Claude SDK が managed-deps と server の devDependencies で同じ `renovate/anthropic-ai-claude-agent-sdk-0.x`、playwright-core が `renovate/playwright-monorepo` に入った。
- effect 系は既定（`config:recommended` の `group:monorepos`）では束ならず、`effect`・`@effect/platform-node`・`@effect/platform-browser`・`@effect/vitest` が別々のブランチになった。`packageRules` で `matchPackageNames` + `groupName` を書くと 1 つ（`renovate/effect`）に入った。`@effect/tsgo` は別の repo の別の版なので、束ねるかは別に決める。出典: [`groupName`](https://docs.renovatebot.com/configuration-options/#groupname)。
- テストの期待値（`server/test/checkManagedLock.it.test.ts` の 2 箇所、`server/test/managedClaudeLoad.it.test.ts` の `sdkVersion`）は custom regex manager で `@anthropic-ai/claude-agent-sdk` として抽出し、同じグループに入れると、3 箇所とも `renovate/claude-agent-sdk` ブランチに入った。**`config:recommended` の `ignorePaths` は `**/test/**` を含むので、そのままでは test のファイルを読まない。`ignorePaths` を上書きする必要がある**（上書きしないと抽出されなかった）。
- `postUpgradeTasks`: hosted では「承認された少数のコマンドだけ」で、一覧は公開されず変わりうる（ログの `allowedCommands` で見る）。無料の Community Cloud は追加を頼めない。OSS 枠は GitHub Discussions で頼めるが Mend の裁量。scripts も hosted の無料枠では走らない。出典: [Mend-hosted Apps Configuration](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/)、[Mend-hosted FAQ](https://docs.renovatebot.com/mend-hosted/faq/)、[`ignoreScripts`](https://docs.renovatebot.com/configuration-options/#ignorescripts)、[`postUpgradeTasks`](https://docs.renovatebot.com/configuration-options/#postupgradetasks)。
- したがって代わりは「版を書いた箇所を regex で全部 Renovate の依存にして、グループでそろえる」。regex で表せない後始末が要るもの（effect の `outdatedApi` で落ちるコードの直し、fallow の新しい指摘の直し、Claude SDK の `pnpm test:external`）は、Renovate の PR を自動マージせず、エージェントか人が同じブランチに追いコミットする運用で埋める。

## 公開から待つ・スケジュール・Dashboard・自動マージ

- `minimumReleaseAge`: 版ごとに公開からの時間を待つ。待っている間は `renovate/stability-days` が pending になる。既定の `internalChecksFilter=strict` では、待ち中の版のブランチ・PR は作らず、待ち終わった版があればそれを出す（dry-run で 3 日を入れると effect は 4.1.1 ではなく 4.0.7 の patch を出した）。npm・github-tags・node-version は公開日時がある。git-refs・github-runners は表に無い。docs は Renovate と package manager の両方に設定することを勧めており、manager が package manager 側の値を読む場合は大きい方を使う。lock の再生成で入る推移的な依存には Renovate の待ちがかからないため。出典: [`minimumReleaseAge`](https://docs.renovatebot.com/configuration-options/#minimumreleaseage)、[Minimum Release Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)。
- スケジュール: hosted は有効な repo を 4 時間ごとに回す（無料枠）。`schedule` でブランチを作る時間帯、`automergeSchedule` でマージの時間帯を絞れる。ただし GitHub の auto-merge（`platformAutomerge`）を使うと、PR を作った時点で auto-merge を予約するので `automergeSchedule` は効かない。出典: [Job Scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)、[`automergeSchedule`](https://docs.renovatebot.com/configuration-options/#automergeschedule)。
- Dependency Dashboard: `config:recommended` に入っている。`dependencyDashboardApproval` を major などに付けると、Dashboard でチェックを入れるまで PR を作らない。exact pin で手順の要るもの（effect 系・fallow・Claude SDK・playwright-core）は、PR を作らせて自動マージしないか、Dashboard で承認制にするかを選べる。出典: [`dependencyDashboardApproval`](https://docs.renovatebot.com/configuration-options/#dependencydashboardapproval)。
- 自動マージ: `automerge: true` と既定の `platformAutomerge: true` で、GitHub の auto-merge を使う。この repo は `allow_auto_merge: true`、ruleset「main: CI を必須にする」で `check`（GitHub Actions）を必須にしているので、`check` が通るまでマージされない。docs は「必須の status check を 1 つも選ばずに platform automerge を使うと、落ちた PR がマージされうる」と注意している。`check` は `if: always()` で依存の失敗を拾う作りなので、この条件を満たす。出典: [`automerge`](https://docs.renovatebot.com/configuration-options/#automerge)、[`platformAutomerge`](https://docs.renovatebot.com/configuration-options/#platformautomerge)。
- squash: この repo は merge・squash・rebase のどれも許しているので、`automergeStrategy: "squash"` を明示する。GitHub では platform automerge にも効く。出典: [`automergeStrategy`](https://docs.renovatebot.com/configuration-options/#automergestrategy)。
- `check.yml` は `pull_request` で走り、`server/managed-deps/` を変えた PR では external のテストも走らせる。Renovate のブランチは同じ repo のブランチなので、通常の PR と同じく CI が走る。
- AGENTS.md の「PR 本文に回した検証の段と結果を書く」は、Renovate の PR 本文には入らない。仕組みの仕様で、Renovate の PR を例外にするか、`prBodyNotes` で定型文を入れるかを決める。

## 料金と権限

- 料金: Mend Renovate Community Cloud は無料で、公開・非公開の repo を数の上限なく使える。1 Org あたり同時 1 ジョブ、4 時間ごと、1 vCPU・3GB・ディスク 15GB、30 分で打ち切り。この repo は公開・MIT なので Community (OSS) Cloud（同時 2、6GB、25GB、60 分、Merge Confidence あり）を申請できる。出典: [Mend Renovate Cloud-hosted](https://docs.renovatebot.com/mend-hosted/overview/)。
- 権限（App に渡すもの）: Dependabot alerts・Administration・Metadata は read、Checks・Code（Contents）・Commit statuses・Issues・Pull requests・Workflows は read と write。ユーザー単位で email の read（Developer Portal にログインするとき）。出典: [Security and Permissions](https://docs.renovatebot.com/security-and-permissions/)。
- 「All repositories」で入れると silent（PR も issue も作らない）になる。この repo だけを「Selected repositories」で入れれば onboarding PR が来る。出典: [Mend-hosted Apps Configuration](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/)。
- hosted は自動で `mergeConfidence:all-badges` を `extends` に足す。

## dry-run で確かめた設定例

`--platform=local --dry-run=lookup` で、下の設定が意図どおりに抽出・グループ化することを確かめた（自動マージ・スケジュールは lookup では確かめられないので入れていない）。仕様の土台であって、このまま入れる設定ではない。

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "minimumReleaseAge": "3 days",
  "ignorePaths": ["**/node_modules/**"],
  "packageRules": [
    {
      "matchPackageNames": ["effect", "@effect/platform-node", "@effect/platform-browser", "@effect/vitest"],
      "groupName": "effect"
    },
    { "matchPackageNames": ["@anthropic-ai/claude-agent-sdk"], "groupName": "claude-agent-sdk" },
    { "matchDatasources": ["git-refs"], "minimumReleaseAge": null }
  ],
  "customManagers": [
    {
      "customType": "regex",
      "description": "AEC3 のビルド元 commit",
      "managerFilePatterns": ["/^helper/scripts/build-webrtc-apm\\.sh$/"],
      "matchStrings": ["REPO_URL=\"(?<depName>https://gitlab\\.freedesktop\\.org/[^\"]+)\"\\s[\\s\\S]*?COMMIT=\"(?<currentDigest>[0-9a-f]{40})\""],
      "datasourceTemplate": "git-refs",
      "currentValueTemplate": "master"
    },
    {
      "customType": "regex",
      "description": "Foldkit の peer を effect の版に合わせる",
      "managerFilePatterns": ["/^pnpm-workspace\\.yaml$/"],
      "matchStrings": ["'?(?:foldkit|@foldkit/[a-z-]+)'?>(?<depName>effect|@effect/platform-browser)'?: (?<currentValue>\\d+\\.\\d+\\.\\d+)"],
      "datasourceTemplate": "npm"
    },
    {
      "customType": "regex",
      "description": "テストの期待値に書いた Claude SDK の固定版",
      "managerFilePatterns": ["/^server/test/(checkManagedLock|managedClaudeLoad)\\.it\\.test\\.ts$/"],
      "matchStrings": ["sdkVersion = \"(?<currentValue>\\d+\\.\\d+\\.\\d+)\"", "toBe\\(\"(?<currentValue>0\\.\\d+\\.\\d+)\"\\)"],
      "depNameTemplate": "@anthropic-ai/claude-agent-sdk",
      "datasourceTemplate": "npm"
    }
  ]
}
```

結果: effect 系 4 パッケージ（3 つの `package.json`）と `pnpm-workspace.yaml` の 4 行が `renovate/effect` に、Claude SDK の 2 つの `package.json` とテストの 3 箇所が `renovate/claude-agent-sdk` に入った。

## 確かめていないこと

- hosted の `allowedCommands` の今の中身（hosted のログでしか見えない）。
- pnpm 12.11.2 で hosted が lock を作り直せるか、そのとき Renovate が使う Node の版（lookup の dry-run では artifacts を走らせない）。
- FluidAudio の `v` 付きタグを `exact:` で指定したとき、SwiftPM と Renovate の swift の版の比較が通るか。
- Renovate の PR が `DIRTY` になったときの rebase（Renovate は衝突したブランチを自分で rebase する。`rebaseWhen` の既定）と、AGENTS.md の手でのマージ手順との関係。
