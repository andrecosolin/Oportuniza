-- Oportuniza: estrutura do banco (schema radar) no Supabase.
-- Gerado a partir do banco em produção em 2026-10-23.

create schema if not exists radar;
create extension if not exists http with schema extensions;

create table if not exists radar.cat_cache (
  category_id text not null,
  name text,
  path jsonb,
  updated_at timestamp with time zone default now(),
  constraint cat_cache_pkey PRIMARY KEY (category_id)
);

create table if not exists radar.cities (
  ibge integer not null,
  nome text not null,
  uf text not null,
  lat double precision not null,
  lon double precision not null,
  key text not null,
  constraint cities_pkey PRIMARY KEY (ibge)
);

create table if not exists radar.config (
  k text not null,
  v text not null,
  constraint config_pkey PRIMARY KEY (k)
);

create table if not exists radar.fixed_costs (
  id bigserial,
  name text not null,
  amount numeric not null,
  created_at timestamp with time zone default now(),
  constraint fixed_costs_pkey PRIMARY KEY (id)
);

create table if not exists radar.goboox_products (
  sku text not null,
  title text,
  cost numeric,
  stock integer,
  category text,
  image text,
  url text,
  ml_query text,
  captured_at timestamp with time zone default now(),
  constraint goboox_products_pkey PRIMARY KEY (sku)
);

create table if not exists radar.highlights_hist (
  category_id text not null,
  captured_on date not null default CURRENT_DATE,
  rank integer not null,
  ref_id text not null,
  ref_type text,
  title text,
  price numeric,
  sold_label text,
  constraint highlights_hist_pkey PRIMARY KEY (category_id, captured_on, rank)
);

create table if not exists radar.item_costs (
  item_id text not null,
  cost numeric,
  extra numeric default 0,
  ship_override numeric,
  supplier text default 'GoBoox'::text,
  updated_at timestamp with time zone default now(),
  source text default 'manual'::text,
  constraint item_costs_pkey PRIMARY KEY (item_id)
);

create table if not exists radar.item_snapshots (
  id bigserial,
  item_id text not null,
  captured_at timestamp with time zone default now(),
  source text,
  query text,
  "position" integer,
  title text,
  price numeric,
  original_price numeric,
  sold_label text,
  sold_min integer,
  seller_id bigint,
  seller_name text,
  listing_type text,
  full_fulfillment boolean,
  free_shipping boolean,
  category_id text,
  permalink text,
  thumbnail text,
  reviews integer,
  rating numeric,
  constraint item_snapshots_pkey PRIMARY KEY (id)
);

create table if not exists radar.market_cache (
  key text not null,
  product_id text,
  product_name text,
  median_price numeric,
  min_price numeric,
  max_price numeric,
  sellers integer,
  full_pct numeric,
  category_id text,
  captured_at timestamp with time zone default now(),
  similarity numeric,
  constraint market_cache_pkey PRIMARY KEY (key)
);

create table if not exists radar.ml_tokens (
  id integer not null default 1,
  user_id bigint,
  nickname text,
  access_token text,
  refresh_token text,
  expires_at timestamp with time zone,
  updated_at timestamp with time zone default now(),
  constraint ml_tokens_id_check CHECK ((id = 1)),
  constraint ml_tokens_pkey PRIMARY KEY (id)
);

create table if not exists radar.niche_stats (
  parent_id text not null,
  category_id text not null,
  captured_on date not null default CURRENT_DATE,
  name text,
  total_items bigint,
  children integer,
  supply_share numeric,
  search_share numeric,
  sales_share numeric,
  opportunity numeric,
  median_offers numeric,
  median_price numeric,
  full_pct numeric,
  score integer,
  tier text,
  top_terms jsonb,
  top_products jsonb,
  captured_at timestamp with time zone default now(),
  constraint niche_stats_pkey PRIMARY KEY (parent_id, category_id, captured_on)
);

create table if not exists radar.notes (
  id bigserial,
  kind text,
  ref text,
  body text,
  created_at timestamp with time zone default now(),
  constraint notes_pkey PRIMARY KEY (id)
);

