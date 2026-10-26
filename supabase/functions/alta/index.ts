import postgres from "npm:postgres@3.4.4";

// "Em alta agora": as buscas em alta do ML (tendencias.mercadolivre.com.br) cruzadas com os mais vendidos
// (mercadolivre.com.br/mais-vendidos), a concorrência, a GoBoox e o perfil do Oportuniza (produto pequeno, sem marca forte).
// Roda todo dia pelo agendador do banco e quando o dono toca em Atualizar.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CLIENT_ID = "2244190709439067";
const API = "https://api.mercadolibre.com";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

let KEY: string | null = null;
async function key() { if (!KEY) { const r = await sql`select v from radar.config where k = 'internal_key'`; KEY = r[0]?.v; } return KEY; }
async function tokenRequest(params: Record<string, string>) {
  const secret = Deno.env.get("ML_CLIENT_SECRET");
  if (!secret) throw new Error("ML_CLIENT_SECRET não configurado");
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: secret, ...params }) });
  const j = await r.json(); if (!r.ok) throw new Error(`token ${r.status}`); return j;
}
let TOK: { v: string; exp: number } | null = null;
async function accessToken(): Promise<string | null> {
  if (TOK && TOK.exp > Date.now()) return TOK.v;
  const t = (await sql`select access_token, refresh_token, expires_at from radar.ml_tokens where id = 1`)[0];
  if (!t?.access_token) return null;
  if (new Date(t.expires_at) > new Date()) { TOK = { v: t.access_token, exp: new Date(t.expires_at).getTime() }; return t.access_token; }
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  const exp = new Date(Date.now() + (j.expires_in - 120) * 1000);
  await sql`update radar.ml_tokens set access_token = ${j.access_token}, refresh_token = coalesce(${j.refresh_token ?? null}, refresh_token), expires_at = ${exp}, updated_at = now() where id = 1`;
  TOK = { v: j.access_token, exp: exp.getTime() }; return j.access_token;
}
async function ok(path: string) {
  const tok = await accessToken();
  for (let i = 0; i < 2; i++) {
    const r = await fetch(API + path, { headers: { accept: "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 800)); continue; }
    if (!r.ok) return null; try { return await r.json(); } catch { return null; }
  }
  return null;
}
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null as R; } } }));
  return out;
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (a: number[]) => { a = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set("de da do das dos com para por em e a o as os um uma kit cor sem".split(" "));
const words = (s: string) => norm(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
function cover(term: string, name: string) { const T = words(term), N = new Set(words(name)); if (!T.length) return 0; return T.filter((w) => N.has(w)).length / T.length; }

// o que não vale para o Oportuniza: proibido/regulado no ML, ou busca que não é produto
const BLOCK: [RegExp, string][] = [
  [/vape|cigarro eletr|pod descart|narguile|essencia para/, "proibido no ML (cigarro eletrônico)"],
  [/injet|masteron|anaboliz|esteroid|testosteron|tesamorelin|peptide|ozempic|mounjaro|semaglut|tirzepat|minoxidil|sibutramin|remedio|medicament/, "medicamento ou substância controlada"],
  [/arma de fogo|munic|pistola|revolver|airsoft|arma de pressao/, "arma ou airsoft (regras especiais)"],
  [/vibrador|sex shop|consolo|lingerie sensual|erotic/, "categoria adulta"],
  [/^produtos?$|ebazar|mercado ?livre|mercado ?pago|^h t v$/, "não é produto (busca genérica ou de cobrança)"],
];
const BIG = new Set("apple iphone ipad macbook airpods samsung galaxy xiaomi redmi poco motorola moto lg sony playstation ps4 ps5 xbox nintendo switch jbl philips britania mondial electrolux brastemp consul lenovo dell asus acer hp positivo multilaser intelbras tp-link starlink kindle amazon alexa echo growth integralmedica max titanium probiotica dark lab nike adidas puma mizuno olympikus havaianas stanley tramontina oster arno walita karseell wella loreal natura boticario eudora avon kirkland ryzen intel nvidia geforce radeon kingston logitech redragon".split(" "));

const ACC = /pelicula|capinha|\bmica\b|adesivo|\bskin\b|para (iphone|kindle|xiaomi|samsung|poco|redmi|galaxy|ps5|notebook)|\bcapa\b|\bcase\b|carregador|\bcabo\b|suporte|adaptador|bateria para|controle remoto|protetor|refil|\bpeca\b|compativel/;
// nomes dos 20 mais vendidos de uma categoria (com cache no banco: nome de produto quase não muda)
const TOP = new Map<string, Promise<{ rank: number; id: string; type: string; name: string | null }[]>>();
async function nameOf(id: string, type: string) {
  const c = await sql`select name from radar.ml_names where id = ${id} and at > now() - interval '30 days'`;
  if (c.length) return c[0].name as string;
  const r = type === "ITEM" ? await ok(`/items/${id}?attributes=id,title`) : type === "USER_PRODUCT" ? await ok(`/user-products/${id}`) : await ok(`/products/${id}`);
  const name = r?.name ?? r?.title ?? null;
  if (name) await sql`insert into radar.ml_names (id, name) values (${id}, ${name}) on conflict (id) do update set name = excluded.name, at = now()`;
  return name;
}
function topNames(cat: string) {
  if (!TOP.has(cat)) TOP.set(cat, (async () => {
    const hl = await ok(`/highlights/MLB/category/${cat}`);
    const content: any[] = (hl?.content ?? []).slice(0, 20);
    const names = await pool(content, 5, (x: any) => nameOf(x.id, x.type));
    return content.map((x: any, i: number) => ({ rank: Number(x.position), id: x.id, type: x.type, name: names[i] ?? null }));
  })());
  return TOP.get(cat)!;
}

async function snapshot() {
  const S: Record<string, number> = {}; for (const r of await sql`select k, v from radar.settings`) S[r.k] = Number(r.v);
  const tr: any[] = (await ok("/trends/MLB")) ?? [];
  if (!tr.length) throw new Error("O ML não devolveu as tendências agora. Tente de novo em alguns minutos.");
  const terms = tr.slice(0, 50).map((t: any, i: number) => ({ term: String(t.keyword), url: t.url ?? null, list: i < 10 ? "crescimento" : i < 30 ? "desejada" : "popular", rank: i < 10 ? i + 1 : i < 30 ? i - 9 : i - 29 }));
  const SP = await sql`select supplier, sku, title, cost, stock from radar.supplier_prices where cost is not null and coalesce(stock, 1) > 0`;
  const CAT = new Map<string, any>(), FEE = new Map<string, number>();
  const catInfo = async (id: string) => { if (!CAT.has(id)) CAT.set(id, ok(`/categories/${id}`)); return await CAT.get(id); };
  const feeOf = async (price: number, cat: string) => { const k = `${cat}|${price >= 79 ? 1 : 0}`; if (!FEE.has(k)) { const f = await ok(`/sites/MLB/listing_prices?price=${price}&category_id=${cat}&listing_type_id=gold_special`); const o = Array.isArray(f) ? f[0] : f; FEE.set(k, Number(o?.sale_fee_details?.percentage_fee ?? 13) + (price > 0 ? Number(o?.sale_fee_details?.fixed_fee ?? 0) / price * 100 : 0)); } return FEE.get(k)!; };

  const rows = await pool(terms, 6, async (t) => {
    const n = norm(t.term);
    const block = BLOCK.find(([re]) => re.test(n));
    const [dd, ps] = await Promise.all([ok(`/sites/MLB/domain_discovery/search?q=${encodeURIComponent(t.term)}&limit=1`), ok(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(t.term)}&limit=5`)]);
    const d = Array.isArray(dd) ? dd[0] : null;
    const catId = d?.category_id ?? null;
    const ci = catId ? await catInfo(catId) : null;
    const path = (ci?.path_from_root ?? []).map((x: any) => x.name);
    // produto de catálogo que representa a busca
    const accTerm = ACC.test(n);
    const cands = (ps?.results ?? []).map((p: any) => ({ id: p.id, parent: p.parent_id ?? null, name: p.name, brand: (p.attributes ?? []).find((a: any) => a.id === "BRAND")?.value_name ?? null, c: cover(t.term, p.name) }))
      .filter((p: any) => p.c >= 0.6 && (accTerm || !ACC.test(norm(p.name).slice(0, 40))));
    // preço e concorrência: primeiro candidato que tem vendedores na página do produto
    let prod: any = null, price: number | null = null, sellers: number | null = null, fullPct: number | null = null;
    // soma os vendedores dos produtos de catálogo parecidos (concorrência real da busca)
    const priceOf = async (id: string) => { const it = await ok(`/products/${id}/items?limit=50`); const items = it?.results ?? []; return { items, total: it?.paging?.total ?? items.length }; };
    for (const c of cands.slice(0, 4)) {
      const { items, total } = await priceOf(c.id);
      if (!prod) prod = c;
      if (!items.length) continue;
      sellers = (sellers ?? 0) + total;
      if (price == null) {
        prod = c; price = median(items.map((x: any) => Number(x.price)).filter((x: number) => x > 0));
        fullPct = Math.round(items.filter((x: any) => x.shipping?.logistic_type === "fulfillment").length / items.length * 100);
      }
    }
    // está nos mais vendidos da categoria (top 20)? compara pelo nome dos produtos do ranking
    let best: { rank: number; name: string } | null = null;
    if (catId) {
      const top = await topNames(catId);
      const hit = top.find((x) => x.name && cover(t.term, x.name) >= 0.66 && (accTerm || !ACC.test(norm(x.name).slice(0, 40))));
      if (hit) best = { rank: hit.rank, name: hit.name! };
    }
    // sem preço no catálogo: usa o preço do mais vendido que bateu com a busca
    if (price == null && best) {
      const top = await topNames(catId!); const h: any = top.find((x) => x.rank === best!.rank);
      if (h?.type === "ITEM") { const it = await ok(`/items/${h.id}?attributes=price,shipping`); if (it?.price) { price = Number(it.price); fullPct = it.shipping?.logistic_type === "fulfillment" ? 100 : 0; } }
      else if (h?.type === "PRODUCT") { const { items, total } = await priceOf(h.id); if (items.length) { price = median(items.map((x: any) => Number(x.price)).filter((x: number) => x > 0)); sellers = (sellers ?? 0) + total; fullPct = Math.round(items.filter((x: any) => x.shipping?.logistic_type === "fulfillment").length / items.length * 100); } }
    }
    const brand = prod?.brand && !/gen[eé]ric|sem marca|outr/i.test(prod.brand) ? prod.brand : null;
    const brandSearch = words(t.term).some((w) => BIG.has(w)) || (brand ? words(t.term).some((w) => words(brand).includes(w)) : false);
    // GoBoox: produto parecido com custo
    let sup: any = null;
    const TW = words(t.term);
    for (const r of SP) { const c = cover(t.term, r.title ?? ""); if (TW.length === 1 && words(r.title ?? "")[0] !== TW[0]) continue; if (c >= 0.66 && (!sup || c > sup.c || (c === sup.c && Number(r.cost) < sup.cost))) sup = { c, supplier: r.supplier, sku: r.sku, title: r.title, cost: Number(r.cost), stock: r.stock }; }
    // custo muito abaixo do preço de mercado: quase sempre é outro produto
    if (sup && price && sup.cost < price * 0.1) sup = null;
    if (sup && price && catId) {
      const fp = await feeOf(price, catId); const ship = price >= 79 ? (S.ship_free_79 ?? 22) : (S.ship_below_79 ?? 6.5);
      const m = r2(price * (1 - fp / 100 - (S.tax_pct ?? 0) / 100) - ship - sup.cost - (S.supplier_fee_order ?? 0));
      sup.margin = m; sup.margin_pct = r2(m / price * 100);
    }
    // grupo: cruzamento busca x mais vendidos
    const growing = t.list === "crescimento";
    const group = block ? "nao_vender" : growing && best ? "explodindo" : growing ? "cedo" : best ? "confirmado" : "procura_alta";
    // nota prática para o Oportuniza (0 a 100)
    let score = 0; const why: string[] = [];
    if (!block) {
      score += growing ? 30 - (t.rank - 1) : t.list === "desejada" ? 22 - Math.floor((t.rank - 1) / 4) : 18 - Math.floor((t.rank - 1) / 5);
      if (best) { score += 15; why.push(`${best.rank}º nos mais vendidos de ${d?.category_name ?? "da categoria"}`); }
      if (price != null) { if (price >= 30 && price <= 200) { score += 20; why.push("ticket bom para começar"); } else if (price > 200 && price <= 400) { score += 10; why.push("ticket médio"); } else if (price < 30) { score += 8; why.push("ticket baixo (frete pesa)"); } else why.push(`ticket alto (${Math.round(price)} reais): exige capital`); }
      if (sellers != null) { if (sellers <= 10) { score += 15; why.push(`pouca concorrência (${sellers} vendedores nos produtos do catálogo)`); } else if (sellers <= 40) score += 8; else { score += 3; why.push(`muito disputado (${sellers} vendedores)`); } }
      if (fullPct != null && fullPct >= 70) { score -= 5; why.push(`${fullPct}% em Full`); }
      if (brandSearch) { score -= 8; why.push("busca por marca: precisa ser revendedor autorizado"); } else score += 10;
      if (sup) { if ((sup.margin_pct ?? 0) >= 15) { score += 10; why.push(`tem na ${sup.supplier}, margem estimada ${sup.margin_pct}%`); } else why.push(`tem na ${sup.supplier}${sup.margin_pct != null ? ` (margem ${sup.margin_pct}%)` : ""}`); }
      score = Math.max(0, Math.min(100, score));
    }
    return { term: t.term, list: t.list, rank: t.rank, url: t.url ?? `https://lista.mercadolivre.com.br/${encodeURIComponent(t.term.replace(/\s+/g, "-"))}`,
      category_id: catId, category: d?.category_name ?? null, domain: d?.domain_name ?? null, top_category: path[0] ?? null, path,
      product: prod ? { id: prod.id, name: prod.name, brand: prod.brand } : null, best_rank: best?.rank ?? null, best_name: best?.name ?? null,
      price, sellers, full_pct: fullPct, brand_search: brandSearch, supplier: sup, group, blocked: block ? block[1] : null, score, why };
  });
  const list = rows.filter(Boolean) as any[];
  for (const r of list) await sql`insert into radar.alta_days (day, term, list, rank, data) values (current_date, ${r.term}, ${r.list}, ${r.rank}, ${sql.json(r)})
    on conflict (day, term) do update set list = excluded.list, rank = excluded.rank, data = excluded.data, at = now()`;
  await sql`insert into radar.config (k, v) values ('alta_last', ${new Date().toISOString()}) on conflict (k) do update set v = excluded.v`;
  return { ok: true, n: list.length };
}

async function latest() {
  const day = (await sql`select max(day) d from radar.alta_days`)[0]?.d;
  if (!day) return { ok: true, day: null, items: [] };
  const rows = await sql`select data from radar.alta_days where day = ${day}`;
  const hist = await sql`select term, count(distinct day)::int days, min(day) first_day,
      (array_agg(rank order by day desc))[2] prev_rank, (array_agg(list order by day desc))[2] prev_list
    from radar.alta_days where day > ${day}::date - 30 group by term`;
  const H = new Map(hist.map((h: any) => [h.term, h]));
  const items = rows.map((r: any) => { const h: any = H.get(r.data.term); return { ...r.data, days: h?.days ?? 1, first_day: h?.first_day ?? day, new: !h || h.days <= 1, prev_rank: h?.prev_list === r.data.list ? h?.prev_rank ?? null : null }; })
    .sort((a: any, b: any) => b.score - a.score);
  const last = (await sql`select v from radar.config where k = 'alta_last'`)[0]?.v ?? null;
  const days = Number((await sql`select count(distinct day)::int n from radar.alta_days`)[0].n);
  return { ok: true, day, updated_at: last, days_tracked: days, items };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  if (req.headers.get("x-radar-key") !== (await key())) return json({ error: "não autorizado" }, 401);
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "snapshot") { const r = await snapshot(); return json(b.only_snapshot ? r : await latest()); }
    return json(await latest());
  } catch (e) { return json({ ok: false, error: String((e as Error).message ?? e) }, 200); }
});
