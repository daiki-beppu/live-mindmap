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

Run before a PR: `bash helper/scripts/build-webrtc-apm.sh` (builds the WebRTC AEC3 static library into `helper/.deps/webrtc-apm/`; needs `uv`; a no-op once built; required before the helper's `swift build`/`swift test`, which `pnpm typecheck` and `cd helper && pnpm test` run), `pnpm typecheck`, `pnpm --filter @live-mindmap/server test`, `pnpm --filter @live-mindmap/web test`, `cd helper && pnpm test`. The helper's Swift tests run with Command Line Tools alone (no Xcode); its `test` script passes the testing plugin path. CI (`.github/workflows/check.yml`) runs the same checks split into parallel jobs, chosen by the PR's changed paths: docs-only PRs run none, `helper/` changes add the Swift job, and `server/test/server.test.ts` is split per test across 4 jobs. Before merging, also follow `CODING_STANDARDS.md`. `main` requires the `check` job to pass (ruleset); it is the final job that fails if any other job failed or was cancelled, so keep every new job in its `needs`. Merge with `gh pr merge --squash --auto` instead of waiting on CI; if the PR then shows `DIRTY`, rebase onto `origin/main` and push, or it stays unmerged.

### Recorded sessions

Inspect a saved session (or a folder of them) by counts only, never the remark text: `cd server && node bench/sessionStats.ts <dir>...` prints remarks, duration, overlap and recording loudness per track. Counting `log.jsonl` with `sort | uniq -c` merges `相手` and `自分` under a UTF-8 locale; prefix `LC_ALL=C` when counting by hand.

### Evaluation samples

Synthetic meetings for regression evals and measurements (audio, transcript, truth, how to make new ones) live outside the repo; start from `~/live-mindmap-samples/README.md`.
