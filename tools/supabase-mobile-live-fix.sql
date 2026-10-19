-- Smouha Pick: policies so phones OUTSIDE the branch can request live stock
-- Run in Supabase → SQL Editor (safe to re-run)

-- 1) Ensure tables exist (no-op if already created)
create table if not exists public.dmart_live_requests (
  id uuid primary key default gen_random_uuid(),
  warehouse_id text not null,
  sku text not null,
  status text not null default 'pending',
  available numeric,
  reserved numeric,
  price numeric,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dmart_stock (
  warehouse_id text not null,
  sku text not null,
  available numeric,
  reserved numeric,
  price numeric,
  product_id text,
  updated_at timestamptz not null default now(),
  primary key (warehouse_id, sku)
);

create index if not exists dmart_live_requests_status_idx
  on public.dmart_live_requests (status, created_at);

alter table public.dmart_live_requests enable row level security;
alter table public.dmart_stock enable row level security;

-- 2) ANON (mobile site): insert pending + read own request rows + read stock mirror
drop policy if exists "anon insert live requests" on public.dmart_live_requests;
create policy "anon insert live requests"
  on public.dmart_live_requests for insert to anon
  with check (true);

drop policy if exists "anon select live requests" on public.dmart_live_requests;
create policy "anon select live requests"
  on public.dmart_live_requests for select to anon
  using (true);

drop policy if exists "anon select stock mirror" on public.dmart_stock;
create policy "anon select stock mirror"
  on public.dmart_stock for select to anon
  using (true);

-- 3) Service role bypasses RLS automatically — extension uses service_role for claim/update/upsert
-- No extra policy required for service_role.

-- 4) Optional: allow authenticated role same as anon
drop policy if exists "auth insert live requests" on public.dmart_live_requests;
create policy "auth insert live requests"
  on public.dmart_live_requests for insert to authenticated
  with check (true);

drop policy if exists "auth select live requests" on public.dmart_live_requests;
create policy "auth select live requests"
  on public.dmart_live_requests for select to authenticated
  using (true);

drop policy if exists "auth select stock mirror" on public.dmart_stock;
create policy "auth select stock mirror"
  on public.dmart_stock for select to authenticated
  using (true);
