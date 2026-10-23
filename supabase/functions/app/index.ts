import postgres from "npm:postgres@3.4.4";

// Porta de entrada da página web do Oportuniza (navegador comum, fora do claude.ai).
// Só deixa passar o dono logado (Supabase Auth, e-mail em radar.config.owner_email)
// e repassa a chamada para as funções internas (ml, fin, saude) com a chave interna.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const BASE = (Deno.env.get("SUPABASE_URL") ?? "https://dbikbgbgplosqwnovhvr.supabase.co") + "/functions/v1";
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, x-client-info, content-type", "access-control-allow-methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors } });

const CFG: Record<string, string> = {};
async function cfg(k: string) { if (!(k in CFG)) { const r = await sql`select v from radar.config where k = ${k}`; CFG[k] = r[0]?.v ?? ""; } return CFG[k]; }

const OK = new Map<string, number>();
async function owner(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.split(".").length !== 3) return false;
  const hit = OK.get(jwt); if (hit && hit > Date.now()) return true;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { authorization: `Bearer ${jwt}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" } });
  if (!r.ok) return false;
  const u = await r.json();
  const o = await cfg("owner_email");
  if (!u?.email || !o || String(u.email).toLowerCase() !== o.toLowerCase()) return false;
  OK.set(jwt, Date.now() + 5 * 60e3);
  return true;
}

const ROUTES = /^(niche|niches|search|product|fees|account|categories|status|finance|health|opps|service|intel|prod)$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  try {
    if (!(await owner(req))) return json({ error: "Entre com o e-mail do dono para usar o Oportuniza." }, 401);
    const b = await req.json().catch(() => ({}));
    const route = String(b.route ?? ""), qs = String(b.qs ?? "");
    if (!ROUTES.test(route)) return json({ error: "rota inválida" }, 400);
    const target = route === "finance" ? `${BASE}/fin` : ["health", "opps", "service", "intel", "prod"].includes(route) ? `${BASE}/saude/${route}` : `${BASE}/ml/${route}`;
    const r = await fetch(target + (qs ? "?" + qs : ""), { headers: { "x-radar-key": await cfg("internal_key") } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", ...cors } });
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
});
