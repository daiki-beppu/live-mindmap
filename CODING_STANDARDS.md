# Coding standards

Read during review and before merging, not during implementation. Mechanical rules live in the checks (`AGENTS.md` → Checks); this file holds the judgement calls.

## Deferred findings

When a review defers a finding as "unverified" and it hinges on an external SDK or API's behaviour (a limit, a retry, what an option counts), settle it before merging with the smallest real call that exercises it, and record the result in the PR. Example: #87 kept `maxTurns: 4` on a reused Agent SDK `query()`; seven real calls showed the limit is per message, not cumulative.

## Negative tests

A test that asserts something does *not* happen (not sent, not opened, not closed) passes when nothing happens at all. Check it first reaches the state it guards: removing the guarded line must turn it red. Examples: #36 (a held remark after cancellation), #87 (closing an updater opened before a start failure).

## Effect: what to wrap, what to fail, what to throw

`server` and `web` both build on Effect 4, but not every function should return an `Effect`. Sort each function and each failure into one of three:

- **Plain function.** No failure, no waiting, no dependency: return the value and don't wrap it in `Effect` (e.g. `applyOps`, `groupSize`, `toDrawnix`). Its tests pass values in and read values out.
- **Typed failure.** Something from outside our code is broken: a helper event, a log or truth file read from disk, model output, user arguments, another process holding a lock. Return `Effect<A, TaggedError>`, even when the function is otherwise pure and synchronous; don't use `Result` for this, so callers read every failure the same way with `yield*` (precedent: `restoreState` with `InvalidLogEvent`).
- **Defect.** Our own code broke a promise it made to itself: the bundled template has no `</body>`, JSON we embedded ourselves doesn't parse, a caller passes an id that isn't in the tree. `throw`, `!` or `Effect.die` are fine; don't add a typed error for it.

This follows [ADR 0007](docs/adr/0007-core-session-on-effect.md) for `server/src/core/` and Effect's own split between [expected errors](https://effect.website/docs/v4/error-management/two-error-types) and [defects](https://effect.website/docs/v4/error-management/unexpected-errors). A `throw` inside a synchronous helper is fine when its caller already turns it into a typed failure with `Effect.try` (e.g. `managedDeps.ts`). In `web`, follow `web/AGENTS.md` for how Foldkit code is shaped. Example: #951 (`logMetrics` threw on a broken log; it is a typed failure).

## Tests

Unlike the rest of this file, read this section when you add a test. Layer names and file suffixes live in [`docs/agents/checks.md`](docs/agents/checks.md), and when each layer runs in `AGENTS.md` → Checks; this section does not repeat them. For tests that assert something does not happen, see Negative tests above.

- **Evidence gate.** Add a test only if you can show all five: the obligation to add it; the contract it checks, taken from its source of truth (issue, spec, public interface — not the current code); how it fails on a real path; why no existing test already catches that failure; and the smallest layer that holds the contract. If any one is missing, don't add it. Source: takt's [`testing.md`](https://github.com/nrslib/takt/blob/main/builtins/ja/facets/policies/testing.md) (not copied here).
- **Contracts, not structure.** Don't turn internal structure or assets that never run into a contract: line counts, source wording, imports, where a file lives, README prose. CLI output and protocol values are contracts and may be checked by exact match.
- **Layers.** A layer is set by the real dependency boundaries the test actually crosses. Put each test in the smallest layer that holds its contract, and don't check the same failure again in another layer.
- **Waiting helpers.** A helper that waits for a condition runs against a wall-clock deadline and throws on timeout, naming the condition it waited for. Polling a fixed number of times and then returning lets the test pass on a fast machine and fail only under CI load: #668's `waitForDiffState` polled 200 times, returned silently, and passed takt review.
- **Fakes.** Shape fakes as decided in [#446](https://github.com/daiki-beppu/live-mindmap/issues/446).
- **E2E.** Judge only with locator `expect`; the procedure is in `e2e/README.md`.
- **Evals.** Evals are not a test layer (`AGENTS.md` → Evals); the deterministic parts of eval tooling are ordinary tests and sit in a layer like any other.
- **Existing tests.** This applies to new tests. Don't sweep existing tests that pin internal structure in one go.

## Suppressions

Unlike the rest of this file, read this section when you add a suppression (`fallow-ignore-next-line`, `@expected-unused`), not only in review.

- **Principle.** A suppression records a decision not to share code or to keep a shape as it is. It is not a way to clear a finding. The default fix is to rewrite.
- **When it is allowed.**
  - `code-duplication`: sharing would tie together two things that change separately (different protocol boundaries, or old and new side by side during a migration).
  - Complexity: splitting would make it harder to read, as with an exhaustive `match` or a branch table whose value is being flat.
  - `@expected-unused`: only an export whose use already has an open ticket. Put the issue number in the reason.
- **Reason.** Write what gets worse if the code is rewritten. "False positive" and "fix later" are not reasons. Remove a false positive in `.fallowrc.json`, not with a suppression, and state why in the PR body.
- **Review.** Check each `fallow-ignore-next-line` and `@expected-unused` added in the diff one by one against the cases above. If the reason does not fit, ask for a rewrite.
