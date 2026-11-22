# How an AI usage unit is settled

Every model execution reserves one unit first (`UsageService.reserve`) and is settled exactly
once.

| What happened | Unit |
|---|---|
| No provider call was made (validation, plan, quota, verification refusal; request cancelled before the first model call) | refunded |
| The provider failed (error, timeout) | refunded |
| Output reached the client (first stream chunk, or the completed result) | charged |
| The process died: lease expired | charged if delivery was recorded, otherwise refunded |
| **The provider did the work, but nothing usable was delivered** — the client hung up mid-review or before the first chunk, every review batch failed after calls were made, or the output could not be parsed | **budgeted refund** |

## Budgeted refunds

The last row used to be an unconditional refund, which made provider spend free and unlimited:
start an Entire PR review, disconnect before the end, repeat. Charging it unconditionally would
bill honest users for network drops and model hiccups.

Each user gets `PROVIDER_WORK_REFUNDS_PER_PERIOD` (5) such refunds per workspace per usage period (the same calendar month as the quota). Past
that, the unit is charged. The budget is a counter row updated with one conditional statement
(the same mechanism as the quota), so it holds under concurrency and across instances. It is
not shown with the plan usage.

CI failure analysis additionally has a request rate limit and a minimum output budget (a
truncated JSON object would otherwise be an unusable result every time).
