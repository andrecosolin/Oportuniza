import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CLIENT_ID = "2244190709439067";
const REDIRECT = "https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/ml/callback";
const API = "https://api.mercadolibre.com";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-radar-key, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors } });
const text = (t: string, s = 200) => new Response(t, { status: s, headers: { "content-type": "text/plain; charset=utf-8" } });

let KEY: string | null = null;
async function key() { if (!KEY) { const r = await sql`select v from radar.config where k = 'internal_key'`; KEY = r[0]?.v; } return KEY; }


async function tokenRequest(params: Record<string, string>) {
  const secret = Deno.env.get("ML_CLIENT_SECRET");
  if (!secret) throw new Error("ML_CLIENT_SECRET não configurado");
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: secret, ...params }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
async function saveToken(j: any) {
  const exp = new Date(Date.now() + (j.expires_in - 120) * 1000);
  let nick: string | null = null;
  try { nick = (await (await fetch(`${API}/users/me`, { headers: { authorization: `Bearer ${j.access_token}` } })).json()).nickname ?? null; } catch (_) { /**/ }
  await sql`insert into radar.ml_tokens (id, user_id, nickname, access_token, refresh_token, expires_at, updated_at)
    values (1, ${j.user_id ?? null}, ${nick}, ${j.access_token}, ${j.refresh_token ?? null}, ${exp}, now())
    on conflict (id) do update set user_id = excluded.user_id, nickname = coalesce(excluded.nickname, radar.ml_tokens.nickname), access_token = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, radar.ml_tokens.refresh_token), expires_at = excluded.expires_at, updated_at = now()`;
}
let TOK: { v: string; exp: number } | null = null;
async function accessToken(): Promise<string | null> {
  if (TOK && TOK.exp > Date.now()) return TOK.v;
  const r = await sql`select access_token, refresh_token, expires_at from radar.ml_tokens where id = 1`;
  const t = r[0];
  if (!t?.access_token) return null;
  if (new Date(t.expires_at) > new Date()) { TOK = { v: t.access_token, exp: new Date(t.expires_at).getTime() }; return t.access_token; }
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  await saveToken(j);
  TOK = { v: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return j.access_token;
}

async function ml(path: string): Promise<{ status: number; body: any }> {
  const tok = await accessToken();
  const r = await fetch(API + path, { headers: { accept: "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });
  const t = await r.text();
  let body: any; try { body = JSON.parse(t); } catch { body = t.slice(0, 500); }
  return { status: r.status, body };
}
const ok = async (path: string) => { const r = await ml(path); return r.status === 200 ? r.body : null; };

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null as R; } } }));
  return out;
}
const median = (a: number[]) => { a = a.filter((x) => x != null && !isNaN(x)); if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ---------- caches por instância ---------- */
const CAT = new Map<string, any>();
async function cat(id: string) {
  if (CAT.has(id)) return CAT.get(id);
  const c = await ok(`/categories/${id}`);
  const v = c ? { id: c.id, name: c.name, path: (c.path_from_root ?? []).map((p: any) => p.id), pathNames: (c.path_from_root ?? []).map((p: any) => ({ id: p.id, name: p.name })), total: c.total_items_in_this_category ?? 0, children: (c.children_categories ?? []).map((k: any) => ({ id: k.id, name: k.name, total: k.total_items_in_this_category })) } : null;
  CAT.set(id, v); return v;
}
const TERM = new Map<string, string | null>();
async function termCat(q: string) {
  if (TERM.has(q)) return TERM.get(q);
  const d = await ok(`/sites/MLB/domain_discovery/search?q=${encodeURIComponent(q)}&limit=1`);
  const v = d?.[0]?.category_id ?? null; TERM.set(q, v); return v;
}
const OFF = new Map<string, any>();
async function offers(productId: string, max = 50) {
  const k = productId + ":" + max; if (OFF.has(k)) return OFF.get(k);
  const first = await ml(`/products/${productId}/items?limit=50`);
  let res = { total: 0, items: [] as any[] };
  if (first.status === 200) {
    let items = first.body.results ?? [];
    const total = first.body.paging?.total ?? items.length;
    if (max > 50 && total > 50) { const s = await ok(`/products/${productId}/items?limit=50&offset=50`); if (s?.results) items = items.concat(s.results); }
    res = { total, items };
  }
  OFF.set(k, res); return res;
}
function offerStats(o: { total: number; items: any[] }) {
  const prices = o.items.map((x) => Number(x.price)).filter((x) => x > 0);
  const sellers = new Set(o.items.map((x) => x.seller_id));
  const full = o.items.filter((x) => x.shipping?.logistic_type === "fulfillment").length;
  const premium = o.items.filter((x) => x.listing_type_id === "gold_pro").length;
  return { offers: o.total, sellers_sample: sellers.size, min_price: prices.length ? Math.min(...prices) : null, median_price: median(prices), max_price: prices.length ? Math.max(...prices) : null, full_pct: o.items.length ? Math.round(full / o.items.length * 100) : null, premium_pct: o.items.length ? Math.round(premium / o.items.length * 100) : null };
}
async function productCard(id: string) {
  const [p, o] = await Promise.all([ok(`/products/${id}`), offers(id)]);
  if (!p) return null;
  return { id, name: p.name, picture: p.pictures?.[0]?.url ?? null, domain_id: p.domain_id ?? null, permalink: p.permalink || `https://www.mercadolivre.com.br/p/${id}`, category_id: o.items[0]?.category_id ?? null, ...offerStats(o) };
}

/* ---------- ranking de nichos ---------- */
function childOf(path: string[], parent: string) {
  if (parent === "ROOT") return path[0] ?? null;
  const i = path.indexOf(parent); return i >= 0 ? path[i + 1] ?? null : null;
}
async function routeNiches(parent: string, fresh: boolean) {
  if (!fresh) {
    const cached = await sql`select * from radar.niche_stats where parent_id = ${parent} and captured_on = current_date order by score desc nulls last`;
    if (cached.length) return await nichesPayload(parent, cached, true);
  }
  let children: { id: string; name: string; total?: number }[];
  if (parent === "ROOT") children = ((await ok("/sites/MLB/categories")) ?? []).map((c: any) => ({ id: c.id, name: c.name }));
  else { const p = await cat(parent); if (!p) return { error: "categoria não encontrada" }; children = p.children; }
  if (!children.length) return { error: "esta categoria não tem subcategorias", leaf: true };
  const ids = new Set(children.map((c) => c.id));

  // oferta: total de anúncios de cada filho
  const details = await pool(children, 12, (c) => cat(c.id));

  // procura: buscas em alta da mãe, classificadas por filho (peso pela posição)
  const trends: string[] = ((await ok(parent === "ROOT" ? "/trends/MLB" : `/trends/MLB/${parent}`)) ?? []).map((t: any) => t.keyword).slice(0, 50);
  const tw: Record<string, number> = {}; const terms: Record<string, string[]> = {}; let twTotal = 0, tMapped = 0;
  await pool(trends, 12, async (kw, i) => {
    const leaf = await termCat(kw); if (!leaf) return;
    const lc = await cat(leaf); if (!lc) return;
    const ch = childOf(lc.path, parent); if (!ch || !ids.has(ch)) return;
    const w = 51 - i; tw[ch] = (tw[ch] ?? 0) + w; (terms[ch] ??= []).push(kw); tMapped++;
  });
  for (let i = 0; i < trends.length; i++) twTotal += 51 - i;

  // vendas: 20 mais vendidos da mãe (ranking de vendas do ML), peso pela posição
  const sw: Record<string, number> = {}; let swTotal = 0, sMapped = 0, sTotal = 0;
  if (parent !== "ROOT") {
    const hl = await ok(`/highlights/MLB/category/${parent}`);
    const content: any[] = hl?.content ?? []; sTotal = content.length;
    await pool(content, 10, async (h: any) => {
      const w = 21 - h.position; swTotal += w;
      if (h.type !== "PRODUCT") return;
      const o = await offers(h.id); const leaf = o.items[0]?.category_id; if (!leaf) return;
      const lc = await cat(leaf); if (!lc) return;
      const ch = childOf(lc.path, parent); if (!ch || !ids.has(ch)) return;
      sw[ch] = (sw[ch] ?? 0) + w; sMapped++;
    });
  }

  // concorrência e produtos: top 3 de catálogo de cada filho
  const comp = await pool(children, 6, async (c) => {
    const hl = await ok(`/highlights/MLB/category/${c.id}`);
    const prods = (hl?.content ?? []).filter((x: any) => x.type === "PRODUCT").slice(0, 3);
    const cards = (await pool(prods, 3, (x: any) => productCard(x.id))).filter(Boolean) as any[];
    return { has_hl: !!hl, cards };
  });

  const totalSupply = details.reduce((a, d) => a + (d?.total ?? 0), 0) || 1;
  let rows = children.map((c, i) => {
    const d = details[i]; const cp = comp[i] ?? { has_hl: false, cards: [] };
    const supply = ((d?.total ?? 0) / totalSupply) * 100;
    const search = twTotal ? ((tw[c.id] ?? 0) / twTotal) * 100 : null;
    const sales = swTotal && parent !== "ROOT" ? ((sw[c.id] ?? 0) / swTotal) * 100 : null;
    const dem = [search, sales].filter((x) => x != null) as number[];
    const demand = dem.length ? dem.reduce((a, b) => a + b, 0) / dem.length : 0;
    const opp = supply >= 0.5 ? Math.min(demand / supply, 10) : null;
    return {
      category_id: c.id, name: c.name, total_items: d?.total ?? null, children: d?.children?.length ?? 0,
      supply_share: round(supply), search_share: search == null ? null : round(search), sales_share: sales == null ? null : round(sales), opportunity: opp == null ? null : round(opp),
      median_offers: median(cp.cards.map((x: any) => x.offers)), median_price: median(cp.cards.map((x: any) => x.median_price)),
      full_pct: median(cp.cards.map((x: any) => x.full_pct)), top_terms: (terms[c.id] ?? []).slice(0, 6),
      top_products: cp.cards.map((x: any) => ({ id: x.id, name: x.name, offers: x.offers, median_price: x.median_price, full_pct: x.full_pct })),
      _demand: demand,
    } as any;
  });
  const maxD = Math.max(...rows.map((r) => r._demand), 0.0001);
  for (const r of rows) {
    const d = r._demand / maxD;
    const o = r.opportunity == null ? 0 : Math.min(r.opportunity, 5) / 5;
    const c = r.median_offers == null ? 0.5 : 1 - Math.min(r.median_offers, 60) / 60;
    const p = r.median_price == null ? 0.5 : r.median_price >= 79 ? 1 : r.median_price >= 30 ? 0.6 : 0.3;
    r.score = Math.round(100 * (0.5 * d + 0.2 * o + 0.2 * c + 0.1 * p));
    r.tier = r.score >= 65 ? "Quente" : r.score >= 40 ? "Morno" : "Frio";
    delete r._demand;
  }
  rows.sort((a, b) => b.score - a.score);
  for (const r of rows) {
    await sql`insert into radar.niche_stats (parent_id, category_id, name, total_items, children, supply_share, search_share, sales_share, opportunity, median_offers, median_price, full_pct, score, tier, top_terms, top_products, captured_at)
      values (${parent}, ${r.category_id}, ${r.name}, ${r.total_items}, ${r.children}, ${r.supply_share}, ${r.search_share}, ${r.sales_share}, ${r.opportunity}, ${r.median_offers}, ${r.median_price}, ${r.full_pct}, ${r.score}, ${r.tier}, ${sql.json(r.top_terms)}, ${sql.json(r.top_products)}, now())
      on conflict (parent_id, category_id, captured_on) do update set name = excluded.name, total_items = excluded.total_items, children = excluded.children, supply_share = excluded.supply_share, search_share = excluded.search_share, sales_share = excluded.sales_share, opportunity = excluded.opportunity, median_offers = excluded.median_offers, median_price = excluded.median_price, full_pct = excluded.full_pct, score = excluded.score, tier = excluded.tier, top_terms = excluded.top_terms, top_products = excluded.top_products, captured_at = now()`;
  }
  const meta = { trends_total: trends.length, trends_mapped: tMapped, sales_total: sTotal, sales_mapped: sMapped };
  await sql`insert into radar.config (k, v) values (${"niches_meta:" + parent}, ${JSON.stringify(meta)}) on conflict (k) do update set v = excluded.v`;
  const saved = await sql`select * from radar.niche_stats where parent_id = ${parent} and captured_on = current_date order by score desc nulls last`;
  return await nichesPayload(parent, saved, false);
}
const round = (x: number) => Math.round(x * 100) / 100;
async function nichesPayload(parent: string, rows: any[], cached: boolean) {
  const prev = await sql`select distinct on (category_id) category_id, total_items, score, captured_on from radar.niche_stats where parent_id = ${parent} and captured_on < current_date order by category_id, captured_on desc`;
  const pm = new Map(prev.map((p: any) => [p.category_id, p]));
  const metaRow = await sql`select v from radar.config where k = ${"niches_meta:" + parent}`;
  const p = parent === "ROOT" ? { id: "ROOT", name: "Todas as categorias", pathNames: [] } : await cat(parent);
  const num = (v: any) => (v == null ? null : Number(v));
  return {
    parent: { id: parent, name: p?.name ?? parent, path: p?.pathNames ?? [] }, cached,
    captured_at: rows[0]?.captured_at ?? null, meta: metaRow[0] ? JSON.parse(metaRow[0].v) : null,
    rows: rows.map((r: any) => {
      const pv: any = pm.get(r.category_id);
      return { category_id: r.category_id, name: r.name, total_items: num(r.total_items), children: r.children, supply_share: num(r.supply_share), search_share: num(r.search_share), sales_share: num(r.sales_share), opportunity: num(r.opportunity), median_offers: num(r.median_offers), median_price: num(r.median_price), full_pct: num(r.full_pct), score: r.score, tier: r.tier, top_terms: r.top_terms ?? [], top_products: r.top_products ?? [],
        prev: pv ? { score: pv.score, total_items: num(pv.total_items), day: pv.captured_on } : null };
    }),
  };
}

/* ---------- top 20 de um nicho ---------- */
async function routeNiche(catId: string) {
  const [c, hl, tr] = await Promise.all([cat(catId), ml(`/highlights/MLB/category/${catId}`), ok(`/trends/MLB/${catId}`)]);
  if (!c) return { error: "categoria não encontrada" };
  const content: any[] = hl.status === 200 ? (hl.body.content ?? []) : [];
  const cards = await pool(content.slice(0, 20), 6, async (h: any) => {
    if (h.type === "PRODUCT") { const card = await productCard(h.id); return card ? { position: h.position, type: h.type, ...card } : { position: h.position, type: h.type, id: h.id }; }
    return { position: h.position, type: h.type, id: h.id, permalink: `https://www.mercadolivre.com.br/p/${h.id}` };
  });
  for (const x of cards) if (x) await sql`insert into radar.highlights_hist (category_id, rank, ref_id, ref_type, title, price) values (${catId}, ${x.position}, ${x.id}, ${x.type}, ${x.name ?? null}, ${x.median_price ?? x.min_price ?? null}) on conflict do nothing`;
  const prev = await sql`select ref_id, count(distinct captured_on) as days from radar.highlights_hist where category_id = ${catId} and captured_on < current_date group by ref_id`;
  const pm = new Map(prev.map((r: any) => [r.ref_id, r]));
  const yest = await sql`select ref_id, rank from radar.highlights_hist where category_id = ${catId} and captured_on = (select max(captured_on) from radar.highlights_hist where category_id = ${catId} and captured_on < current_date)`;
  const ym = new Map(yest.map((r: any) => [r.ref_id, r.rank]));
  const out = cards.filter(Boolean).map((x: any) => ({ ...x, prev_rank: ym.get(x.id) ?? null, days_in_top: Number(pm.get(x.id)?.days ?? 0) }));
  return {
    category: { id: c.id, name: c.name, path: c.pathNames, children: c.children, total_items: c.total },
    highlights_status: hl.status, top: out, trends: (tr ?? []).slice(0, 20).map((t: any) => t.keyword),
    summary: { median_price: median(out.map((x: any) => x.median_price ?? x.min_price)), median_offers: median(out.map((x: any) => x.offers)), median_full_pct: median(out.map((x: any) => x.full_pct)), tracked_days: Number((await sql`select count(distinct captured_on) n from radar.highlights_hist where category_id = ${catId}`)[0].n) },
  };
}

async function routeSearch(q: string) {
  const enc = encodeURIComponent(q);
  const [ps, dd] = await Promise.all([ok(`/products/search?status=active&site_id=MLB&q=${enc}&limit=20`), ok(`/sites/MLB/domain_discovery/search?q=${enc}&limit=3`)]);
  const ids = (ps?.results ?? []).map((r: any) => r.id);
  const cards = (await pool(ids, 6, productCard)).filter(Boolean);
  cards.sort((a: any, b: any) => (b.offers ?? 0) - (a.offers ?? 0));
  const c0 = dd?.[0]?.category_id;
  const tr = c0 ? await ok(`/trends/MLB/${c0}`) : null;
  return { query: q, total_catalog: ps?.paging?.total ?? 0, categories: (dd ?? []).map((d: any) => ({ id: d.category_id, name: d.category_name, domain: d.domain_name })), products: cards, related_trends: (tr ?? []).slice(0, 12).map((t: any) => t.keyword) };
}

async function routeProduct(id: string) {
  const [p, o] = await Promise.all([ok(`/products/${id}`), offers(id, 100)]);
  if (!p) return { error: "produto não encontrado" };
  const sellerIds = [...new Set(o.items.map((x: any) => x.seller_id))].slice(0, 25);
  const users = await pool(sellerIds, 8, (s) => ok(`/users/${s}`));
  const um = new Map(users.filter(Boolean).map((u: any) => [u.id, { nickname: u.nickname, level: u.seller_reputation?.level_id ?? null, power: u.seller_reputation?.power_seller_status ?? null, sales_total: u.seller_reputation?.transactions?.total ?? null, city: u.address?.city ?? null, state: u.address?.state ?? null }]));
  const list = o.items.map((x: any, i: number) => ({ rank: i + 1, item_id: x.item_id, price: x.price, original_price: x.original_price, seller_id: x.seller_id, seller: um.get(x.seller_id) ?? null, listing_type: x.listing_type_id === "gold_pro" ? "Premium" : x.listing_type_id === "gold_special" ? "Clássico" : x.listing_type_id, full: x.shipping?.logistic_type === "fulfillment", free_shipping: !!x.shipping?.free_shipping, official_store: !!x.official_store_id, category_id: x.category_id }));
  for (const x of list.slice(0, 50)) await sql`insert into radar.item_snapshots (item_id, source, query, position, title, price, original_price, seller_id, seller_name, listing_type, full_fulfillment, free_shipping, category_id) values (${x.item_id}, 'product', ${id}, ${x.rank}, ${p.name}, ${x.price}, ${x.original_price}, ${x.seller_id}, ${x.seller?.nickname ?? null}, ${x.listing_type}, ${x.full}, ${x.free_shipping}, ${x.category_id})`;
  const hist = await sql`select date_trunc('day', captured_at)::date d, min(price) mn, percentile_cont(0.5) within group (order by price) md, count(distinct seller_id) sellers from radar.item_snapshots where query = ${id} group by 1 order by 1`;
  const attrs = (p.attributes ?? []).slice(0, 12).map((a: any) => ({ name: a.name, value: a.value_name }));
  return { id, name: p.name, picture: p.pictures?.[0]?.url ?? null, permalink: p.permalink || `https://www.mercadolivre.com.br/p/${id}`, category_id: list[0]?.category_id, attributes: attrs, stats: offerStats(o), offers: list, history: hist.map((h: any) => ({ day: h.d, min: Number(h.mn), median: Number(h.md), sellers: Number(h.sellers) })) };
}

async function routeFees(price: string, catId: string) {
  const r = await ok(`/sites/MLB/listing_prices?price=${encodeURIComponent(price)}&category_id=${encodeURIComponent(catId)}`);
  return (r ?? []).filter((x: any) => ["gold_special", "gold_pro"].includes(x.listing_type_id)).map((x: any) => ({ type: x.listing_type_name, percent: x.sale_fee_details?.percentage_fee, fixed: x.sale_fee_details?.fixed_fee, total: x.sale_fee_amount }));
}

async function routeAccount() {
  const me = await ok("/users/me");
  if (!me) return { error: "conta não vinculada" };
  const ids: string[] = [];
  for (let off = 0; off < 200; off += 50) { const s = await ok(`/users/${me.id}/items/search?limit=50&offset=${off}`); if (!s?.results?.length) break; ids.push(...s.results); if (ids.length >= (s.paging?.total ?? 0)) break; }
  const chunks: string[][] = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const got = (await pool(chunks, 4, (c) => ok(`/items?ids=${c.join(",")}&attributes=id,title,price,sold_quantity,available_quantity,status,thumbnail,permalink,listing_type_id,date_created,category_id`))).flat().filter(Boolean).map((x: any) => x.body).filter((b: any) => b?.id);
  const vis = await pool(ids, 8, (id) => ok(`/visits/items?ids=${id}`));
  const vm: Record<string, number> = {}; for (const v of vis) if (v && typeof v === "object") Object.assign(vm, v);
  const items = got.map((x: any) => ({ id: x.id, title: x.title, price: x.price, sold: x.sold_quantity, stock: x.available_quantity, status: x.status, thumbnail: x.thumbnail, permalink: x.permalink, listing_type: x.listing_type_id === "gold_pro" ? "Premium" : "Clássico", created: x.date_created, category_id: x.category_id, visits: vm[x.id] ?? null, conversion: vm[x.id] ? Math.round((x.sold_quantity / vm[x.id]) * 1000) / 10 : null }));
  const orders = await ok(`/orders/search?seller=${me.id}&sort=date_desc&limit=50`);
  const os = (orders?.results ?? []).map((o: any) => ({ id: o.id, date: o.date_created, status: o.status, total: o.total_amount, items: (o.order_items ?? []).map((i: any) => i.item?.title).join(", ") }));
  const rep = me.seller_reputation ?? {};
  return { account: { id: me.id, nickname: me.nickname, permalink: me.permalink, level: rep.level_id ?? null, power: rep.power_seller_status ?? null, transactions: rep.transactions ?? null, metrics: rep.metrics ?? null }, items, orders: os, orders_total: orders?.paging?.total ?? 0 };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*?\/ml/, "") || "/";
  const qp = (k: string) => url.searchParams.get(k) ?? "";
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    if (route === "/login") {
      if (qp("k") !== await key()) return text("Link inválido", 403);
      const state = crypto.randomUUID();
      await sql`insert into radar.oauth_state (state) values (${state})`;
      const auth = new URL("https://auth.mercadolivre.com.br/authorization");
      auth.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, state }).toString();
      return Response.redirect(auth.toString(), 302);
    }
    if (route === "/callback") {
      const code = qp("code"), state = qp("state");
      const okk = await sql`delete from radar.oauth_state where state = ${state} and created_at > now() - interval '15 minutes' returning state`;
      if (!code || !okk.length) return text("Vínculo expirado. Gere o link de novo.", 400);
      await saveToken(await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }));
      const n = await sql`select nickname from radar.ml_tokens where id = 1`;
      return text(`Conta vinculada: ${n[0]?.nickname ?? "ok"}. Pode fechar esta aba.`);
    }
    if (req.headers.get("x-radar-key") !== await key()) return json({ error: "não autorizado" }, 401);

    if (route === "/status") { const r = await sql`select user_id, nickname, expires_at, updated_at from radar.ml_tokens where id = 1`; return json({ linked: !!r.length, account: r[0] ?? null, secret: !!Deno.env.get("ML_CLIENT_SECRET") }); }
    if (route === "/niches") { const c = qp("cat") || "ROOT"; if (c !== "ROOT" && !/^MLB\d+$/.test(c)) return json({ error: "categoria inválida" }, 400); return json(await routeNiches(c, qp("fresh") === "1")); }
    if (route === "/niche") return json(await routeNiche(qp("cat")));
    if (route === "/search") return json(await routeSearch(qp("q")));
    if (route === "/product") return json(await routeProduct(qp("id")));
    if (route === "/fees") return json(await routeFees(qp("price"), qp("cat")));
    if (route === "/account") return json(await routeAccount());
    if (route === "/categories") { const id = qp("id"); return json(id ? await ok(`/categories/${id}`) : await ok("/sites/MLB/categories")); }

    if (route === "/" && req.method === "GET") {
      const path = qp("path");
      if (!path.startsWith("/") || path.includes("..") || path.startsWith("/oauth")) return json({ error: "path inválido" }, 400);
      const r = await ml(path); return json(r.body, r.status);
    }
    if (route === "/ingest" && req.method === "POST") {
      const b = await req.json();
      const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
      for (const it of items) await sql`insert into radar.item_snapshots (item_id, source, query, position, title, price, original_price, sold_label, sold_min, seller_id, seller_name, listing_type, full_fulfillment, free_shipping, category_id, permalink, thumbnail) values (${it.item_id}, ${b.source ?? "ext"}, ${b.query ?? null}, ${it.position ?? null}, ${it.title ?? null}, ${it.price ?? null}, ${it.original_price ?? null}, ${it.sold_label ?? null}, ${it.sold_min ?? null}, ${it.seller_id ?? null}, ${it.seller_name ?? null}, ${it.listing_type ?? null}, ${it.full ?? null}, ${it.free_shipping ?? null}, ${it.category_id ?? null}, ${it.permalink ?? null}, ${it.thumbnail ?? null})`;
      const gb = Array.isArray(b.goboox) ? b.goboox.slice(0, 500) : [];
      for (const g of gb) await sql`insert into radar.goboox_products (sku, title, cost, stock, category, image, url, captured_at) values (${g.sku}, ${g.title ?? null}, ${g.cost ?? null}, ${g.stock ?? null}, ${g.category ?? null}, ${g.image ?? null}, ${g.url ?? null}, now()) on conflict (sku) do update set title = excluded.title, cost = excluded.cost, stock = excluded.stock, category = excluded.category, image = excluded.image, url = excluded.url, captured_at = now()`;
      return json({ ok: true, items: items.length, goboox: gb.length });
    }
    return json({ error: "rota não encontrada" }, 404);
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
});
