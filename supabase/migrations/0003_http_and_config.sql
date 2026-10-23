-- Oportuniza: atalhos SQL que chamam as Edge Functions (usados pelo Claude/MCP) e configuração inicial.
-- Troque dbikbgbgplosqwnovhvr pelo ref do seu projeto se for recriar.

CREATE OR REPLACE FUNCTION radar.ml(p_path text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'radar', 'extensions', 'public'
AS $function$
declare k text; r extensions.http_response;
begin
  select v into k from radar.config where config.k = 'internal_key';
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '25');
  select * into r from extensions.http((
    'GET',
    'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/ml?path=' || extensions.urlencode(p_path),
    array[extensions.http_header('x-radar-key', k)], null, null)::extensions.http_request);
  begin
    return jsonb_build_object('status', r.status, 'body', r.content::jsonb);
  exception when others then
    return jsonb_build_object('status', r.status, 'body', to_jsonb(r.content));
  end;
end $function$;

CREATE OR REPLACE FUNCTION radar.api(p_route text, p_qs text DEFAULT ''::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'radar', 'extensions', 'public'
AS $function$
declare k text; r extensions.http_response; base text;
begin
  if p_route !~ '^(niche|niches|search|product|fees|account|categories|status|finance|health|opps|service|intel|prod)$' then raise exception 'rota inválida'; end if;
  select v into k from radar.config where config.k = 'internal_key';
  base := case when p_route = 'finance' then 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/fin'
               when p_route in ('health','opps','service','intel','prod') then 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/saude/' || p_route
               else 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/ml/' || p_route end;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '150');
  select * into r from extensions.http(('GET', base || case when coalesce(p_qs,'') = '' then '' else '?' || p_qs end,
    array[extensions.http_header('x-radar-key', k)], null, null)::extensions.http_request);
  begin return r.content::jsonb; exception when others then return jsonb_build_object('error', left(r.content, 500), 'status', r.status); end;
end $function$;

-- Chaves geradas no próprio banco (nunca vão para o repositório).
insert into radar.config (k, v) values
  ('internal_key', encode(gen_random_bytes(24), 'hex')),
  ('sup_key', encode(gen_random_bytes(16), 'hex')),
  ('ext_key', encode(gen_random_bytes(16), 'hex')),
  ('owner_email', 'andre.cosolin@gmail.com')
on conflict (k) do nothing;

insert into radar.settings (k, v) values ('tax_pct', 0), ('supplier_fee_order', 0), ('ship_below_79', 6.5), ('ship_free_79', 22), ('target_margin_pct', 20)
on conflict (k) do nothing;

-- Municípios (para a distância até Araraquara): carregados do CSV público kelvins/municipios-brasileiros.
-- with m as (select content from extensions.http_get('https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv')), ...
