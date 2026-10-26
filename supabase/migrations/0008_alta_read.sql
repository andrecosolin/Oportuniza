-- leitura do "Em alta agora" para a página (os dois modos: conector e site)
create or replace function radar.alta_latest() returns jsonb language sql stable security definer set search_path = radar, public as $$
  with d as (select max(x.day) as dd from radar.alta_days x),
  h as (
    select y.term, count(distinct y.day)::int as days, min(y.day) as first_day,
           (array_agg(y.rank order by y.day desc))[2] as prev_rank, (array_agg(y.list order by y.day desc))[2] as prev_list
    from radar.alta_days y, d where y.day > d.dd - 30 group by y.term),
  it as (
    select a.data || jsonb_build_object(
             'days', coalesce(h.days, 1), 'first_day', coalesce(h.first_day, a.day), 'new', coalesce(h.days, 1) <= 1,
             'prev_rank', case when h.prev_list = a.list then h.prev_rank end,
             'mine', exists (select 1 from radar.products p where radar.norm_term(coalesce(p.ml_query, p.name)) = radar.norm_term(a.term))) as j
    from radar.alta_days a join d on a.day = d.dd left join h on h.term = a.term)
  select jsonb_build_object(
    'day', (select dd from d),
    'updated_at', (select v from radar.config where k = 'alta_last'),
    'days_tracked', (select count(distinct z.day) from radar.alta_days z),
    'items', coalesce((select jsonb_agg(j order by (j->>'score')::int desc) from it), '[]'::jsonb));
$$;
revoke all on function radar.alta_latest() from public, anon, authenticated;

create or replace function public.op_call(fn text, a jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path to 'radar', 'public' as $function$
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
    when 'save_draft' then radar.save_draft((a->>0)::bigint, a->1)
    when 'save_vendor' then radar.save_vendor(a->0)
    when 'set_costs' then to_jsonb(radar.set_costs(a->0))
    when 'set_fixed_costs' then to_jsonb(radar.set_fixed_costs(a->0))
    when 'set_offer' then radar.set_offer(a->0)
    when 'set_settings' then to_jsonb(radar.set_settings(a->0))
    when 'set_supplier_prices' then to_jsonb(radar.set_supplier_prices(a->>0, a->1))
    when 'alta_latest' then radar.alta_latest()
    when 'keys' then jsonb_build_object(
        'sup_key', (select v from radar.config where k = 'sup_key'),
        'ext_key', (select v from radar.config where k = 'ext_key'),
        'ml_login', 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/ml/login?k=' || (select v from radar.config where k = 'internal_key'))
    else null end;
end $function$;