create table if not exists radar.oauth_state (
  state text not null,
  verifier text,
  created_at timestamp with time zone default now(),
  constraint oauth_state_pkey PRIMARY KEY (state)
);

create table if not exists radar.products (
  id bigserial,
  name text not null,
  kind text not null default 'indefinido'::text,
  stage text not null default 'descobrir'::text,
  ml_product_id text,
  ml_query text,
  category_id text,
  weight_g integer,
  dims text,
  fragile boolean default false,
  regulated boolean default false,
  season_months integer[] default '{}'::integer[],
  signals text[] default '{}'::text[],
  content_score integer default 0,
  linked_item_id text,
  test_qty integer,
  notes text,
  eval jsonb,
  eval_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  constraint products_pkey PRIMARY KEY (id)
);

create table if not exists radar.settings (
  k text not null,
  v numeric not null,
  constraint settings_pkey PRIMARY KEY (k)
);

create table if not exists radar.ship_cache (
  k text not null,
  price numeric not null,
  cost numeric not null,
  billable_weight integer,
  at timestamp with time zone not null default now(),
  constraint ship_cache_pkey PRIMARY KEY (k)
);

create table if not exists radar.supplier_eval (
  supplier text not null,
  sku text not null,
  captured_on date not null default CURRENT_DATE,
  title text,
  cost numeric,
  stock integer,
  product_id text,
  product_name text,
  market_median numeric,
  market_min numeric,
  sellers integer,
  fee_pct numeric,
  price_min numeric,
  price_ideal numeric,
  margin_at_market numeric,
  margin_pct_at_market numeric,
  score integer,
  verdict text,
  reason text,
  captured_at timestamp with time zone default now(),
  confidence text,
  constraint supplier_eval_pkey PRIMARY KEY (supplier, sku, captured_on)
);

create table if not exists radar.supplier_prices (
  supplier text not null,
  sku text not null,
  gtin text,
  title text,
  cost numeric,
  stock integer,
  url text,
  updated_at timestamp with time zone default now(),
  constraint supplier_prices_pkey PRIMARY KEY (supplier, sku)
);

create table if not exists radar.vendors (
  id bigserial,
  name text not null,
  source text not null default 'manual'::text,
  ext_id text,
  city text,
  uf text,
  distance_km integer,
  website text,
  contact text,
  cnpj text,
  tipos text[] default '{}'::text[],
  categorias text[] default '{}'::text[],
  status text not null default 'a contatar'::text,
  moq integer,
  lead_days integer,
  nf boolean,
  exchange boolean,
  dropship boolean,
  stock_confirmed_at date,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  constraint vendors_pkey PRIMARY KEY (id),
  constraint vendors_source_ext_id_key UNIQUE (source, ext_id)
);

create table if not exists radar.watch_categories (
  category_id text not null,
  name text,
  path text,
  added_at timestamp with time zone default now(),
  constraint watch_categories_pkey PRIMARY KEY (category_id)
);

create table if not exists radar.product_offers (
  product_id bigint not null,
  vendor_id bigint not null,
  cost numeric,
  moq integer,
  lead_days integer,
  stock integer,
  confirmed_at date,
  notes text,
  updated_at timestamp with time zone default now(),
  constraint product_offers_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES radar.vendors(id) ON DELETE CASCADE,
  constraint product_offers_pkey PRIMARY KEY (product_id, vendor_id),
  constraint product_offers_product_id_fkey FOREIGN KEY (product_id) REFERENCES radar.products(id) ON DELETE CASCADE
);

CREATE INDEX supplier_prices_gtin_idx ON radar.supplier_prices USING btree (gtin);
CREATE INDEX cities_key ON radar.cities USING btree (key);
CREATE INDEX item_snapshots_item_id_captured_at_idx ON radar.item_snapshots USING btree (item_id, captured_at DESC);
CREATE INDEX item_snapshots_query_captured_at_idx ON radar.item_snapshots USING btree (query, captured_at DESC);
CREATE INDEX item_snapshots_item_time ON radar.item_snapshots USING btree (item_id, captured_at);
