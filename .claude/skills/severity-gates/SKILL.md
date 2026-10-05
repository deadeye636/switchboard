---
name: severity-gates
description: Severity classification and merge-blocker gates for code reviews, verifier gaps, architecture evaluations, and security audits. Trigger - "/severity-gates", "severity gates", "audit severity", "finding classification".
---

# Severity gates

Every finding from a review, a verifier run, or an audit gets one of four severities.

| Severity | Meaning | Action |
| :--- | :--- | :--- |
| **`critical`** | Data loss, memory corruption, remote code execution, auth bypass, irreversible file damage, leaked secrets or local paths. | Blocks the merge. Fix before anything else proceeds. |
| **`high`** | Likely functional regression, broken backend decoding, a race in file watching, a deadlock in a native module. | Blocks the merge. Fix and verify within the current plan. |
| **`medium`** | Measurable slowdown (e.g. event-loop stalls over 50 ms), memory growth, an unindexed query, missing tests on edge cases. | Fix in this session if the scope allows; otherwise open a tracked issue before the merge. |
| **`low`** | Cosmetic misalignment, naming drift, small documentation gaps, style drift. | Note it; fix during regular work. |

## Merge gates

A branch or finished feature does not pass verification while any of these holds. Items 2 and 4 are
checked by `npm test`; items 1 and 3 by whoever reviews.

1. An open finding is `critical` or `high`.
2. `test/no-local-paths.test.js` fails.
3. `npm test` has a failing or flaky test.
4. A migration breaks the append-only rule (`.claude/rules/db.md`).
