-- POP400 / AI Shopping List — product rows synced from Waitrose browse (or manual seed).
-- Run in Supabase SQL Editor or via supabase db push.

create table if not exists public.grocery_products (
  id text primary key,
  name text not null,
  price numeric(12, 4) not null default 0,
  unit_price text not null default '',
  image_url text not null default '',
  product_url text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists grocery_products_name_idx on public.grocery_products (name);

alter table public.grocery_products enable row level security;

-- Read-only for anonymous users (Vite app uses anon key).
create policy "Allow anon read grocery_products"
  on public.grocery_products
  for select
  to anon
  using (true);

-- Optional: allow authenticated service / dashboard inserts via service role (bypasses RLS).
-- Seed with: Table Editor, or COPY, or a script using the service_role key.

comment on table public.grocery_products is 'Waitrose (or other) grocery lines for the shopping list UI.';
