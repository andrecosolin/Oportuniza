-- "Em alta agora": foto diária das buscas em alta do ML cruzadas com mais vendidos, concorrência e GoBoox.
create table if not exists radar.alta_days (
  day date not null default current_date,
  term text not null,
  list text not null,
  rank int not null,
  data jsonb not null,
  at timestamptz not null default now(),
  primary key (day, term)
);
alter table radar.alta_days enable row level security;

-- nomes dos produtos dos mais vendidos (cache de 30 dias)
create table if not exists radar.ml_names (id text primary key, name text, at timestamptz not null default now());
alter table radar.ml_names enable row level security;

-- roda sozinho todo dia às 06:20 (Brasília); a chave é lida do banco, não fica no agendamento
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('oportuniza-em-alta', '20 9 * * *', $cron$
  select net.http_post(
    url := 'https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/alta',
    headers := jsonb_build_object('content-type', 'application/json', 'x-radar-key', (select v from radar.config where k = 'internal_key')),
    body := '{"action":"snapshot","only_snapshot":true}'::jsonb,
    timeout_milliseconds := 150000)
$cron$);
