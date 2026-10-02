# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (daiki-beppu/live-mindmap) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Checks

Run before a PR: `pnpm typecheck`, `pnpm --filter @live-mindmap/server test`, `pnpm --filter @live-mindmap/web test`, `cd helper && pnpm test`. The helper's Swift tests run with Command Line Tools alone (no Xcode); its `test` script passes the testing plugin path. CI runs the same in `.github/workflows/check.yml`. Before merging, also follow `CODING_STANDARDS.md`.
