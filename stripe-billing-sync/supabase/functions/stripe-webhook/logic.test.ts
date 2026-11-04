// Run with: node --experimental-strip-types --test supabase/functions/stripe-webhook/logic.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSubscriptionFields, HANDLED_EVENTS, subscriptionIdFromEvent } from "./logic.ts";

const USER = "123e4567-e89b-12d3-a456-426614174000";

function sub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    metadata: { user_id: USER },
    items: { data: [{ price: { id: "price_1" }, current_period_end: 1800000000 }] },
    ...overrides,
  };
}

test("maps a normal active subscription", () => {
  const f = extractSubscriptionFields(sub());
  assert.equal(f.subscriptionId, "sub_1");
  assert.equal(f.customerId, "cus_1");
  assert.equal(f.status, "active");
  assert.equal(f.priceId, "price_1");
  assert.equal(f.currentPeriodEnd, new Date(1800000000 * 1000).toISOString());
  assert.equal(f.userId, USER);
});

test("reads period end from the subscription on older API versions", () => {
  const f = extractSubscriptionFields(
    sub({ current_period_end: 1700000000, items: { data: [{ price: { id: "p" } }] } }),
  );
  assert.equal(f.currentPeriodEnd, new Date(1700000000 * 1000).toISOString());
});

test("accepts an expanded customer object", () => {
  assert.equal(extractSubscriptionFields(sub({ customer: { id: "cus_9" } })).customerId, "cus_9");
});

test("ignores a malformed user_id in metadata", () => {
  assert.equal(extractSubscriptionFields(sub({ metadata: { user_id: "not-a-uuid" } })).userId, null);
});

test("rejects unknown statuses and missing ids", () => {
  assert.throws(() => extractSubscriptionFields(sub({ status: "weird" })), /unknown subscription status/);
  assert.throws(() => extractSubscriptionFields(sub({ customer: null })), /missing id or customer/);
});

test("finds the subscription id on invoice events (new and old shapes)", () => {
  const newShape = {
    type: "invoice.paid",
    data: { object: { parent: { subscription_details: { subscription: "sub_new" } } } },
  };
  const oldShape = { type: "invoice.payment_failed", data: { object: { subscription: "sub_old" } } };
  assert.equal(subscriptionIdFromEvent(newShape), "sub_new");
  assert.equal(subscriptionIdFromEvent(oldShape), "sub_old");
});

test("checkout only counts when it is a subscription checkout", () => {
  const subCheckout = {
    type: "checkout.session.completed",
    data: { object: { mode: "subscription", subscription: "sub_c" } },
  };
  const oneOff = { type: "checkout.session.completed", data: { object: { mode: "payment" } } };
  assert.equal(subscriptionIdFromEvent(subCheckout), "sub_c");
  assert.equal(subscriptionIdFromEvent(oneOff), null);
});

test("handled event list covers the events we promise", () => {
  for (const t of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
    "checkout.session.completed",
  ]) {
    assert.ok(HANDLED_EVENTS.includes(t), t);
  }
});
