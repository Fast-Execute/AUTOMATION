-- Stripe billing sync: subscriptions + processed webhook events.
-- Writes are done only by the webhook edge function using the service role.

create table if not exists public.subscriptions (
  stripe_subscription_id text primary key,
  stripe_customer_id     text not null,
  user_id                uuid references auth.users (id) on delete set null,
  status                 text not null
    check (status in (
      'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )),
  price_id               text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  last_event_created     bigint not null,  -- Stripe event.created (unix seconds); used to ignore stale events
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_user_idx     on public.subscriptions (user_id);

-- One row per processed Stripe event. Primary key makes replays a no-op.
create table if not exists public.stripe_events (
  event_id     text primary key,
  event_type   text not null,
  processed_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;

-- Users may read only their own subscription. No insert/update/delete policies:
-- only the service role (which bypasses RLS) can write.
drop policy if exists "users read own subscription" on public.subscriptions;
create policy "users read own subscription"
  on public.subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

-- stripe_events has no policies: invisible to anon/authenticated roles.

-- Apply a subscription event atomically: dedupe by event id, then upsert unless a newer event was already applied.
-- Returns 'duplicate', 'stale' or 'applied'.
--   * user_id is set once and never re-assigned by a later event.
--   * on a same-second tie, a terminal status (canceled / incomplete_expired) is never overwritten.
--   * a user_id that doesn't exist in auth.users is stored as null instead of failing the event forever.
create or replace function public.apply_stripe_subscription_event(
  p_event_id             text,
  p_event_type           text,
  p_event_created        bigint,
  p_subscription_id      text,
  p_customer_id          text,
  p_status               text,
  p_price_id             text,
  p_current_period_end   timestamptz,
  p_cancel_at_period_end boolean,
  p_user_id              uuid default null
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows int;
  v_user uuid := p_user_id;
begin
  insert into public.stripe_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'duplicate';
  end if;

  for attempt in 1..2 loop
    begin
      insert into public.subscriptions as s (
        stripe_subscription_id, stripe_customer_id, user_id, status, price_id,
        current_period_end, cancel_at_period_end, last_event_created
      ) values (
        p_subscription_id, p_customer_id, v_user, p_status, p_price_id,
        p_current_period_end, p_cancel_at_period_end, p_event_created
      )
      on conflict (stripe_subscription_id) do update set
        stripe_customer_id   = excluded.stripe_customer_id,
        user_id              = coalesce(s.user_id, excluded.user_id),
        status               = excluded.status,
        price_id             = excluded.price_id,
        current_period_end   = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        last_event_created   = excluded.last_event_created,
        updated_at           = now()
      where s.last_event_created < excluded.last_event_created
         or (s.last_event_created = excluded.last_event_created
             and s.status not in ('canceled', 'incomplete_expired'));
      get diagnostics v_rows = row_count;
      exit;
    exception when foreign_key_violation then
      -- metadata pointed at a user that doesn't exist: keep the subscription, drop the link.
      v_user := null;
    end;
  end loop;

  return case when v_rows = 0 then 'stale' else 'applied' end;
end;
$$;

revoke all on function public.apply_stripe_subscription_event(
  text, text, bigint, text, text, text, text, timestamptz, boolean, uuid
) from public, anon, authenticated;

-- Defence in depth: Supabase grants table privileges to anon/authenticated by default.
-- RLS already blocks writes; remove the grants as well.
revoke insert, update, delete, truncate on public.subscriptions from anon, authenticated;
revoke all on public.stripe_events from anon, authenticated;
