# Coding standards

Read during review and before merging, not during implementation. Mechanical rules live in the checks (`AGENTS.md` → Checks); this file holds the judgement calls.

## Deferred findings

When a review defers a finding as "unverified" and it hinges on an external SDK or API's behaviour (a limit, a retry, what an option counts), settle it before merging with the smallest real call that exercises it, and record the result in the PR. Example: #87 kept `maxTurns: 4` on a reused Agent SDK `query()`; seven real calls showed the limit is per message, not cumulative.

## Negative tests

A test that asserts something does *not* happen (not sent, not opened, not closed) passes when nothing happens at all. Check it first reaches the state it guards: removing the guarded line must turn it red. Examples: #36 (a held remark after cancellation), #87 (closing an updater opened before a start failure).

## Tests

Unlike the rest of this file, read this section when you add a test. Layer names, file suffixes and when each layer runs live in `AGENTS.md` → Checks; this section does not repeat them. For tests that assert something does not happen, see Negative tests above.

- **Evidence gate.** Add a test only if you can show all five: the obligation to add it; the contract it checks, taken from its source of truth (issue, spec, public interface — not the current code); how it fails on a real path; why no existing test already catches that failure; and the smallest layer that holds the contract. If any one is missing, don't add it. Source: takt's [`testing.md`](https://github.com/nrslib/takt/blob/main/builtins/ja/facets/policies/testing.md) (not copied here).
- **Contracts, not structure.** Don't turn internal structure or assets that never run into a contract: line counts, source wording, imports, where a file lives, README prose. CLI output and protocol values are contracts and may be checked by exact match.
- **Layers.** A layer is set by the real dependency boundaries the test actually crosses. Put each test in the smallest layer that holds its contract, and don't check the same failure again in another layer.
- **Fakes.** Shape fakes as decided in [#446](https://github.com/daiki-beppu/live-mindmap/issues/446).
- **E2E.** Judge only with locator `expect`; the procedure is in `e2e/README.md`.
- **Evals.** Evals are not a test layer (`AGENTS.md` → Evals); the deterministic parts of eval tooling are ordinary tests and sit in a layer like any other.
- **Existing tests.** This applies to new tests. Don't sweep existing tests that pin internal structure in one go.
