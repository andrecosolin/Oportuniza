-- Situações do fornecedor em formato de funil (27/10/2026)
update radar.vendors set status='aguardando resposta' where status='cotação pedida';
alter table radar.vendors alter column status set default 'sem análise';
alter table radar.vendors add constraint vendors_status_chk check (status in ('sem análise','em análise','reserva','a contatar','aguardando resposta','cotação recebida','aguardando amostra','aprovado','descartado'));

create or replace function radar.vendor_status_ord(s text) returns int language sql immutable as $$
  select coalesce(array_position(array['aprovado','aguardando amostra','cotação recebida','aguardando resposta','a contatar','em análise','sem análise','reserva','descartado'], s), 7) $$;

-- save_vendor: situação vazia vira 'sem análise'; distância mantém o valor anterior se a cidade não for achada
CREATE OR REPLACE FUNCTION radar.save_vendor(p jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'radar', 'public'
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
    status = case when p ? 'status' then coalesce(nullif(p->>'status',''),'sem análise') else status end,
    moq = case when p ? 'moq' then nullif(p->>'moq','')::int else moq end,
    lead_days = case when p ? 'lead_days' then nullif(p->>'lead_days','')::int else lead_days end,
    nf = case when p ? 'nf' then (nullif(p->>'nf',''))::boolean else nf end,
    exchange = case when p ? 'exchange' then (nullif(p->>'exchange',''))::boolean else exchange end,
    dropship = case when p ? 'dropship' then (nullif(p->>'dropship',''))::boolean else dropship end,
    stock_confirmed_at = case when p ? 'stock_confirmed_at' then nullif(p->>'stock_confirmed_at','')::date else stock_confirmed_at end,
    notes = case when p ? 'notes' then nullif(left(p->>'notes',2000),'') else notes end,
    updated_at = now()
  where id = vid;
  update radar.vendors v set distance_km = coalesce(radar.km_from_home(v.city, v.uf), v.distance_km) where v.id = vid;
  return jsonb_build_object('id', vid);
end $function$;

-- vendors_list: ordena pelo funil (aprovado primeiro, descartado por último)
CREATE OR REPLACE FUNCTION radar.vendors_list()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'radar', 'public'
AS $function$
  select coalesce(jsonb_agg(to_jsonb(v) - 'created_at' || jsonb_build_object('offers', (select count(*) from radar.product_offers o where o.vendor_id = v.id)) order by radar.vendor_status_ord(v.status), v.distance_km nulls last, v.name), '[]'::jsonb) from radar.vendors v
$function$;
