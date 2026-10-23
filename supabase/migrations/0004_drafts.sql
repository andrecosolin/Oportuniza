-- Rascunho de anúncio criado pela extensão (botão "Criar anúncio melhor")
alter table radar.products add column if not exists draft jsonb;
alter table radar.products add column if not exists source_url text;

-- Guarda só a descrição editada e o título escolhido (o resto do rascunho vem da extensão)
create or replace function radar.save_draft(p_id bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path to 'radar', 'public' as $$
declare patch jsonb := '{}'::jsonb;
begin
  if p ? 'description' then patch := patch || jsonb_build_object('description', left(p->>'description', 50000), 'edited_at', now()); end if;
  if p ? 'chosen_title' then patch := patch || jsonb_build_object('chosen_title', left(p->>'chosen_title', 60)); end if;
  update radar.products set draft = coalesce(draft, '{}'::jsonb) || patch, updated_at = now() where id = p_id and draft is not null;
  if not found then return jsonb_build_object('error', 'produto sem rascunho'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function radar.save_draft(bigint, jsonb) from public, anon, authenticated;

create or replace function public.op_call(fn text, a jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'radar', 'public' as $function$
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
    when 'keys' then jsonb_build_object(
        'sup_key', (select v from radar.config where k = 'sup_key'),
        'ext_key', (select v from radar.config where k = 'ext_key'),
        'ml_login', 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/ml/login?k=' || (select v from radar.config where k = 'internal_key'))
    else null end;
end $function$;
