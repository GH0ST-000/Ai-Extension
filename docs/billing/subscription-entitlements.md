# Subscription status → AI entitlements

Source of truth: `SUBSCRIPTION_STATUS_POLICY` in
`apps/api/src/entitlements/entitlements.service.ts` (tested in `entitlements.service.spec.ts`
and `test/integration/ai-usage-lifecycle.pg.spec.ts`).

| Status | Entitlements | AI access |
|---|---|---|
| `trialing`, `active` | subscribed plan | plan quota |
| `past_due` | subscribed plan | plan quota while Paddle retries the payment (dunning) |
| `paused` | subscribed plan | plan quota — **pending product decision (below)** |
| `cancelled`, `expired`, `none`, unknown | free plan | free quota (50 AI actions / month) |

A cancellation at period end keeps status `active` (`cancelAtPeriodEnd = true`) until Paddle
sends the final `canceled`. A `free` plan row is free in every status. Unknown statuses never
grant a paid plan.

## Pending product decision: paused subscriptions

**Current behavior (unchanged):** a paused subscription keeps the paid plan's entitlements,
although Paddle is not billing it while paused.

Options:

1. **Keep paid access while paused** (current). Simple; customers who pause keep working.
   Risk: indefinite paid access without payment.
2. **Free plan while paused.** Consistent with "no billing, no paid access". Customers lose
   paid features immediately on pause.
3. **Paid access until `currentPeriodEnd`, then free.** Honors the already-paid period; needs
   `currentPeriodEnd` to be reliable for paused subscriptions (Paddle webhooks).

Changing it is a one-line edit of `SUBSCRIPTION_STATUS_POLICY.paused` (option 2) or a small
change in `effectivePlanId` (option 3), plus the corresponding test expectations. No change is
made until the product owner approves an option.
