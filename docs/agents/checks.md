# Checks: reference

What the commands in `AGENTS.md` → Checks do, how tests are layered, and how CI runs them. Read it when you add or change a test, when a check fails, or when you change CI.

## What each command runs

- `bash helper/scripts/build-webrtc-apm.sh` builds the WebRTC AEC3 static library into `helper/.deps/webrtc-apm/`. It is required before the helper's `swift build --build-tests`, which `pnpm typecheck` and each helper test script run.
- `bash helper/scripts/fetch-speaker-models.sh` fetches the Sortformer speaker-diarization model and the WeSpeaker model (used to detect a slot mixing in a 5th speaker, Issue #1024) into FluidAudio's default cache (`~/Library/Application Support/FluidAudio/Models`) through `live-mindmap-helper install-speaker-models`. A no-op once fetched. The `SortformerSpeakerDiarizerHeavyTests` and `WeSpeakerEmbedderHeavyTests` need it. `run` never fetches them during a session. Without the Sortformer model, `run` emits `speaker-off`. Without the WeSpeaker model, it only turns off the mixing detection and prints one stderr line. CI's helper job restores the cache and fetches before the heavy IT.
- `pnpm typecheck`: the server's also runs `server/scripts/check-*.ts`, which read the source and fail with `path:line` on a violated entrypoint rule or on an `Effect.ignore` that does not name what it gives up (`check-ignored-failures.ts`, over `server/src`, `server/bench` and `web/src`); the web's runs `server/scripts/check-test-layers.ts` too, and both fail when a unit test imports a real resource such as `node:fs`, `node:net`, `ws` or `playwright`.
- The helper's Swift tests run with Command Line Tools alone (no Xcode); its `typecheck` script passes the testing plugin path to the build.

## Test layers

- **Definition of heavy.** The contract the test checks crosses one of these boundaries: a child process, an OS command (tar and jq included), a browser's rendering or events, or native audio and image processing (the OS's models and encoders). OS behaviour across a process boundary counts as past the boundary even when the child is a fake script. What the test sets up with real parts does not decide it; the boundary the contract crosses does.
- **server and web**: set by file suffix. `*.test.ts` is unit, `*.it.test.ts` is a light IT, `*.heavy.test.ts` is a heavy IT (the definition above).
- **helper**: set by the Suite type-name suffix (`…Tests` unit, `…ITTests` light IT, `…HeavyTests` heavy IT (the definition above)); file names carry the same suffix. The helper's `typecheck` runs `scripts/checkTestLayers.ts` (after `build-apm`, before `swift build`), which fails when a unit file (any `.swift` not ending in `ITTests.swift` or `HeavyTests.swift`) contains `WebRTCEchoCanceller(`, `SpeechAnalyzerTranscriber(`, `SortformerSpeakerDiarizer(`, `FileManager.default.temporaryDirectory` or `WebSocketServer(port:`. Each helper script runs `pnpm typecheck` once, then `swift test --skip-build` with a `--skip`/`--filter` on that suffix.
- **Everywhere**: `pnpm test:it:heavy` runs the heavy ITs and `pnpm test:it:all` runs light and heavy in one go, excluding the external tests below.

Tests that fetch real dependencies (`deps:install` or `npm ci`) use `*.external.test.ts` in server. They meet the heavy definition above but run separately in project `external`, excluded from `unit`, `it`, and `heavy`. Run `pnpm test:external` from the repository root or `pnpm --dir server test:external`. Each test keeps its 180-second timeout. CI runs them for PRs that change `server/managed-deps/**`, `server/scripts/install-managed-deps.ts`, or `server/src/managedDeps.ts`, including Markdown under managed-deps, and for every Nightly and Weekly run. Other PRs and pushes to main skip them.

Heavy ITs need the managed Chromium. Install it with `pnpm cli install chromium` (needs the resident server); `LIVE_MINDMAP_DEPS` changes where it goes. Stop a resident server you started with `pnpm cli server stop` (it targets the port in `LIVE_MINDMAP_PORT`), never with `pkill` or another name pattern. Without the server (development, CI), use `pnpm --filter @live-mindmap/server deps:install chromium`. A heavy IT that starts the CLI against the real managed dependencies also needs the managed Claude SDK: `pnpm --filter @live-mindmap/server deps:install claude` (`LIVE_MINDMAP_DEPS` changes where it goes, as for Chromium).

