# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (daiki-beppu/live-mindmap) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Effect

`server` builds on Effect 4. Read `server/node_modules/effect/AGENTS.md` before writing Effect code: the v4 API names differ from v3 (`Effect.catch`, not `Effect.catchAll`), and that file is the installed version's own reference. `server`'s `typecheck` runs `effect-tsgo diagnostics --project tsconfig.json` after the two `tsc` passes, and `web`'s after its `tsc`; the `outdatedApi` rule is set to `error` in both `server/tsconfig.json` and `web/tsconfig.json`, so v3 APIs fail the check. `unstableApiUsage` is `off` in both; `web` sets it only to match `server`, which needs it because `effect/process`, `effect/http`, `effect/socket` and `effect/cli` are `@stability unstable` and we use them on purpose (ADR 0008, 0009, 0010); `effect` and `@effect/*` are therefore exact-pinned, and upgrading them means checking those modules for changes.

`web` builds on Effect 4 through Foldkit; read `web/AGENTS.md` before writing Foldkit code.

### README

`README.ja.md` is the source of truth for `できること` and detailed setup instructions. The corresponding English sections in `README.md` contain one-line summaries and links to `README.ja.md#<見出し>`.

- When a PR adds, removes or changes what a user can do, including a takt PR, update `README.ja.md`'s `できること` in the same PR.
- Update `README.md`'s `What you can do` in the same PR only when an item is added or removed, or its one-line summary changes. Changes to details such as flags, defaults or limits need only the Japanese update.
- When requirements (such as the macOS version) or setup commands change, update both the relevant section in `README.ja.md` and `README.md`'s `Getting started` in the same PR.
- When a Japanese heading changes the target of an English link (`#できること`, `#差分更新のモデルを選ぶ`, `#claude-の認証`, `#ローカルモード`, `#ライブのセッション`), update the English anchor in the same PR.
- Plans and progress live in issues. Both `README.ja.md`'s `ロードマップ` and `README.md`'s `Roadmap` only link to issues.
- Do not add CI checks or tests for README synchronization. See `CODING_STANDARDS.md` → `Contracts, not structure`.

### Checks

