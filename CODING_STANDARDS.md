# Coding standards

Read during review and before merging, not during implementation. Mechanical rules live in the checks (`AGENTS.md` → Checks); this file holds the judgement calls.

## Deferred findings

When a review defers a finding as "unverified" and it hinges on an external SDK or API's behaviour (a limit, a retry, what an option counts), settle it before merging with the smallest real call that exercises it, and record the result in the PR. Example: #87 kept `maxTurns: 4` on a reused Agent SDK `query()`; seven real calls showed the limit is per message, not cumulative.

## Negative tests

A test that asserts something does *not* happen (not sent, not opened, not closed) passes when nothing happens at all. Check it first reaches the state it guards: removing the guarded line must turn it red. Examples: #36 (a held remark after cancellation), #87 (closing an updater opened before a start failure).
