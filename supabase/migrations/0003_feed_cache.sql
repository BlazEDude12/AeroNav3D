-- Shared response cache for the flights Edge Function. Function instances
-- don't share memory (each request may run on a fresh isolate), so caching
-- and snapshot throttling live here instead.
create table public.feed_cache (
  key text primary key,
  body text not null,
  fetched_at timestamptz not null default now(),
  snapshot_at timestamptz
);

alter table public.feed_cache enable row level security;
-- No policies on purpose: only the service role (the Edge Function) uses it.

select cron.schedule(
  'feed-cache-cleanup',
  '17 * * * *',
  $$delete from public.feed_cache where fetched_at < now() - interval '1 day'$$
);