CI は PR・main push・Nightly・Weekly の段に分かれる。Nightly・Weekly が落ちたら [定期段が落ちたとき](docs/agents/checks.md#定期段が落ちたとき) を読む。

SDK または `playwright-core` の固定版を更新するときは、[Claude の更新手順](server/managed-deps/claude/README.md) または [Chromium の更新手順](server/managed-deps/chromium/README.md) を読む。

Run before a PR, from the repo root (inside `server/` or `web/`, `pnpm typecheck` skips fallow, and CI fails on it): `bash helper/scripts/build-webrtc-apm.sh` (needs `uv`; a no-op once built), `bash helper/scripts/fetch-speaker-models.sh` (fetches the speaker-diarization models once, needs network on the first run; a no-op once fetched; the helper never fetches them during a session), `pnpm typecheck` (ends with the root `pnpm fallow`: `.fallowrc.json`, 未使用・重複・複雑度。1 件でも落ちる), `pnpm test` while implementing (unit tests of server, web and helper), `pnpm test:it` when done (light integration tests of all three). Run heavy ITs you added or changed by file, e.g. `pnpm --filter @live-mindmap/server exec vitest run test/foo.heavy.test.ts`, and leave the full set to CI. State the layers you ran and their results in the PR body. Before merging, also follow `CODING_STANDARDS.md`. Merge with `gh pr merge --squash --auto` instead of waiting on CI; if the PR then shows `DIRTY`, rebase onto `origin/main` and push; it stays unmerged until you do. A `BEHIND` PR merges once the required `check` passes (ADR 0026).

When fallow fails, the default fix is to rewrite the code; suppress only as `CODING_STANDARDS.md` → Suppressions allows. CI's `ts` job runs fallow last, with `github-annotations` output and `--fail-on-issues`.

`fallow` is exact-pinned in the root `package.json`, because a new release can add checks or change defaults and turn a green `main` red. To bump it, read the changelog for new checks and changed defaults, fix every newly reported issue in the same PR, and don't add suppressions in bulk to a PR that only raises the version.

Read [`docs/agents/checks.md`](docs/agents/checks.md) (what each command runs, test layers, CI jobs) when you add or change a test, when a check fails, or when you change CI. When you add a test, also read the Tests section of `CODING_STANDARDS.md`.

### Rules and what enforces them

Reviewers keep catching these. When a rule here is broken again, add the check that stops it, not more prose. Rows marked "review only" have nothing that fails yet.

| Rule | Enforced by |
|---|---|
| Use Effect 4 APIs, not v3 names | `effect-tsgo` `outdatedApi` in `server`'s and `web`'s `pnpm typecheck` |
| No unused exports, duplicated blocks or over-complex functions | `pnpm fallow` (end of `pnpm typecheck`, CI `ts` job) |
| `runMain`・`runSync`・`runPromise` only at the entrypoints | `server/scripts/check-entrypoints.ts` |
| Unit tests don't open real resources | `server/scripts/check-test-layers.ts` |
| helper の ITTests suite は1分、HeavyTests suite は2分の `.timeLimit` を付ける | helper の `typecheck` で走る `helper/scripts/checkTestLayers.ts` が `.timeLimit` の欠落を検出 |
| Don't drop a failure silently: return it, or `Effect.ignore({ log, message })` naming what is given up; cleanup goes in `ensuring`・`onExit`・`acquireRelease` so it also runs on interruption | `server/scripts/check-ignored-failures.ts` (catches `Effect.ignore`; a swallowing `Effect.catch` or `FiberSet.awaitEmpty` is review only) |
| The PR body states the check layers run and their results, and every deliverable the issue asks for (Closes, before/after, screenshots) | review only |
| Tests check contracts through the public entry point, not internal structure or current behaviour; waits use a deadline on the real condition | review only (`CODING_STANDARDS.md` → Tests) |
| State tied to a session, attempt or input is reset or re-read when that owner changes | review only |

### Evals

Evals measure real model and speech-recognition output by hand. They are not part of Checks and give no pass/fail. Run the one that matches what you changed:

- `cli eval`: the diff-update prompt, model, or flow.
- `mapShape`・`edgeJudge`・`siblingJudge`: 差分更新のプロンプトを変えたら、形と意味の物差しとして回す。
- `sttAccuracy`: the recognition engine, language, or vocabulary hints.
- `sttLatency`: how finals are handled, or how the helper feeds recognition.
- `speakerAccuracy`: the speaker-diarization model, the rules that attribute remarks to speakers, or their reference values.
- `peopleAccuracy`: prompts or rules for inferred speaker names, proposers, or assignees.
- `bash scripts/measure-bootstrap.sh [commit]`（既定 `HEAD`）: 初回の時間に効く `helper/Package.swift`・`helper/Package.resolved` の依存追加・更新や製品の増減、`scripts/bootstrap.sh`・`helper/scripts/build-webrtc-apm.sh`・`helper/scripts/fetch-speaker-models.sh`、server の dev の helper ビルド、README の初回準備手順を変えたら実行する。main とブランチを同じ時間帯に続けて測り、PR 本文に before/after の表を書く。ビルド140秒・初回240秒の目標を揺れ（±20%）より大きく超えたら、その PR で直すか issue を立てる。時間による合否は出さず、CI では監視しない。

CI does not enforce them; agents may run them too. Record the result in the PR body as a before/after table taken on the same samples. There is no baseline value. Procedures, which samples each one takes, and input/output shapes are in `server/bench/README.md`. The samples (synthetic meetings: audio, transcript, truth, how to make new ones) live outside the repo; start from `~/live-mindmap-samples/README.md`.

E2E (`e2e/`, not part of `pnpm test`/`pnpm typecheck`): when you change a seam the meeting smoke crosses (server routes, the CLI, the web screen, the helper protocol, the export), run `pnpm --filter @live-mindmap/e2e test:e2e:smoke`. When it stops with `REPLAY_STALE`, or when you change a step's test name, target name, `agent.act` instruction or params, re-record on the spot as `e2e/README.md` describes and include the updated `e2e/.e2e/cache/` in the same commit.

### Recorded sessions

Inspect a saved session (or a folder of them) by counts only, never the remark text: `cd server && node bench/sessionStats.ts <dir>...` prints remarks, duration, overlap and recording loudness per track. Counting `log.jsonl` with `sort | uniq -c` merges `相手` and `自分` under a UTF-8 locale; prefix `LC_ALL=C` when counting by hand.
