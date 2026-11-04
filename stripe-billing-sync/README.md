# Stripe billing sync

Keeps a `subscriptions` table in Supabase in sync with Stripe, via a webhook Edge Function.

## What it does

| Stripe event | Effect |
|---|---|
| `customer.subscription.created / updated / deleted` | Upserts the subscription (status, price, period end, cancel flag) |
| `invoice.paid`, `invoice.payment_failed` | Re-fetches the subscription from Stripe and upserts it (so `past_due` / `active` is always current) |
| `checkout.session.completed` (subscription mode) | Same: fetch and upsert |
| anything else | Acknowledged (200) and ignored |

**Safety properties**
- Requests without a valid Stripe signature are rejected (400). The check uses the raw request body.
- Each event ID is stored in `stripe_events`; a replayed event does nothing.
- Events older than the one already applied for a subscription are ignored (Stripe can deliver out of order).
- The event record and the subscription write happen in one database transaction. If it fails the function returns 500 and Stripe retries.
- RLS is on. Users can read only their own subscription; only the service role writes.

## Files

- `supabase/migrations/20261104000000_stripe_billing_sync.sql`: tables, RLS, and the `apply_stripe_subscription_event` function
- `supabase/functions/stripe-webhook/index.ts`: the webhook handler
- `supabase/functions/stripe-webhook/logic.ts`: pure mapping helpers
- `supabase/functions/stripe-webhook/logic.test.ts`: unit tests

## Set up

1. **Pick a Supabase project** and apply the migration (`supabase db push`, or paste the SQL into the SQL editor).
2. **Set secrets** (never commit these):
   ```
   supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
   ```
3. **Deploy** (Stripe doesn't send a Supabase JWT, so JWT verification is off; the Stripe signature is the authentication):
   ```
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
4. **In the Stripe dashboard**, add a webhook endpoint at
   `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
   and select the six events in the table above. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. **Link subscriptions to your users:** when creating a Checkout Session, pass
   `subscription_data: { metadata: { user_id: "<supabase auth user uuid>" } }`.
   Without it, rows are still stored but `user_id` stays null.

Test with the Stripe CLI first, using test-mode keys:
```
stripe listen --forward-to https://<project-ref>.supabase.co/functions/v1/stripe-webhook
stripe trigger customer.subscription.created
```

## Run the tests

Requires Node 22.6+:
```
node --experimental-strip-types --test supabase/functions/stripe-webhook/logic.test.ts
```

## Before you rely on it

- **Set `user_id` metadata server-side only**, from the authenticated session, never from client input. It is the only link between a Stripe subscription and an account. Once a row has a `user_id` it is never re-assigned.
- **Entitlement checks** (who gets paid features) should require `status in ('active', 'trialing')`, a `current_period_end` in the future, and an expected `price_id`. Treat `past_due`, `unpaid` and `incomplete` as not paid, or as a grace period you choose deliberately.
- **Permanently invalid events** (e.g. a new Stripe status this code doesn't know) return 200 and log `event_permanently_invalid` at error level. Alert on that log line so they aren't silently dropped.
- **`stripe_events` grows forever.** Delete rows older than about 30 days on a schedule (Stripe stops retrying after 3 days).

## Not covered yet

- Email alerts on `past_due` (the natural next automation)
- A scheduled reconciliation job that compares Stripe to the table, to catch any events that were never delivered
- Handler-level integration tests (these need a Supabase test project and Stripe test keys)
