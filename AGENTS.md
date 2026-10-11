# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (daiki-beppu/live-mindmap) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Effect

`server` builds on Effect 4. Read `server/node_modules/effect/AGENTS.md` before writing Effect code: the v4 API names differ from v3 (`Effect.catch`, not `Effect.catchAll`), and that file is the installed version's own reference. `server`'s `typecheck` runs `effect-tsgo diagnostics --project tsconfig.json` after the two `tsc` passes; its `outdatedApi` rule is set to `error` in `server/tsconfig.json`, so v3 APIs fail the check. `unstableApiUsage` is `off` there because `effect/process`, `effect/http`, `effect/socket` and `effect/cli` are `@stability unstable` and we use them on purpose (ADR 0008, 0009, 0010); `effect` and `@effect/*` are therefore exact-pinned, and upgrading them means checking those modules for changes.

### Checks

heavy IT の前に `pnpm cli install chromium` で管理 Chromium を導入する（常駐サーバーが必要）。置き場所は `LIVE_MINDMAP_DEPS` で変えられる。サーバーなしの開発・CI 用入口は `pnpm --filter @live-mindmap/server deps:install chromium`。

Run before a PR: `bash helper/scripts/build-webrtc-apm.sh` (builds the WebRTC AEC3 static library into `helper/.deps/webrtc-apm/`; needs `uv`; a no-op once built; required before the helper's `swift build --build-tests`, which `pnpm typecheck` and each helper test script run), `pnpm typecheck` (the server's also runs `server/scripts/check-*.ts`, which read the source and fail with `path:line` on a violated entrypoint rule; the web's runs `server/scripts/check-test-layers.ts` too, and both fail when a unit test imports a real resource such as `node:fs`, `node:net`, `ws` or `playwright`), `pnpm test` while implementing (unit tests of server, web and helper), `pnpm test:it` when done (light integration tests of all three). Test layers: in server and web they are set by file suffix: `*.test.ts` is unit, `*.it.test.ts` is a light IT, `*.heavy.test.ts` is a heavy IT. In the helper they are set by the Suite type-name suffix (`…Tests` unit, `…ITTests` light IT, `…HeavyTests` heavy IT with real AEC3 / SpeechAnalyzer; file names carry the same suffix); the helper's `typecheck` runs `scripts/checkTestLayers.ts` (after `build-apm`, before `swift build`), which fails when a unit file (any `.swift` not ending in `ITTests.swift` or `HeavyTests.swift`) contains `WebRTCEchoCanceller(`, `SpeechAnalyzerTranscriber(`, `FileManager.default.temporaryDirectory` or `WebSocketServer(port:`; each helper script runs `pnpm typecheck` once, then `swift test --skip-build` with a `--skip`/`--filter` on that suffix. Everywhere, `pnpm test:it:heavy` runs the heavy ITs and `pnpm test:it:all` runs light and heavy in one go. Run heavy ITs you added or changed by file, e.g. `pnpm --filter @live-mindmap/server exec vitest run test/foo.heavy.test.ts`, and leave the full set to CI. State the layers you ran and their results in the PR body. The helper's Swift tests run with Command Line Tools alone (no Xcode); its `typecheck` script passes the testing plugin path to the build. CI (`.github/workflows/check.yml`) runs the same checks split into parallel jobs, chosen by the PR's changed paths: docs-only PRs skip every test job (the `changes` job and the required `check` job still run), `helper/` changes add the Swift job, the `ts` job runs typecheck, unit and light ITs of server and web together, and the `heavy` job runs every `--project heavy` IT split per test (grouped by `file:line`) across 4 runners, with new heavy ITs picked up automatically. The `e2e` job (also gated by the `ts` output, so helper-only PRs skip it) runs `pnpm --filter @live-mindmap/e2e test:e2e` (all targets) in one runner: `--strict-cache` replays the committed cache only and `--retries 0` disables the CI default retry, no credentials (`E2E_OAUTH_CREDENTIALS`, `*_API_KEY`, `secrets.*`) are passed, and a step that cannot be replayed (`REPLAY_STALE`, a recorded mismatch) fails the job. Only the `heavy` and `e2e` jobs install Chromium. Before merging, also follow `CODING_STANDARDS.md`. `main` requires the `check` job to pass (ruleset); it is the final job and passes only if every job in its `needs` ended `success` or `skipped` (any other result, such as `failure`, `cancelled`, or a job no runner picked up, fails it), so keep every new job in its `needs`. Merge with `gh pr merge --squash --auto` instead of waiting on CI; if the PR then shows `DIRTY`, rebase onto `origin/main` and push, or it stays unmerged.

When you add a test, read the Tests section of `CODING_STANDARDS.md`.

### Evals

Evals measure real model and speech-recognition output by hand. They are not part of Checks and give no pass/fail. Run the one that matches what you changed:

- `cli eval`: the diff-update prompt, model, or flow.
- `sttAccuracy`: the recognition engine, language, or vocabulary hints.
- `sttLatency`: how finals are handled, or how the helper feeds recognition.

CI does not enforce them; agents may run them too. Record the result in the PR body as a before/after table taken on the same samples. There is no baseline value. Procedures and input/output shapes are in `server/bench/README.md`. The samples (synthetic meetings: audio, transcript, truth, how to make new ones) live outside the repo; start from `~/live-mindmap-samples/README.md`.

E2E (`e2e/`, not part of `pnpm test`/`pnpm typecheck`): when you change a seam the meeting smoke crosses (server routes, the CLI, the web screen, the helper protocol, the export), run `pnpm --filter @live-mindmap/e2e test:e2e:smoke`. It replays the committed cache with `--strict-cache`; steps whose record matches call no model. A step that can no longer be replayed stops with `REPLAY_STALE`, and a step whose test name, target name, `agent.act` instruction or params changed calls the model even under `--strict-cache` (no `REPLAY_STALE`). In either case, and when you change those names or instructions, re-record on the spot as `e2e/README.md` describes and include the updated `e2e/.e2e/cache/` in the same commit.

### Recorded sessions

Inspect a saved session (or a folder of them) by counts only, never the remark text: `cd server && node bench/sessionStats.ts <dir>...` prints remarks, duration, overlap and recording loudness per track. Counting `log.jsonl` with `sort | uniq -c` merges `相手` and `自分` under a UTF-8 locale; prefix `LC_ALL=C` when counting by hand.
