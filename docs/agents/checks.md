# Checks: reference

What the commands in `AGENTS.md` → Checks do, how tests are layered, and how CI runs them. Read it when you add or change a test, when a check fails, or when you change CI.

## What each command runs

- `bash helper/scripts/build-webrtc-apm.sh` builds the WebRTC AEC3 static library into `helper/.deps/webrtc-apm/`. It is required before the helper's `swift build --build-tests`, which `pnpm typecheck` and each helper test script run.
- `bash helper/scripts/fetch-speaker-models.sh` fetches the Sortformer speaker-diarization model into FluidAudio's default cache (`~/Library/Application Support/FluidAudio/Models`) through `live-mindmap-helper install-speaker-models`. A no-op once fetched. The `SortformerSpeakerDiarizerHeavyTests` need it; `run` never fetches it during a session and emits `speaker-off` when it is missing. CI's helper job restores the cache and fetches before the heavy IT.
- `pnpm typecheck`: the server's also runs `server/scripts/check-*.ts`, which read the source and fail with `path:line` on a violated entrypoint rule; the web's runs `server/scripts/check-test-layers.ts` too, and both fail when a unit test imports a real resource such as `node:fs`, `node:net`, `ws` or `playwright`.
- The helper's Swift tests run with Command Line Tools alone (no Xcode); its `typecheck` script passes the testing plugin path to the build.

## Test layers

- **server and web**: set by file suffix. `*.test.ts` is unit, `*.it.test.ts` is a light IT, `*.heavy.test.ts` is a heavy IT.
- **helper**: set by the Suite type-name suffix (`…Tests` unit, `…ITTests` light IT, `…HeavyTests` heavy IT with real AEC3 / SpeechAnalyzer / Sortformer); file names carry the same suffix. The helper's `typecheck` runs `scripts/checkTestLayers.ts` (after `build-apm`, before `swift build`), which fails when a unit file (any `.swift` not ending in `ITTests.swift` or `HeavyTests.swift`) contains `WebRTCEchoCanceller(`, `SpeechAnalyzerTranscriber(`, `SortformerSpeakerDiarizer(`, `FileManager.default.temporaryDirectory` or `WebSocketServer(port:`. Each helper script runs `pnpm typecheck` once, then `swift test --skip-build` with a `--skip`/`--filter` on that suffix.
- **Everywhere**: `pnpm test:it:heavy` runs the heavy ITs and `pnpm test:it:all` runs light and heavy in one go.

Heavy ITs need the managed Chromium. Install it with `pnpm cli install chromium` (needs the resident server); `LIVE_MINDMAP_DEPS` changes where it goes. Stop a resident server you started with `pnpm cli server stop` (it targets the port in `LIVE_MINDMAP_PORT`), never with `pkill` or another name pattern. Without the server (development, CI), use `pnpm --filter @live-mindmap/server deps:install chromium`. They also need the managed Claude SDK: `pnpm --filter @live-mindmap/server deps:install claude`, which also installs into `LIVE_MINDMAP_DEPS` when it is set.

## CI

CI (`.github/workflows/check.yml`) runs the same checks split into parallel jobs, chosen by the PR's changed paths:

- Docs-only PRs skip every test job (the `changes` job and the required `check` job still run).
- `helper/` changes add the Swift job.
- The `ts` job runs typecheck of server, web and e2e, plus unit and light ITs of server and web, together, then runs fallow last with `--format github-annotations --fail-on-issues` (without the flag, annotations alone exit 0 even with issues).
- The `heavy` job runs every `--project heavy` IT of server and web (a `package` matrix) split per test (grouped by `file:line`) across 4 runners each, with new heavy ITs picked up automatically.
- The `e2e` job (also gated by the `ts` output, so helper-only PRs skip it) runs `pnpm --filter @live-mindmap/e2e test:e2e` (all targets) in one runner: `--strict-cache` replays the committed cache only and `--retries 0` disables the CI default retry, no credentials (`E2E_OAUTH_CREDENTIALS`, `*_API_KEY`, `secrets.*`) are passed, and a step that cannot be replayed (`REPLAY_STALE`, a recorded mismatch) fails the job.
- Only the `heavy` and `e2e` jobs install Chromium.

`main` requires the `check` job to pass (ruleset). It is the final job and passes only if every job in its `needs` ended `success` or `skipped` (any other result, such as `failure`, `cancelled`, or a job no runner picked up, fails it), so keep every new job in its `needs`.

actionlint runs as its own workflow (`.github/workflows/actionlint.yml`) on PRs and main pushes that change `.github/**`, so it still reports red when `check.yml` fails to load and no `check` jobs run. It is not a required check.
