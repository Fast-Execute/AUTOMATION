// Supabase Edge Function: receives Stripe webhooks and keeps `subscriptions` in sync.
//
// Required secrets (set with `supabase secrets set`, never commit them):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// Deploy with JWT verification off (Stripe doesn't send a Supabase JWT);
// authenticity comes from the Stripe signature check below:
//   supabase functions deploy stripe-webhook --no-verify-jwt

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  extractSubscriptionFields,
  HANDLED_EVENTS,
  PermanentEventError,
  SUBSCRIPTION_EVENTS,
  subscriptionIdFromEvent,
} from "./logic.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

const MAX_BODY_BYTES = 1_000_000; // Stripe events are far smaller than this

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
  httpClient: Stripe.createFetchHttpClient(),
  timeout: 10_000,
  maxNetworkRetries: 2,
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const webhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));
}

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return respond(405, { error: "method_not_allowed" });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return respond(400, { error: "missing_signature" });

  // Cap the body size before reading it: this endpoint is public.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) return respond(413, { error: "payload_too_large" });

  // Signature must be verified against the raw, unparsed body.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return respond(413, { error: "payload_too_large" });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    log("warn", "signature_verification_failed", { error: String(err) });
    return respond(400, { error: "invalid_signature" });
  }

  const ctx = { event_id: event.id, event_type: event.type };

  // Unknown types: acknowledge so Stripe doesn't retry forever.
  if (!HANDLED_EVENTS.includes(event.type)) {
    log("info", "event_ignored", ctx);
    return respond(200, { received: true, result: "ignored" });
  }

  try {
    let subscription: Stripe.Subscription;
    // Subscription events carry their own timestamp. For invoice/checkout events we fetch the
    // current state, so the row is stamped with the fetch time: that state is newer than any
    // subscription event created before it, which are then correctly ignored as stale.
    let appliedAt = event.created;

    if ((SUBSCRIPTION_EVENTS as readonly string[]).includes(event.type)) {
      subscription = event.data.object as Stripe.Subscription;
    } else {
      // Invoice/checkout events: fetch the subscription's current state.
      const subId = subscriptionIdFromEvent(event);
      if (!subId) {
        log("info", "event_without_subscription", ctx);
        return respond(200, { received: true, result: "ignored" });
      }
      subscription = await stripe.subscriptions.retrieve(subId);
      appliedAt = Math.max(event.created, Math.floor(Date.now() / 1000));
    }

    const f = extractSubscriptionFields(subscription);

    const { data, error } = await supabase.rpc("apply_stripe_subscription_event", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_event_created: appliedAt,
      p_subscription_id: f.subscriptionId,
      p_customer_id: f.customerId,
      p_status: f.status,
      p_price_id: f.priceId,
      p_current_period_end: f.currentPeriodEnd,
      p_cancel_at_period_end: f.cancelAtPeriodEnd,
      p_user_id: f.userId,
    });

    if (error) throw error;

    log("info", "event_processed", { ...ctx, result: data, subscription_id: f.subscriptionId });
    return respond(200, { received: true, result: data });
  } catch (err) {
    if (err instanceof PermanentEventError) {
      // Retrying can never fix this. Acknowledge so Stripe doesn't retry and eventually disable the
      // endpoint, and log at error level so it can be alerted on.
      log("error", "event_permanently_invalid", { ...ctx, error: err.message });
      return respond(200, { received: true, result: "invalid" });
    }
    // 500 makes Stripe retry with backoff. Nothing was recorded if the RPC failed (it's one transaction).
    log("error", "event_processing_failed", { ...ctx, error: String(err) });
    return respond(500, { error: "processing_failed" });
  }
});