## CI

CI (`.github/workflows/check.yml`) chooses tests from the PR's changed paths in `changes`, then calls `.github/workflows/tests.yml`. That reusable workflow owns the five parallel test-job definitions and their timeouts. The caller retains the PR/main-push triggers, concurrency, and required `check` job. Nightly and Weekly call the same reusable workflow from separate callers.

### 段

段は、結果を決めるもの（コード・外部の取得・キャッシュ）による分類で、テストの層（unit・light・heavy の境界）とは別の軸である。

| テストの性質 | PR | main への push | Nightly | Weekly |
|---|---|---|---|---|
| コードだけで結果が決まる（typecheck・fallow・unit・light IT・heavy IT・e2e の replay） | 全件 | 全件 | 全件 | 全件・キャッシュなし |
| helper（Swift の unit・IT・heavy IT） | helper などのパスに当たるときだけ | 同じくパスで振り分ける | 全件 | 全件・キャッシュなし |
| テスト自身が外部から取得する（本物の `deps:install`・`npm ci`・Playwright の導入） | 管理する依存のパスに当たるときだけ | 走らせない | 走らせる | 走らせる |
| キャッシュで隠れる準備（APM のビルド、話者モデルの取得、管理する Chromium・Claude の導入） | キャッシュを使う | キャッシュを使い、保存する | キャッシュを使う | キャッシュを使わず、保存もしない |

この表は仕様の振り分け規則を示す。現行の `check.yml` は main への push では helper を常時実行する。PR のコード検査は変更パスで選択し、docs-only PR などでは省略する。既存の `check` の選択規則は保持する。

各段の起動条件：

- PR: `check.yml` の `pull_request`。変更パスでジョブを選択する。
- main への push: `check.yml` の `push`（`branches: [main]`）。external 以外を実行する。
- Nightly: `nightly.yml` の `schedule`、毎日18:17 UTC（03:17 JST）、または `workflow_dispatch`。全件を実行し、準備キャッシュは復元するが保存しない。
- Weekly: `weekly.yml` の `schedule`、毎週日曜19:17 UTC（月曜04:17 JST）、または `workflow_dispatch`。Nightly と同じ全件を、準備キャッシュの復元も保存もせずに実行する。

schedule は既定ブランチ（main）の最新コミットを対象とする。両 workflow は必須チェックに追加せず、PR のマージを止めない。Weekly でもコミット済みの E2E replay cache は使い、`--strict-cache` を保持する。

### 共通ジョブとキャッシュ

All six `workflow_call` inputs are required Booleans:

| Input | Controls | PR/main-push caller |
|-------|----------|---------------------|
| `run-ts` | ts, heavy, and e2e | `changes.outputs.ts == 'true'` |
| `run-external` | external | `changes.outputs.external == 'true'` |
| `run-helper` | helper | `changes.outputs.swift == 'true'` |
| `restore-caches` | Preparation-cache restoration | `true` |
| `save-shared-caches` | Playwright, APM, and speaker-model cache saving | `true`, including PRs |
| `save-main-caches` | heavy's managed dependencies and helper's build-cache saving | main push only |

The resulting test selection remains:

- Docs-only PRs skip the ts, heavy, e2e, and helper jobs. Markdown changes under `server/managed-deps/**` still run external. The `changes` job and the required `check` job always run.
- `helper/` changes add the Swift job.
- The `ts` job runs typecheck of server, web and e2e, plus unit and light ITs of server and web, together, then runs fallow last with `--format github-annotations --fail-on-issues` (without the flag, annotations alone exit 0 even with issues).
- The `heavy` job runs every `--project heavy` IT of server and web (a `package` matrix) split per test (grouped by `file:line`) across 1 runner for server and 2 runners for web, with new heavy ITs picked up automatically.
- The `e2e` job (also gated by the `ts` output, so helper-only PRs skip it) runs `pnpm --filter @live-mindmap/e2e test:e2e` (all targets) in one runner: `--strict-cache` replays the committed cache only and `--retries 0` disables the CI default retry, no credentials (`E2E_OAUTH_CREDENTIALS`, `*_API_KEY`, `secrets.*`) are passed, and a step that cannot be replayed (`REPLAY_STALE`, a recorded mismatch) fails the job.
- The `external` job restores the managed Chromium and Claude caches when enabled, runs `deps:install` for both, then runs `pnpm test:external`. Its condition uses the caller's `run-external` input: the `changes` job's `external` output for PR/main push, and `true` for Nightly and Weekly.
- The `heavy`, `external`, and `e2e` jobs install Chromium.

