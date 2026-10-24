-- Sinais de fora do ML lidos pela extensão: Google Trends e Shopee.
create table if not exists radar.ext_signals (
  id bigserial primary key,
  source text not null,          -- gtrends, shopee
  term text not null,
  term_norm text not null,
  geo text,
  captured_at timestamptz not null default now(),
  data jsonb not null
);
create index if not exists ext_signals_term_idx on radar.ext_signals (source, term_norm, captured_at desc);
alter table radar.ext_signals enable row level security;

create or replace function radar.norm_term(t text) returns text language sql immutable as $$
  select trim(regexp_replace(translate(lower(coalesce(t,'')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', ' ', 'g'))
$$;

-- pontos de demanda vindos de fora do ML para um termo de busca (usado na nota do produto)
create or replace function radar.ext_demand(q text) returns jsonb language plpgsql stable security definer set search_path to 'radar', 'public' as $$
declare n text := radar.norm_term(q); g jsonb; s jsonb; pts int := 0; why text[] := '{}'; lbl text; med numeric; m text[] := array['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
begin
  if n = '' then return jsonb_build_object('pts', 0, 'why', '[]'::jsonb); end if;
  select data into g from radar.ext_signals where source = 'gtrends' and captured_at > now() - interval '120 days'
    and (term_norm = n or n like '%' || term_norm || '%' or term_norm like '%' || n || '%') order by (term_norm = n) desc, captured_at desc limit 1;
  select data into s from radar.ext_signals where source = 'shopee' and captured_at > now() - interval '60 days'
    and (term_norm = n or n like '%' || term_norm || '%' or term_norm like '%' || n || '%') order by (term_norm = n) desc, captured_at desc limit 1;
  if g is not null then
    lbl := g->>'label';
    if lbl = 'subindo' then pts := pts + 6; why := why || ('busca no Google subindo (' || coalesce(g->>'momentum','?') || '% em 3 meses)');
    elsif lbl = 'moda subindo' then pts := pts + 5; why := why || 'moda subindo no Google (cuidado: pode passar rápido)'::text;
    elsif lbl in ('em época','época chegando') then pts := pts + 4; why := why || ('sazonal no Google, ' || lbl);
    elsif lbl = 'estável' then pts := pts + 2; why := why || 'busca estável no Google'::text;
    elsif lbl in ('caindo','moda passando','fora de época') then why := why || ('Google: ' || lbl || ' (sem pontos)');
    end if;
  end if;
  if s is not null then
    med := nullif(s->>'sold_median_top20','')::numeric;
    if med >= 1000 then pts := pts + 6; elsif med >= 200 then pts := pts + 4; elsif med >= 30 then pts := pts + 2; end if;
    if med is not null then why := why || ('vende na Shopee (mediana dos 20 mais vendidos: ' || case when med >= 1000 then '+' || round(med/1000) || ' mil' else round(med)::text end || ')'); end if;
  end if;
  return jsonb_build_object('pts', pts, 'why', to_jsonb(why),
    'gtrends', case when g is null then null else g - 'series' - 'month_avg' end,
    'shopee', case when s is null then null else s - 'items' end);
end $$;
revoke all on function radar.ext_demand(text) from public, anon, authenticated;

-- casamento por palavras (versão aplicada depois): "lanterna de cabeça" casa com "lanterna cabeça recarregável"
create or replace function radar.term_words(t text) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct w), '{}') from unnest(string_to_array(radar.norm_term(t), ' ')) w
  where length(w) >= 3 and w not in ('com','para','por','kit','sem','dos','das','uma','uns')
$$;
-- radar.ext_demand foi recriada usando term_words (<@ nos dois sentidos); ver banco
