-- Agente de estoque: compara fornecedores com os anúncios do ML e ajusta.
alter table radar.supplier_prices add column if not exists first_seen timestamptz;
update radar.supplier_prices set first_seen = coalesce(first_seen, updated_at);
alter table radar.supplier_prices alter column first_seen set default now();

-- cada leitura completa de um fornecedor (para saber o que sumiu e o que é novo)
create table if not exists radar.supplier_imports (
  id bigserial primary key,
  supplier text not null,
  at timestamptz not null default now(),
  n int not null default 0,
  full_catalog boolean not null default false,
  source text
);
alter table radar.supplier_imports enable row level security;

create table if not exists radar.sync_runs (
  id bigserial primary key,
  at timestamptz not null default now(),
  source text,
  auto boolean not null default false,
  summary jsonb
);
alter table radar.sync_runs enable row level security;

create table if not exists radar.sync_changes (
  id bigserial primary key,
  run_id bigint references radar.sync_runs(id) on delete cascade,
  item_id text not null,
  title text,
  kind text not null,            -- pausar, reativar, estoque, preco, sumiu
  safe boolean not null default false,
  before jsonb,
  after jsonb,
  reason text,
  status text not null default 'pendente',  -- pendente, aplicado, erro, ignorado, substituido
  error text,
  at timestamptz not null default now(),
  applied_at timestamptz
);
create index if not exists sync_changes_status_idx on radar.sync_changes (status, item_id);
alter table radar.sync_changes enable row level security;

-- anúncios que o agente pausou (só esses ele reativa sozinho)
create table if not exists radar.agent_paused (
  item_id text primary key,
  at timestamptz not null default now(),
  reason text
);
alter table radar.agent_paused enable row level security;

-- regras do agente
insert into radar.settings (k, v) values ('sync_reserve', 2), ('sync_cap', 10), ('sync_auto', 1) on conflict (k) do nothing;

create or replace function radar.set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'radar', 'public' as $function$
declare kk text;
begin
  foreach kk in array array['tax_pct','supplier_fee_order','ship_below_79','ship_free_79','target_margin_pct','sync_reserve','sync_cap','sync_auto','sync_qty'] loop
    if p ? kk then
      insert into radar.settings (k, v) values (kk, (p->>kk)::numeric) on conflict (k) do update set v = excluded.v;
    end if;
  end loop;
  return (select jsonb_object_agg(s.k, s.v) from radar.settings s);
end $function$;

-- set_supplier_prices mantém first_seen (upsert não mexe nele)
create or replace function radar.set_supplier_prices(p_supplier text, p jsonb)
returns integer language plpgsql security definer set search_path to 'radar', 'public' as $function$
declare n int := 0; e jsonb;
begin
  if coalesce(trim(p_supplier),'') = '' then raise exception 'fornecedor vazio'; end if;
  for e in select * from jsonb_array_elements(p) loop
    if coalesce(e->>'sku','') = '' then continue; end if;
    insert into radar.supplier_prices (supplier, sku, gtin, title, cost, stock, url, updated_at, first_seen)
      values (p_supplier, e->>'sku', nullif(e->>'gtin',''), nullif(e->>'title',''), nullif(e->>'cost','')::numeric, nullif(e->>'stock','')::int, nullif(e->>'url',''), now(), now())
    on conflict (supplier, sku) do update set gtin = coalesce(excluded.gtin, radar.supplier_prices.gtin), title = coalesce(excluded.title, radar.supplier_prices.title),
      cost = excluded.cost, stock = coalesce(excluded.stock, radar.supplier_prices.stock), url = coalesce(excluded.url, radar.supplier_prices.url), updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$;

-- quantidade fica com o fornecedor quando ele já sincroniza (GoBoox); 1 liga o controle pelo agente
insert into radar.settings (k, v) values ('sync_qty', 0) on conflict (k) do nothing;
-- set_settings também aceita sync_qty (ver versão aplicada no banco)