The reusable workflow's `results` job uses `always()` and depends on all five test jobs. It transfers their results as compact JSON through a step output, job output, and workflow output; it does not decide whether the required check passes.

`main` requires the caller's top-level `check` job to pass (ruleset). Its ID, name, and `if: always()` remain unchanged. It checks both its direct dependencies (`changes` and the reusable-workflow call) and all five transferred test results. It accepts only `success` or `skipped`; failure, cancellation, and any unknown result fail it. Missing or malformed test-result output also fails it. Keep new test jobs in the result collector and the caller's result validation.

Cache keys, paths, fallback prefixes, and save timing remain unchanged for PRs and main pushes. heavy restores Chromium and Claude and saves misses before testing on main pushes. external restores those dependencies and never saves them. helper restores its build cache with a prefix fallback and saves misses after testing on main pushes. Playwright, APM, and speaker models retain `actions/cache`'s success-only post saving, including on PRs. For callers that disable shared-cache saving, restoration uses `actions/cache/restore`; with restoration disabled, save-only steps run after successful tests. Disabling restoration still runs the required APM build and model fetch.

actionlint runs as its own workflow (`.github/workflows/actionlint.yml`) on PRs and main pushes that change `.github/**`, so it still reports red when `check.yml` fails to load and no `check` jobs run. It is not a required check.

Job timeouts are about three times the normal p90 duration, rounded up to a multiple of 5 minutes, with a minimum of 5 minutes. The current limits are 5 minutes for `changes`, `check`, `results`, `e2e`, and `actionlint`, 10 minutes for `ts`, `external`, and each `heavy` runner, and 20 minutes for `helper`. The `results` and `actionlint` limits use the minimum because their p90 has not been measured.

External setup, dependency installation, cache restoration, the APM build, and speaker-model downloads each have a 5-minute step timeout. The helper's `swift build --build-tests` has a 10-minute timeout, and each `swift test` step has a 5-minute timeout. The external test step also has a 5-minute timeout. A step timeout does not extend the job timeout.

The `check` workflow uses concurrency group `${{ github.head_ref || github.run_id }}` with `cancel-in-progress: true`. A new push to the same PR cancels its older run. Pushes to `main` use separate run IDs and do not cancel each other. The cancelled run's final `check` still uses `always()` and fails for cancelled dependencies. That failure belongs to the older head SHA, so it does not block merging the new head.

### When main goes red

When the `check` that runs on a push to `main` goes red, the dotfiles guide (案内役) recovers it on its own ([ADR 0026](../adr/0026-verify-main-after-merge-without-strict.md)):

1. It re-runs the failed jobs once.
2. If the re-run fails again, it starts a main-fix session in a worktree cut from `main`. That session opens a fix PR against `main` and reserves its auto-merge.
3. If main-fix cannot fix it, hits its attempt limit, or stops without a result, the guide sends a decision request to Discord.

A person answers the decision request (for example, whether to revert the PR that caused it). When the guide is not running, recover by hand:

1. Re-run the failed jobs once (re-run failed jobs only, one time).
2. If the re-run passes, treat the failure as a flake: open a bug issue and fix-forward. Do not revert.
3. If the re-run fails again, treat it as real breakage: revert the PR that caused it.

`main`'s ruleset does not require a PR to be up to date with `main`, so a reserved PR merges while `main` is red. CI chooses jobs by changed paths, so only a PR that touches the broken path fails; other PRs keep passing.
