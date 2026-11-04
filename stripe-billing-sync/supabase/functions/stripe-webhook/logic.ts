// Pure helpers (no Deno/Stripe imports) so they can be unit-tested anywhere.

export const SUBSCRIPTION_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export const INVOICE_EVENTS = ["invoice.paid", "invoice.payment_failed"] as const;

export const CHECKOUT_EVENTS = ["checkout.session.completed"] as const;

export const HANDLED_EVENTS: readonly string[] = [
  ...SUBSCRIPTION_EVENTS,
  ...INVOICE_EVENTS,
  ...CHECKOUT_EVENTS,
];

export const VALID_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubscriptionFields {
  subscriptionId: string;
  customerId: string;
  status: string;
  priceId: string | null;
  currentPeriodEnd: string | null; // ISO string
  cancelAtPeriodEnd: boolean;
  userId: string | null;
}

// deno-lint-ignore no-explicit-any
type Any = any;

/** The event can never be processed (bad shape, unknown status). Retrying won't help. */
export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEventError";
  }
}

function idOf(value: Any): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value.id === "string") return value.id;
  return null;
}

/** Convert a Stripe subscription object into the columns we store. */
export function extractSubscriptionFields(sub: Any): SubscriptionFields {
  const subscriptionId = idOf(sub?.id);
  const customerId = idOf(sub?.customer);
  if (!subscriptionId || !customerId) {
    throw new PermanentEventError("subscription is missing id or customer");
  }
  if (!VALID_STATUSES.includes(sub.status)) {
    throw new PermanentEventError(`unknown subscription status: ${String(sub.status)}`);
  }

  const item = sub.items?.data?.[0];
  // Newer Stripe API versions put the period on the item; older ones on the subscription.
  const periodEndUnix: unknown = item?.current_period_end ?? sub.current_period_end;
  const currentPeriodEnd = typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000).toISOString()
    : null;

  const metaUser = sub.metadata?.user_id;
  const userId = typeof metaUser === "string" && UUID_RE.test(metaUser) ? metaUser : null;

  return {
    subscriptionId,
    customerId,
    status: sub.status,
    priceId: idOf(item?.price) ?? null,
    currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    userId,
  };
}

/**
 * For events that don't carry the subscription itself (invoice, checkout),
 * find the subscription id so we can fetch its current state from Stripe.
 */
export function subscriptionIdFromEvent(event: Any): string | null {
  const obj = event?.data?.object;
  switch (event?.type) {
    case "invoice.paid":
    case "invoice.payment_failed":
      return idOf(obj?.parent?.subscription_details?.subscription) ??
        idOf(obj?.subscription);
    case "checkout.session.completed":
      return obj?.mode === "subscription" ? idOf(obj?.subscription) : null;
    default:
      return null;
  }
}
