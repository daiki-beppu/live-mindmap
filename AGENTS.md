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

`web` builds on Effect 4 through Foldkit; read `web/AGENTS.md` before writing Foldkit code.

### README

When a PR adds, removes or changes what a user can do, update README's `できること` in the same PR. Plans and progress live in issues; README's `ロードマップ` only links to them.

### Checks

SDK または `playwright-core` の固定版を更新するときは、[Claude の更新手順](server/managed-deps/claude/README.md) または [Chromium の更新手順](server/managed-deps/chromium/README.md) を読む。

Run before a PR, from the repo root (inside `server/` or `web/`, `pnpm typecheck` skips fallow, and CI fails on it): `bash helper/scripts/build-webrtc-apm.sh` (needs `uv`; a no-op once built), `bash helper/scripts/fetch-speaker-models.sh` (fetches the speaker-diarization models once, needs network on the first run; a no-op once fetched; the helper never fetches them during a session), `pnpm typecheck` (ends with the root `pnpm fallow`: `.fallowrc.json`, 未使用・重複・複雑度。1 件でも落ちる), `pnpm test` while implementing (unit tests of server, web and helper), `pnpm test:it` when done (light integration tests of all three). Run heavy ITs you added or changed by file, e.g. `pnpm --filter @live-mindmap/server exec vitest run test/foo.heavy.test.ts`, and leave the full set to CI. State the layers you ran and their results in the PR body. Before merging, also follow `CODING_STANDARDS.md`. Merge with `gh pr merge --squash --auto` instead of waiting on CI; if the PR then shows `DIRTY`, rebase onto `origin/main` and push; if it shows `BEHIND`, the takt skill's `align-behind.mjs` updates reserved PRs one at a time when it is running (ADR 0022); otherwise run `gh pr update-branch <PR>` (the `main` ruleset requires an up-to-date branch, and GitHub does not update it for you). Either way it stays unmerged until you do.

When fallow fails, the default fix is to rewrite the code; suppress only as `CODING_STANDARDS.md` → Suppressions allows. CI's `ts` job runs fallow last, with `github-annotations` output and `--fail-on-issues`.

`fallow` is exact-pinned in the root `package.json`, because a new release can add checks or change defaults and turn a green `main` red. To bump it, read the changelog for new checks and changed defaults, fix every newly reported issue in the same PR, and don't add suppressions in bulk to a PR that only raises the version.

Read [`docs/agents/checks.md`](docs/agents/checks.md) (what each command runs, test layers, CI jobs) when you add or change a test, when a check fails, or when you change CI. When you add a test, also read the Tests section of `CODING_STANDARDS.md`.

### Evals

Evals measure real model and speech-recognition output by hand. They are not part of Checks and give no pass/fail. Run the one that matches what you changed:

- `cli eval`: the diff-update prompt, model, or flow.
- `mapShape`・`edgeJudge`・`siblingJudge`: 差分更新のプロンプトを変えたら、形と意味の物差しとして回す。
- `sttAccuracy`: the recognition engine, language, or vocabulary hints.
- `sttLatency`: how finals are handled, or how the helper feeds recognition.
- `speakerAccuracy`: the speaker-diarization model, the rules that attribute remarks to speakers, or their reference values.

CI does not enforce them; agents may run them too. Record the result in the PR body as a before/after table taken on the same samples. There is no baseline value. Procedures, which samples each one takes, and input/output shapes are in `server/bench/README.md`. The samples (synthetic meetings: audio, transcript, truth, how to make new ones) live outside the repo; start from `~/live-mindmap-samples/README.md`.

E2E (`e2e/`, not part of `pnpm test`/`pnpm typecheck`): when you change a seam the meeting smoke crosses (server routes, the CLI, the web screen, the helper protocol, the export), run `pnpm --filter @live-mindmap/e2e test:e2e:smoke`. When it stops with `REPLAY_STALE`, or when you change a step's test name, target name, `agent.act` instruction or params, re-record on the spot as `e2e/README.md` describes and include the updated `e2e/.e2e/cache/` in the same commit.

### Recorded sessions

Inspect a saved session (or a folder of them) by counts only, never the remark text: `cd server && node bench/sessionStats.ts <dir>...` prints remarks, duration, overlap and recording loudness per track. Counting `log.jsonl` with `sort | uniq -c` merges `相手` and `自分` under a UTF-8 locale; prefix `LC_ALL=C` when counting by hand.
