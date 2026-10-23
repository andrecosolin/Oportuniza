-- Oportuniza: funções do banco. public.op_call é a porta da página web (só o dono passa).
-- radar.api e radar.ml (chamadas HTTP às funções) ficam em 0003.

CREATE OR REPLACE FUNCTION public.op_call(fn text, a jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
begin
  if not radar.is_owner() then raise exception 'acesso negado' using errcode = '42501'; end if;
  return case fn
    when 'products_list' then radar.products_list()
    when 'vendors_list' then radar.vendors_list()
    when 'suppliers' then radar.suppliers()
    when 'product_from_supplier' then radar.product_from_supplier(a->>0, a->>1)
    when 'remove_product' then radar.remove_product((a->>0)::bigint)
    when 'remove_vendor' then radar.remove_vendor((a->>0)::bigint)
    when 'remove_supplier' then to_jsonb(radar.remove_supplier(a->>0))
    when 'save_product' then radar.save_product(a->0)
    when 'save_vendor' then radar.save_vendor(a->0)
    when 'set_costs' then to_jsonb(radar.set_costs(a->0))
    when 'set_fixed_costs' then to_jsonb(radar.set_fixed_costs(a->0))
    when 'set_offer' then radar.set_offer(a->0)
    when 'set_settings' then to_jsonb(radar.set_settings(a->0))
    when 'set_supplier_prices' then to_jsonb(radar.set_supplier_prices(a->>0, a->1))
    when 'keys' then jsonb_build_object(
        'sup_key', (select v from radar.config where k = 'sup_key'),
        'ext_key', (select v from radar.config where k = 'ext_key'),
        'ml_login', 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/ml/login?k=' || (select v from radar.config where k = 'internal_key'))
    else null end;
end $function$
;

CREATE OR REPLACE FUNCTION radar.import_vendors(src text, items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare e jsonb; n int := 0;
begin
  for e in select * from jsonb_array_elements(items) loop
    if coalesce(e->>'ext_id','') = '' or coalesce(e->>'name','') = '' then continue; end if;
    insert into radar.vendors (source, ext_id, name, city, uf, website, tipos, categorias, dropship)
    values (src, left(e->>'ext_id',160), left(e->>'name',160), nullif(left(e->>'city',80),''), nullif(upper(left(e->>'uf',2)),''), nullif(left(e->>'website',300),''),
      coalesce((select array_agg(left(x,80)) from jsonb_array_elements_text(e->'tipos') x),'{}'),
      coalesce((select array_agg(left(x,80)) from jsonb_array_elements_text(e->'categorias') x),'{}'),
      exists (select 1 from jsonb_array_elements_text(e->'tipos') x where x ilike '%dropshipping%'))
    on conflict (source, ext_id) do update set name = excluded.name, city = excluded.city, uf = excluded.uf, website = coalesce(excluded.website, radar.vendors.website),
      tipos = excluded.tipos, categorias = (select array(select distinct unnest(radar.vendors.categorias || excluded.categorias))),
      dropship = coalesce(radar.vendors.dropship, excluded.dropship), updated_at = now();
    n := n + 1;
  end loop;
  update radar.vendors set distance_km = radar.km_from_home(city, uf) where source = src and distance_km is null and city is not null;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION radar.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
  select coalesce(lower(auth.jwt() ->> 'email') = lower((select v from radar.config where k = 'owner_email')), false)
     and coalesce((auth.jwt() ->> 'role') = 'authenticated', false)
$function$
;

CREATE OR REPLACE FUNCTION radar.km_from_home(c text, u text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'radar', 'public'
AS $function$
  with h as (select lat, lon from radar.cities where key = 'araraquara|SP' limit 1),
       x as (select lat, lon from radar.cities where key = lower(translate(trim(coalesce(c,'')), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) || '|' || upper(trim(coalesce(u,''))) limit 1)
  select round(1.25 * 6371 * 2 * asin(sqrt(power(sin(radians(x.lat - h.lat) / 2), 2) + cos(radians(h.lat)) * cos(radians(x.lat)) * power(sin(radians(x.lon - h.lon) / 2), 2))))::int from h, x
$function$
;

CREATE OR REPLACE FUNCTION radar.product_from_supplier(sup text, sk text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare sp record; ev record; vid bigint; pid bigint;
begin
  select * into sp from radar.supplier_prices where supplier = sup and sku = sk;
  if not found then return jsonb_build_object('error','produto do fornecedor não encontrado'); end if;
  select * into ev from radar.supplier_eval where supplier = sup and sku = sk order by captured_at desc limit 1;
  select id into vid from radar.vendors where lower(name) = lower(sup) order by (source <> 'manual') desc limit 1;
  if vid is null then insert into radar.vendors (name, source, ext_id, status) values (sup, 'manual', null, 'aprovado') returning id into vid; end if;
  select p.id into pid from radar.products p join radar.product_offers o on o.product_id = p.id and o.vendor_id = vid where o.notes = 'sku:' || sk limit 1;
  if pid is null then
    insert into radar.products (name, ml_product_id, stage) values (left(trim(sp.title),200), ev.product_id, 'filtrar') returning id into pid;
  end if;
  insert into radar.product_offers (product_id, vendor_id, cost, stock, confirmed_at, notes) values (pid, vid, sp.cost, sp.stock, sp.updated_at::date, 'sku:' || sk)
  on conflict (product_id, vendor_id) do update set cost = excluded.cost, stock = excluded.stock, confirmed_at = excluded.confirmed_at, updated_at = now();
  return jsonb_build_object('id', pid);
end $function$
;

CREATE OR REPLACE FUNCTION radar.products_list()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('offers', (
      select coalesce(jsonb_agg(jsonb_build_object('vendor_id', o.vendor_id, 'vendor', v.name, 'city', v.city, 'uf', v.uf, 'distance_km', v.distance_km, 'vendor_status', v.status, 'nf', v.nf, 'cost', o.cost, 'moq', o.moq, 'lead_days', o.lead_days, 'stock', o.stock, 'confirmed_at', o.confirmed_at, 'notes', o.notes) order by o.cost nulls last), '[]'::jsonb)
      from radar.product_offers o join radar.vendors v on v.id = o.vendor_id where o.product_id = p.id))
    order by (p.stage = 'descartado'), coalesce((p.eval->>'score')::int, -1) desc, p.updated_at desc), '[]'::jsonb) from radar.products p
$function$
;

CREATE OR REPLACE FUNCTION radar.remove_product(pid bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
begin delete from radar.products where id = pid; return jsonb_build_object('ok', true); end $function$
;

CREATE OR REPLACE FUNCTION radar.remove_supplier(p_supplier text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare n int;
begin
  delete from radar.supplier_prices where supplier = p_supplier;
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION radar.remove_vendor(vid bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
begin delete from radar.vendors where id = vid; return jsonb_build_object('ok', true); end $function$
;

CREATE OR REPLACE FUNCTION radar.save_product(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare pid bigint := nullif(p->>'id','')::bigint;
begin
  if pid is null then
    insert into radar.products (name) values (left(coalesce(nullif(trim(p->>'name'),''),'Produto sem nome'),200)) returning id into pid;
  end if;
  update radar.products set
    name = coalesce(nullif(left(trim(p->>'name'),200),''), name),
    kind = case when p ? 'kind' then coalesce(nullif(p->>'kind',''),'indefinido') else kind end,
    stage = case when p ? 'stage' then coalesce(nullif(p->>'stage',''),'descobrir') else stage end,
    ml_product_id = case when p ? 'ml_product_id' then nullif(p->>'ml_product_id','') else ml_product_id end,
    ml_query = case when p ? 'ml_query' then nullif(left(p->>'ml_query',120),'') else ml_query end,
    category_id = case when p ? 'category_id' then nullif(p->>'category_id','') else category_id end,
    weight_g = case when p ? 'weight_g' then nullif(p->>'weight_g','')::int else weight_g end,
    dims = case when p ? 'dims' then nullif(left(p->>'dims',30),'') else dims end,
    fragile = case when p ? 'fragile' then coalesce((p->>'fragile')::boolean,false) else fragile end,
    regulated = case when p ? 'regulated' then coalesce((p->>'regulated')::boolean,false) else regulated end,
    season_months = case when p ? 'season_months' then coalesce((select array_agg(x::int) from jsonb_array_elements_text(p->'season_months') x),'{}') else season_months end,
    signals = case when p ? 'signals' then coalesce((select array_agg(left(x,40)) from jsonb_array_elements_text(p->'signals') x),'{}') else signals end,
    content_score = case when p ? 'content_score' then least(greatest(coalesce(nullif(p->>'content_score','')::int,0),0),5) else content_score end,
    linked_item_id = case when p ? 'linked_item_id' then nullif(p->>'linked_item_id','') else linked_item_id end,
    test_qty = case when p ? 'test_qty' then nullif(p->>'test_qty','')::int else test_qty end,
    notes = case when p ? 'notes' then nullif(left(p->>'notes',2000),'') else notes end,
    updated_at = now()
  where id = pid;
  return jsonb_build_object('id', pid);
end $function$
;

CREATE OR REPLACE FUNCTION radar.save_vendor(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare vid bigint := nullif(p->>'id','')::bigint;
begin
  if vid is null then
    insert into radar.vendors (name) values (left(coalesce(nullif(trim(p->>'name'),''),'Fornecedor'),160)) returning id into vid;
  end if;
  update radar.vendors set
    name = coalesce(nullif(left(trim(p->>'name'),160),''), name),
    city = case when p ? 'city' then nullif(left(trim(p->>'city'),80),'') else city end,
    uf = case when p ? 'uf' then nullif(upper(left(trim(p->>'uf'),2)),'') else uf end,
    website = case when p ? 'website' then nullif(left(p->>'website',300),'') else website end,
    contact = case when p ? 'contact' then nullif(left(p->>'contact',200),'') else contact end,
    cnpj = case when p ? 'cnpj' then nullif(left(p->>'cnpj',20),'') else cnpj end,
    status = case when p ? 'status' then coalesce(nullif(p->>'status',''),'a contatar') else status end,
    moq = case when p ? 'moq' then nullif(p->>'moq','')::int else moq end,
    lead_days = case when p ? 'lead_days' then nullif(p->>'lead_days','')::int else lead_days end,
    nf = case when p ? 'nf' then (nullif(p->>'nf',''))::boolean else nf end,
    exchange = case when p ? 'exchange' then (nullif(p->>'exchange',''))::boolean else exchange end,
    dropship = case when p ? 'dropship' then (nullif(p->>'dropship',''))::boolean else dropship end,
    stock_confirmed_at = case when p ? 'stock_confirmed_at' then nullif(p->>'stock_confirmed_at','')::date else stock_confirmed_at end,
    notes = case when p ? 'notes' then nullif(left(p->>'notes',2000),'') else notes end,
    updated_at = now()
  where id = vid;
  update radar.vendors v set distance_km = radar.km_from_home(v.city, v.uf) where v.id = vid;
  return jsonb_build_object('id', vid);
end $function$
;

CREATE OR REPLACE FUNCTION radar.set_costs(p jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare n int := 0; e jsonb;
begin
  for e in select * from jsonb_array_elements(p) loop
    if (e->>'item_id') !~ '^MLB[0-9]+$' then continue; end if;
    insert into radar.item_costs (item_id, cost, extra, ship_override, source, updated_at)
      values (e->>'item_id',
              case when e ? 'cost' then nullif(e->>'cost','')::numeric end,
              coalesce(nullif(e->>'extra','')::numeric, 0),
              case when e ? 'ship' then nullif(e->>'ship','')::numeric end,
              coalesce(nullif(e->>'source',''),'manual'), now())
      on conflict (item_id) do update set
        cost = case when e ? 'cost' then excluded.cost else item_costs.cost end,
        extra = case when e ? 'extra' then excluded.extra else item_costs.extra end,
        ship_override = case when e ? 'ship' then excluded.ship_override else item_costs.ship_override end,
        source = case when e ? 'cost' then excluded.source else item_costs.source end,
        updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION radar.set_fixed_costs(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare e jsonb;
begin
  delete from radar.fixed_costs where true;
  for e in select * from jsonb_array_elements(p) loop
    if coalesce(trim(e->>'name'),'') = '' or nullif(e->>'amount','') is null then continue; end if;
    insert into radar.fixed_costs (name, amount) values (left(trim(e->>'name'), 80), (e->>'amount')::numeric);
  end loop;
  return (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'amount', amount) order by id), '[]'::jsonb) from radar.fixed_costs);
end $function$
;

CREATE OR REPLACE FUNCTION radar.set_offer(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
begin
  if coalesce(p->>'remove','') = 'true' then
    delete from radar.product_offers where product_id = (p->>'product_id')::bigint and vendor_id = (p->>'vendor_id')::bigint;
    return jsonb_build_object('ok', true);
  end if;
  insert into radar.product_offers (product_id, vendor_id, cost, moq, lead_days, stock, confirmed_at, notes, updated_at)
  values ((p->>'product_id')::bigint, (p->>'vendor_id')::bigint, nullif(p->>'cost','')::numeric, nullif(p->>'moq','')::int, nullif(p->>'lead_days','')::int, nullif(p->>'stock','')::int, nullif(p->>'confirmed_at','')::date, nullif(left(p->>'notes',500),''), now())
  on conflict (product_id, vendor_id) do update set cost = excluded.cost, moq = excluded.moq, lead_days = excluded.lead_days, stock = excluded.stock, confirmed_at = excluded.confirmed_at, notes = excluded.notes, updated_at = now();
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION radar.set_settings(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare kk text;
begin
  foreach kk in array array['tax_pct','supplier_fee_order','ship_below_79','ship_free_79','target_margin_pct'] loop
    if p ? kk then
      insert into radar.settings (k, v) values (kk, (p->>kk)::numeric) on conflict (k) do update set v = excluded.v;
    end if;
  end loop;
  return (select jsonb_object_agg(s.k, s.v) from radar.settings s);
end $function$
;

CREATE OR REPLACE FUNCTION radar.set_supplier_prices(p_supplier text, p jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
declare n int := 0; e jsonb;
begin
  if coalesce(trim(p_supplier),'') = '' then raise exception 'fornecedor vazio'; end if;
  for e in select * from jsonb_array_elements(p) loop
    if coalesce(e->>'sku','') = '' then continue; end if;
    insert into radar.supplier_prices (supplier, sku, gtin, title, cost, stock, url, updated_at)
      values (p_supplier, e->>'sku', nullif(e->>'gtin',''), nullif(e->>'title',''), nullif(e->>'cost','')::numeric, nullif(e->>'stock','')::int, nullif(e->>'url',''), now())
      on conflict (supplier, sku) do update set gtin = coalesce(excluded.gtin, supplier_prices.gtin), title = coalesce(excluded.title, supplier_prices.title), cost = excluded.cost, stock = coalesce(excluded.stock, supplier_prices.stock), url = coalesce(excluded.url, supplier_prices.url), updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION radar.suppliers()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('supplier', supplier, 'items', n, 'with_cost', wc, 'updated_at', up) order by up desc), '[]'::jsonb)
  from (select supplier, count(*) n, count(cost) wc, max(updated_at) up from radar.supplier_prices group by supplier) s;
$function$
;

CREATE OR REPLACE FUNCTION radar.vendors_list()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'radar', 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(v) - 'created_at' || jsonb_build_object('offers', (select count(*) from radar.product_offers o where o.vendor_id = v.id)) order by (v.status = 'descartado'), v.distance_km nulls last, v.name), '[]'::jsonb) from radar.vendors v
$function$
;

revoke all on function public.op_call(text, jsonb) from public, anon;
grant execute on function public.op_call(text, jsonb) to authenticated;
