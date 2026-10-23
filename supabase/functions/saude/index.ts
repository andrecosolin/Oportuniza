import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CLIENT_ID = "2244190709439067";
const API = "https://api.mercadolibre.com";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-radar-key, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors } });

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

/* custo real de envio que o ML cobra desta conta (por peso/dimensão e faixa de preço) */
const SHIPC = new Map<string, number>();
let ME_ID: string | null = null;
async function meId() { if (!ME_ID) { const r = await sql`select user_id from radar.ml_tokens where id = 1`; ME_ID = r[0]?.user_id ? String(r[0].user_id) : null; } return ME_ID; }
async function shipReal(ref: string, price: number): Promise<number | null> {
  const p = Math.round(price * 100) / 100; const k = `${ref}|${p}`;
  if (SHIPC.has(k)) return SHIPC.get(k)!;
  const c = await sql`select cost from radar.ship_cache where k = ${k} and at > now() - interval '3 days'`;
  if (c.length) { const v = Number(c[0].cost); SHIPC.set(k, v); return v; }
  const uid = await meId(); if (!uid) return null;
  const q = ref.startsWith("item:") ? `item_id=${ref.slice(5)}` : `dimensions=${ref.slice(4)}&listing_type_id=gold_special&mode=me2&condition=new&logistic_type=drop_off`;
  const r = await ok(`/users/${uid}/shipping_options/free?${q}&item_price=${p}`);
  const v = r?.coverage?.all_country?.list_cost; if (v == null) return null;
  SHIPC.set(k, Number(v));
  await sql`insert into radar.ship_cache (k, price, cost, billable_weight) values (${k}, ${p}, ${v}, ${r.coverage.all_country.billable_weight ?? null}) on conflict (k) do update set cost = excluded.cost, billable_weight = excluded.billable_weight, at = now()`;
  return Number(v);
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null as R; } } }));
  return out;
}
const median = (a: number[]) => { a = a.filter((x) => x != null && !isNaN(x)); if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };


/* ---------- base comum ---------- */
const r2 = (x: number) => Math.round(x * 100) / 100;
const FEE = new Map<string, any>();
async function feeFor(price: number, catId: string, type = "gold_special") {
  const p = r2(price); const k = `${p}|${catId}|${type}`; if (FEE.has(k)) return FEE.get(k);
  const r = await ok(`/sites/MLB/listing_prices?price=${p}&category_id=${catId}&listing_type_id=${type}`);
  const o = Array.isArray(r) ? r[0] : r;
  const v = { pct: o?.sale_fee_details?.percentage_fee ?? null, amount: o?.sale_fee_amount ?? null };
  FEE.set(k, v); return v;
}
async function settings() { const S: Record<string, number> = {}; for (const r of await sql`select k, v from radar.settings`) S[r.k] = Number(r.v); S.target_margin_pct ??= 20; return S; }
const norm = (s: string) => String(s ?? "").trim().toUpperCase().replace(/^GBX-/, "");
const shipEst = (p: number, S: any) => p >= 79 ? S.ship_free_79 : S.ship_below_79;
// envio no preço p: valor digitado > custo real do ML para este anúncio (ou dimensão padrão) > estimativa das configurações
async function shipAt(ref: string, p: number, S: any, override: number | null) {
  if (override != null) return override;
  return (await shipReal(ref, p)) ?? shipEst(p, S);
}
// menor preço p com p*(1 - tarifa% - imposto% - alvo%) >= custo + extras + envio(p); o envio sobe por faixa de preço, então itera a partir da faixa mais barata
async function solvePrice(cost: number, extra: number, feePct: number, S: any, override: number | null, targetPct: number, ref: string) {
  const den = 1 - feePct / 100 - (S.tax_pct ?? 0) / 100 - targetPct / 100;
  if (den <= 0.05) return null;
  let p = (cost + extra + (await shipAt(ref, 1, S, override))) / den;
  for (let i = 0; i < 8; i++) {
    const q = (cost + extra + (await shipAt(ref, Math.ceil(p * 100) / 100, S, override))) / den;
    if (Math.abs(q - p) < 0.005) { p = q; break; }
    p = Math.max(p, q);
  }
  return Math.ceil(p * 100) / 100;
}
const pretty = (p: number) => { const x = Math.ceil(p) - 0.1; return r2(x >= p ? x : Math.ceil(p) + 0.9); };

/* preço de mercado: produto de catálogo parecido e seus vendedores */
const STOP = new Set("de da do das dos com para por em e a o as os um uma kit cor".split(" "));
function queryFrom(title: string) {
  return String(title).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w.toLowerCase())).slice(0, 6).join(" ");
}
function toks(s: string) { return new Set(String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w))); }
function sim(a: string, b: string) { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((w) => { if (B.has(w)) n++; }); return 2 * n / (A.size + B.size); }
async function offersOf(pid: string) {
  const r = await ok(`/products/${pid}/items?limit=50`);
  const items = r?.results ?? [];
  const prices = items.map((x: any) => Number(x.price)).filter((x: number) => x > 0);
  return { total: r?.paging?.total ?? items.length, prices, full: items.filter((x: any) => x.shipping?.logistic_type === "fulfillment").length, n: items.length, category_id: items[0]?.category_id ?? null };
}
async function market(key: string, title: string, catalogId: string | null, fresh = false) {
  if (!fresh) { const c = await sql`select * from radar.market_cache where key = ${key} and captured_at > now() - interval '20 hours'`; if (c.length) return c[0].product_id ? c[0] : null; }
  let best: any = null;
  const tryProduct = async (pid: string, name: string, simv: number | null = null) => {
    const o = await offersOf(pid); if (!o.prices.length) return false;
    best = { similarity: simv, product_id: pid, product_name: name, median_price: median(o.prices), min_price: Math.min(...o.prices), max_price: Math.max(...o.prices), sellers: o.total, full_pct: Math.round(o.full / o.n * 100), category_id: o.category_id };
    return true;
  };
  if (catalogId) { const p = await ok(`/products/${catalogId}`); if (p) await tryProduct(catalogId, p.name, 1); }
  if (!best) {
    const s = await ok(`/products/search?status=active&site_id=MLB&q=${encodeURIComponent(queryFrom(title))}&limit=6`);
    const cands = (s?.results ?? []).map((r: any) => ({ id: r.id, name: r.name, s: sim(title, r.name) })).filter((c: any) => c.s >= 0.45).sort((a: any, b: any) => b.s - a.s).slice(0, 3);
    for (const c of cands) { if (await tryProduct(c.id, c.name, r2(c.s))) break; }
  }
  const b = best ?? {};
  await sql`insert into radar.market_cache (key, similarity, product_id, product_name, median_price, min_price, max_price, sellers, full_pct, category_id, captured_at)
    values (${key}, ${b.similarity ?? null}, ${b.product_id ?? null}, ${b.product_name ?? null}, ${b.median_price ?? null}, ${b.min_price ?? null}, ${b.max_price ?? null}, ${b.sellers ?? null}, ${b.full_pct ?? null}, ${b.category_id ?? null}, now())
    on conflict (key) do update set similarity = excluded.similarity, product_id = excluded.product_id, product_name = excluded.product_name, median_price = excluded.median_price, min_price = excluded.min_price, max_price = excluded.max_price, sellers = excluded.sellers, full_pct = excluded.full_pct, category_id = excluded.category_id, captured_at = now()`;
  return best;
}
const num = (v: any) => (v == null ? null : Number(v));

/* ---------- saúde dos anúncios ---------- */
async function routeHealth(fresh: boolean) {
  const me = await ok("/users/me"); if (!me) return { error: "conta não vinculada" };
  const S = await settings();
  const C = new Map((await sql`select item_id, cost, extra, ship_override from radar.item_costs`).map((r: any) => [r.item_id, r]));
  const SP = await sql`select supplier, sku, gtin, cost, stock, updated_at from radar.supplier_prices where cost is not null order by updated_at desc`;
  const bySku = new Map<string, any>(), byGtin = new Map<string, any>();
  for (const r of SP) { if (!bySku.has(norm(r.sku))) bySku.set(norm(r.sku), r); if (r.gtin && !byGtin.has(String(r.gtin))) byGtin.set(String(r.gtin), r); }
  const ids: string[] = [];
  for (let off = 0; off < 500; off += 50) { const s = await ok(`/users/${me.id}/items/search?limit=50&offset=${off}`); if (!s?.results?.length) break; ids.push(...s.results); if (ids.length >= (s.paging?.total ?? 0)) break; }
  const chunks: string[][] = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const attr = (x: any, id: string) => (x.attributes ?? []).find((a: any) => a.id === id)?.value_name ?? null;
  const items = (await pool(chunks, 4, (c) => ok(`/items?ids=${c.join(",")}&attributes=id,title,price,sold_quantity,available_quantity,status,permalink,listing_type_id,category_id,date_created,catalog_product_id,attributes`))).flat().filter(Boolean).map((x: any) => x.body).filter((b: any) => b?.id);

  // vendas dos últimos 30 dias por anúncio
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19) + ".000-00:00";
  const sold30: Record<string, number> = {};
  for (let off = 0; off < 1000; off += 50) {
    const s = await ok(`/orders/search?seller=${me.id}&order.date_created.from=${encodeURIComponent(from)}&order.status=paid&limit=50&offset=${off}`);
    for (const o of s?.results ?? []) for (const oi of o.order_items ?? []) sold30[oi.item?.id] = (sold30[oi.item?.id] ?? 0) + Number(oi.quantity ?? 1);
    if (!s?.results?.length || off + 50 >= (s.paging?.total ?? 0)) break;
  }

  const rows = await pool(items, 6, async (x: any) => {
    const sku = attr(x, "SELLER_SKU"), gtin = attr(x, "GTIN");
    const c: any = C.get(x.id);
    const sp = (sku && bySku.get(norm(sku))) || (gtin && byGtin.get(String(gtin))) || null;
    const cost = c?.cost != null ? Number(c.cost) : sp ? Number(sp.cost) : null;
    const extra = Number(c?.extra ?? 0) + (S.supplier_fee_order ?? 0);
    const override = c?.ship_override != null ? Number(c.ship_override) : null;
    const [fee, vis, mk] = await Promise.all([
      feeFor(x.price, x.category_id, x.listing_type_id),
      ok(`/items/${x.id}/visits/time_window?last=30&unit=day`),
      market("item:" + x.id, x.title, x.catalog_product_id ?? null, fresh),
    ]);
    const days = (vis?.results ?? []) as any[];
    const v30 = Number(vis?.total_visits ?? 0);
    const cut7 = Date.now() - 7 * 86400000;
    const v7 = days.filter((d) => new Date(d.date).getTime() >= cut7).reduce((a, d) => a + Number(d.total ?? 0), 0);
    const s30 = sold30[x.id] ?? 0;
    const conv = v30 > 0 ? r2(s30 / v30 * 100) : null;
    const age = Math.floor((Date.now() - new Date(x.date_created).getTime()) / 86400000);
    const ref = "item:" + x.id;
    const ship = await shipAt(ref, x.price, S, override);
    const feeAmt = fee.amount ?? (fee.pct != null ? x.price * fee.pct / 100 : 0);
    const margin = cost == null ? null : r2(x.price - feeAmt - ship - x.price * (S.tax_pct ?? 0) / 100 - cost - extra);
    const mpct = margin == null ? null : r2(margin / x.price * 100);
    const pmin = cost == null || fee.pct == null ? null : await solvePrice(cost, extra, fee.pct, S, override, 0, ref);
    const pideal = cost == null || fee.pct == null ? null : await solvePrice(cost, extra, fee.pct, S, override, S.target_margin_pct, ref);
    const mmed = num(mk?.median_price), mmin = num(mk?.min_price), mmax = num(mk?.max_price);
    const supStock = sp?.stock == null ? null : Number(sp.stock);

    const mmedShip = mmed != null ? await shipAt(ref, mmed, S, override) : 0;
    // recomendação
    const reasons: string[] = []; let action = "Manter"; let suggested: number | null = null;
    if (cost == null) { action = "Sem custo"; reasons.push("Cadastre o custo para o Radar avaliar este anúncio."); }
    else if (supStock != null && supStock <= 0) { action = "Pausar"; reasons.push("O fornecedor está sem estoque: uma venda agora vira pedido que você não consegue entregar."); }
    else if (margin! < 0) {
      if (mmax != null && pmin != null && pmin > mmax * 1.05) { action = "Pausar"; reasons.push(`Dá prejuízo de ${brl(-margin!)} por venda e nem o preço mínimo (${brl(pmin)}) fica abaixo do mais caro do mercado (${brl(mmax)}).`); }
      else { action = "Ajustar preço"; suggested = pmin != null ? pretty(pmin) : null; reasons.push(`Dá prejuízo de ${brl(-margin!)} por venda. Preço mínimo sem prejuízo: ${brl(pmin)}.`); }
    } else if (mmed != null && Number(mk?.sellers ?? 0) >= 2 && x.price > mmed * 1.2 && pmin != null && mmed >= pmin) { action = "Ajustar preço"; suggested = pretty(Math.max(mmed, pmin)); reasons.push(`Seu preço está ${Math.round((x.price / mmed - 1) * 100)}% acima do mediano do mercado (${brl(mmed)}). Nesse preço ainda sobra ${brl(r2(mmed - mmed * (fee.pct ?? 0) / 100 - mmedShip - mmed * (S.tax_pct ?? 0) / 100 - cost! - extra))} por venda.`); }
    else if (age < 7) { action = "Aguardar"; reasons.push(`Anúncio com ${age} dia(s): o ML ainda está distribuindo. Avalie depois de 7 dias.`); }
    else if (v30 >= 30 && (conv ?? 0) < 1) { action = "Ajustar anúncio"; reasons.push(`${v30} visitas e ${s30} venda(s) em 30 dias: o anúncio atrai mas não convence. Revise fotos, título, descrição e preço.`); if (mmed != null && x.price > mmed * 1.1 && pmin != null && mmed >= pmin) { suggested = pretty(Math.max(mmed, pmin)); reasons.push(`Seu preço está acima do mediano do mercado (${brl(mmed)}).`); } }
    else if (age >= 14 && v30 < 15) { action = "Ajustar anúncio"; reasons.push(`Só ${v30} visita(s) em 30 dias: pouca exposição. Melhore o título com as palavras que o comprador busca, confira a categoria ou teste Ads.`); }
    else if (s30 >= 3 && (conv ?? 0) >= 2 && (mpct ?? 0) >= 15) { action = "Escalar"; reasons.push(`Vende bem (${s30} em 30 dias, conversão ${conv}%) com boa margem: aumente estoque, teste Premium ou Ads.`); }
    else if ((mpct ?? 0) < 8) { action = "Manter"; reasons.push(`Margem baixa (${mpct}%): serve como isca para as primeiras vendas, mas não sustenta a loja.`); }
    else reasons.push("Sem problemas encontrados.");
    if (action === "Aguardar" && mpct != null && mpct < 8) reasons.push(`Margem baixa (${mpct}%): funciona como isca, não como lucro.`);
    if (action !== "Pausar" && supStock != null && supStock > 0 && supStock < 5) reasons.push(`Atenção: só ${supStock} unidade(s) no fornecedor.`);
    if (mmin != null && Number(mk?.sellers ?? 0) >= 2 && margin != null && x.price > mmin * 1.5 && (action === "Manter" || action === "Aguardar")) reasons.push(`Há vendedor anunciando por ${brl(mmin)}.`);

    // nota de potencial 0 a 100
    const sMargin = mpct == null ? 0 : Math.max(0, Math.min(mpct, 40)) / 40;
    const sComp = mk?.sellers == null || Number(mk.sellers) < 2 ? 0.5 : 1 - Math.min(Number(mk.sellers), 60) / 60;
    const sPrice = mmed == null || Number(mk?.sellers ?? 0) < 2 ? 0.5 : x.price <= mmed ? 1 : Math.max(0, 1 - (x.price / mmed - 1) * 2);
    const sTrac = age < 7 ? 0.5 : conv == null ? (v30 > 0 ? 0.3 : 0.1) : Math.min(conv / 4, 1);
    const score = cost == null ? null : Math.round(100 * (0.35 * sMargin + 0.2 * sComp + 0.2 * sPrice + 0.25 * sTrac));

    return { id: x.id, title: x.title, permalink: x.permalink, status_ml: x.status, price: x.price, age_days: age, visits_30: v30, visits_7: v7, sold_30: s30, sold_total: x.sold_quantity, conversion: conv,
      cost, fee_pct: fee.pct, ship: r2(ship), margin, margin_pct: mpct, price_min: pmin, price_ideal: pideal, supplier_stock: supStock,
      market: mk ? { similarity: num(mk.similarity), product_id: mk.product_id, name: mk.product_name, median: mmed, min: mmin, max: mmax, sellers: num(mk.sellers), full_pct: num(mk.full_pct) } : null,
      action, suggested_price: suggested, reasons, score };
  });
  const list = rows.filter(Boolean) as any[];
  const order: Record<string, number> = { "Pausar": 0, "Ajustar preço": 1, "Ajustar anúncio": 2, "Sem custo": 3, "Aguardar": 4, "Manter": 5, "Escalar": 6 };
  list.sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9) || (a.score ?? 0) - (b.score ?? 0));
  const count: Record<string, number> = {}; for (const r of list) count[r.action] = (count[r.action] ?? 0) + 1;
  return { settings: { target_margin_pct: S.target_margin_pct }, count, visits_30_total: list.reduce((a, r) => a + r.visits_30, 0), sold_30_total: list.reduce((a, r) => a + r.sold_30, 0), items: list, generated_at: new Date().toISOString() };
}
const brl = (v: number | null) => v == null ? "—" : "R$ " + Number(v).toFixed(2).replace(".", ",");

/* ---------- oportunidades do fornecedor ---------- */
async function routeOpps(supplier: string, offset: number, limit: number, fresh: boolean) {
  const me = await ok("/users/me"); if (!me) return { error: "conta não vinculada" };
  const S = await settings();
  const ids: string[] = [];
  for (let off = 0; off < 500; off += 50) { const s = await ok(`/users/${me.id}/items/search?limit=50&offset=${off}`); if (!s?.results?.length) break; ids.push(...s.results); if (ids.length >= (s.paging?.total ?? 0)) break; }
  const chunks: string[][] = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const listed = new Set<string>();
  for (const c of chunks) { const r = await ok(`/items?ids=${c.join(",")}&attributes=id,attributes`); for (const x of r ?? []) { const a = (x.body?.attributes ?? []).find((a: any) => a.id === "SELLER_SKU")?.value_name; if (a) listed.add(norm(a)); } }
  const all = (await sql`select sku, title, cost, stock from radar.supplier_prices where supplier = ${supplier} and cost is not null order by sku`).filter((r: any) => !listed.has(norm(r.sku)));
  const batch = all.slice(offset, offset + limit);
  await pool(batch, 5, async (r: any) => {
    if (!fresh) { const c = await sql`select 1 from radar.supplier_eval where supplier = ${supplier} and sku = ${r.sku} and captured_on = current_date`; if (c.length) return; }
    const cost = Number(r.cost), stock = r.stock == null ? null : Number(r.stock), extra = S.supplier_fee_order ?? 0;
    const mk = await market("sup:" + supplier + ":" + r.sku, r.title, null, fresh);
    let confidence: string | null = null; let verdict = "Sem referência", reason = "Não achei produto parecido no catálogo do ML para comparar o preço.", feePct: number | null = null, pmin = null, pideal = null, mAt = null, mPct = null, score = 0;
    if (mk?.median_price) {
      const med = Number(mk.median_price);
      const fee = mk.category_id ? await feeFor(med, mk.category_id) : { pct: 13, amount: null };
      feePct = fee.pct ?? 13;
      const feeAmt = fee.amount ?? med * feePct! / 100;
      const DIM = "dim:15x10x5,300";
      mAt = r2(med - feeAmt - (await shipAt(DIM, med, S, null)) - med * (S.tax_pct ?? 0) / 100 - cost - extra);
      mPct = r2(mAt / med * 100);
      pmin = await solvePrice(cost, extra, feePct!, S, null, 0, DIM); pideal = await solvePrice(cost, extra, feePct!, S, null, S.target_margin_pct, DIM);
      const sellers = Number(mk.sellers ?? 0);
      const simv = mk.similarity == null ? null : Number(mk.similarity);
      confidence = sellers >= 5 && (simv == null || simv >= 0.6) && med <= cost * 6 ? "alta" : sellers >= 3 && med <= cost * 8 ? "média" : "baixa";
      if (mPct >= S.target_margin_pct * 0.75) { verdict = "Anunciar"; reason = `No preço mediano do mercado (${brl(med)}) sobra ${brl(mAt)} por venda (${mPct}%).`; }
      else if (mPct >= 5) { verdict = "Avaliar"; reason = `No preço do mercado (${brl(med)}) sobra só ${brl(mAt)} (${mPct}%): dá como isca ou em kit.`; }
      else { verdict = "Não compensa"; reason = mAt < 0 ? `No preço do mercado (${brl(med)}) daria prejuízo de ${brl(-mAt)}. Preço mínimo seria ${brl(pmin)}.` : `Margem de só ${mPct}% no preço do mercado.`; }
      if (confidence === "baixa" && verdict === "Anunciar") { verdict = "Conferir"; reason = `Parece lucrativo, mas a comparação é fraca (${sellers} vendedor(es), produto comparado: “${mk.product_name}”). Confira se é o mesmo produto. ` + reason; }
      if (sellers > 40) reason += ` Muito disputado (${sellers} vendedores).`;
      else if (sellers <= 5) reason += ` Pouca concorrência (${sellers} vendedores).`;
      if (stock != null && stock < 5) reason += ` Estoque baixo no fornecedor (${stock}).`;
      const sM = Math.max(0, Math.min(mPct, 40)) / 40, sC = 1 - Math.min(sellers, 60) / 60, sS = stock == null ? 0.5 : Math.min(stock, 50) / 50;
      score = Math.round(100 * (0.6 * sM + 0.25 * sC + 0.15 * sS) * (confidence === "baixa" ? 0.6 : confidence === "média" ? 0.85 : 1));
    }
    await sql`insert into radar.supplier_eval (supplier, sku, title, cost, stock, product_id, product_name, market_median, market_min, sellers, fee_pct, price_min, price_ideal, margin_at_market, margin_pct_at_market, score, verdict, reason, confidence, captured_at)
      values (${supplier}, ${r.sku}, ${r.title}, ${cost}, ${stock}, ${mk?.product_id ?? null}, ${mk?.product_name ?? null}, ${mk?.median_price ?? null}, ${mk?.min_price ?? null}, ${mk?.sellers ?? null}, ${feePct}, ${pmin}, ${pideal}, ${mAt}, ${mPct}, ${score}, ${verdict}, ${reason}, ${confidence}, now())
      on conflict (supplier, sku, captured_on) do update set title = excluded.title, cost = excluded.cost, stock = excluded.stock, product_id = excluded.product_id, product_name = excluded.product_name, market_median = excluded.market_median, market_min = excluded.market_min, sellers = excluded.sellers, fee_pct = excluded.fee_pct, price_min = excluded.price_min, price_ideal = excluded.price_ideal, margin_at_market = excluded.margin_at_market, margin_pct_at_market = excluded.margin_pct_at_market, score = excluded.score, verdict = excluded.verdict, reason = excluded.reason, confidence = excluded.confidence, captured_at = now()`;
  });
  const skus = all.map((r: any) => r.sku);
  const done = skus.length ? await sql`select * from radar.supplier_eval where supplier = ${supplier} and captured_on = current_date and sku = any(${skus}) order by score desc nulls last` : [];
  return { supplier, total: all.length, evaluated: done.length, next_offset: offset + limit < all.length ? offset + limit : null,
    items: done.map((d: any) => ({ sku: d.sku, title: d.title, cost: num(d.cost), stock: d.stock, product_id: d.product_id, product_name: d.product_name, market_median: num(d.market_median), market_min: num(d.market_min), sellers: d.sellers, fee_pct: num(d.fee_pct), price_min: num(d.price_min), price_ideal: num(d.price_ideal), margin_at_market: num(d.margin_at_market), margin_pct_at_market: num(d.margin_pct_at_market), score: d.score, verdict: d.verdict, reason: d.reason, confidence: d.confidence })) };
}

/* ---------- produtos candidatos: nota 0 a 100 e recomendação ---------- */
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const SIGNALS: Record<string, [number, string]> = { busca_crescendo: [4, "busca crescendo"], videos_crescendo: [3, "vídeos crescendo"], anuncios_pagos: [3, "anúncios pagos frequentes"], comentarios_compra: [3, "comentários com intenção de compra"], recompra: [3, "recompra"] };
async function routeProd(id: number, fresh: boolean) {
  const P = (await sql`select * from radar.products where id = ${id}`)[0];
  if (!P) return { error: "produto não encontrado" };
  const S = await settings();
  const offers = await sql`select o.*, v.name vendor, v.city, v.uf, v.distance_km, v.nf, v.status vendor_status, v.dropship, v.stock_confirmed_at from radar.product_offers o join radar.vendors v on v.id = o.vendor_id where o.product_id = ${id}`;
  const q = (P.ml_query || P.name) as string;
  const mk: any = await market("prod:" + id + ":" + (P.ml_product_id ?? q), q, P.ml_product_id ?? null, fresh);
  const cat = P.category_id ?? mk?.category_id ?? null;
  const med = mk?.median_price != null ? Number(mk.median_price) : null;
  const sellers = mk?.sellers != null ? Number(mk.sellers) : null;
  const w = P.weight_g ?? null;
  const ref = "dim:" + (P.dims && /^\d+x\d+x\d+$/.test(P.dims) ? P.dims : "15x10x5") + "," + (w ?? 300);
  const notes: string[] = [];

  // economia por fornecedor
  let feePct: number | null = null;
  if (med != null && cat) { const f = await feeFor(med, cat); feePct = f.pct ?? null; }
  feePct ??= 13;
  const shipMed = med != null ? await shipAt(ref, med, S, null) : null;
  const evalOffers: any[] = [];
  for (const o of offers) {
    if (o.cost == null) { evalOffers.push({ vendor_id: o.vendor_id, vendor: o.vendor, cost: null }); continue; }
    const cost = Number(o.cost), extra = S.supplier_fee_order ?? 0;
    const mAt = med == null ? null : r2(med - med * feePct / 100 - shipMed! - med * (S.tax_pct ?? 0) / 100 - cost - extra);
    const pmin = await solvePrice(cost, extra, feePct, S, null, 0, ref);
    const pideal = await solvePrice(cost, extra, feePct, S, null, S.target_margin_pct, ref);
    evalOffers.push({ vendor_id: o.vendor_id, vendor: o.vendor, distance_km: o.distance_km, city: o.city, uf: o.uf, dropship: o.dropship, cost, margin_at_market: mAt, margin_pct: mAt == null ? null : r2(mAt / med! * 100), price_min: pmin, price_ideal: pideal, moq: o.moq, capital_test: o.moq ? r2(o.moq * cost) : null });
  }
  const priced = evalOffers.filter((o) => o.cost != null);
  const best = priced.filter((o) => o.margin_at_market != null).sort((a, b) => b.margin_at_market - a.margin_at_market)[0] ?? priced.sort((a, b) => a.cost - b.cost)[0] ?? null;

  // demanda (30)
  let dem = 0; const demWhy: string[] = [];
  if (cat) {
    const tr = await ok(`/trends/MLB/${cat}`);
    const hit = (Array.isArray(tr) ? tr : []).find((t: any) => sim(q, t.keyword) >= 0.5 || String(t.keyword).toLowerCase().includes(q.toLowerCase()));
    if (hit) { dem += 8; demWhy.push(`aparece nas buscas em alta do ML (“${hit.keyword}”)`); }
    if (P.ml_product_id) {
      const hl = await ok(`/highlights/MLB/category/${cat}`);
      if ((hl?.content ?? []).some((c: any) => c.id === P.ml_product_id)) { dem += 7; demWhy.push("está entre os mais vendidos da categoria"); }
    }
  }
  const words = [...toks(q)].slice(0, 3);
  if (words.length) {
    const pat = "%" + words.join("%") + "%";
    const ext = await sql`select percentile_cont(0.5) within group (order by m) med, count(*)::int n from (select item_id, max(sold_min) m from radar.item_snapshots where source like 'ext%' and captured_at > now() - interval '45 days' and (query ilike ${pat} or title ilike ${pat}) group by item_id order by max(sold_min) desc nulls last limit 10) t`;
    const em = ext[0]?.med != null ? Number(ext[0].med) : null;
    if (em != null && ext[0].n >= 3) { const pts = em >= 1000 ? 10 : em >= 100 ? 7 : em >= 25 ? 4 : 1; dem += pts; demWhy.push(`top anúncios lidos pela extensão vendem ${em >= 1000 ? "+" + Math.round(em / 1000) + " mil" : "+" + Math.round(em)} (mediana)`); }
  }
  if (sellers != null && sellers >= 10) { dem += 3; demWhy.push(`${sellers} vendedores ativos no catálogo`); }
  for (const s of P.signals ?? []) { const d = SIGNALS[s]; if (d) { dem += d[0]; demWhy.push(d[1]); } }
  dem = Math.min(dem, 30);

  // margem (25)
  const mp = best?.margin_pct ?? null;
  const marg = mp == null ? 0 : Math.round(Math.max(0, Math.min(mp, 30)) / 30 * 25);
  // concorrência (15)
  let comp = sellers == null ? 8 : Math.round(15 * (1 - Math.min(sellers, 60) / 60));
  if (mk?.full_pct != null && Number(mk.full_pct) >= 60) comp = Math.max(0, comp - 2);
  // logística (15)
  let log = w == null ? 8 : w <= 300 ? 15 : w <= 1000 ? 11 : w <= 3000 ? 7 : 3;
  if (P.fragile) log -= 4; if (P.regulated) log -= 4; log = Math.max(0, log);
  // fornecedor (10)
  let sup = 0;
  if (priced.length) sup += 4;
  const bo = best ? offers.find((o: any) => o.vendor_id === best.vendor_id) : null;
  if (bo?.nf || bo?.dropship) sup += 2;
  const conf = bo?.confirmed_at ?? bo?.stock_confirmed_at;
  if (conf && Date.now() - new Date(conf).getTime() < 15 * 86400000) sup += 2;
  if (priced.length >= 2) sup += 2;
  // conteúdo (5)
  const cont = Math.max(0, Math.min(Number(P.content_score ?? 0), 5));
  const score = dem + marg + comp + log + sup + cont;
  const klass = score >= 80 ? "Prioridade alta" : score >= 65 ? "Testar" : score >= 50 ? "Observar" : "Evitar por enquanto";

  // recomendação em texto
  const parts: string[] = [];
  parts.push(dem >= 20 ? "Demanda forte" : dem >= 12 ? "Demanda moderada" : dem > 0 ? "Demanda fraca" : "Demanda ainda sem sinais");
  if (best && best.margin_at_market != null) parts.push(`margem estimada de ${best.margin_pct}% (${brl(best.margin_at_market)} por venda) no preço de mercado de ${brl(med)}`);
  else if (best) parts.push(`custo de ${brl(best.cost)} no ${best.vendor}, mas sem preço de mercado para comparar`);
  else parts.push("sem custo de fornecedor cadastrado");
  if (sellers != null) parts.push(`concorrência ${sellers > 40 ? "alta" : sellers > 10 ? "média" : "baixa"} (${sellers} vendedores)`);
  if (best) parts.push(best.distance_km != null ? `fornecedor ${best.vendor} a ${best.distance_km} km` : best.dropship ? `fornecedor ${best.vendor} em dropshipping` : `fornecedor ${best.vendor}`);
  let action = "";
  const small = P.kind === "tendencia" ? 3 : 5;
  const viaDrop = !!best?.dropship;
  if (klass === "Prioridade alta") action = viaDrop ? `Anunciar em dropshipping já, criar 3 vídeos e só pensar em estoque próprio depois de 10 vendas.` : `Testar ${small} unidades, criar 3 vídeos e não comprar lote maior antes de 10 vendas.`;
  else if (klass === "Testar") action = viaDrop ? `Anunciar em dropshipping e medir visitas e conversão por 14 dias.` : `Testar com ${small} unidades no máximo e medir 14 dias antes de repor.`;
  else if (klass === "Observar") action = "Observar: ainda não vale colocar dinheiro.";
  else action = "Evitar por enquanto.";
  const weak: [number, string][] = [[dem / 30, "faltam sinais de demanda"], [marg / 25, "a margem é baixa"], [comp / 15, "a concorrência é alta"], [log / 15, "a logística é difícil"], [sup / 10, "o fornecedor ainda não está validado"]];
  weak.sort((a, b) => a[0] - b[0]);
  if (klass !== "Prioridade alta") action += ` O ponto mais fraco: ${weak[0][1]}.`;
  if (P.kind === "sazonal" && (P.season_months ?? []).length) {
    const m = [...P.season_months].sort((a: number, b: number) => a - b);
    const now = new Date().getMonth() + 1;
    const next = m.find((x: number) => x >= now) ?? m[0];
    const buy = ((next - 2 + 12) % 12) + 1;
    action += ` Sazonal com pico em ${m.map((x: number) => MESES[x - 1]).join(", ")}: compre ou anuncie até ${MESES[buy - 1]} e evite sobra depois do pico.`;
  }
  if (P.kind === "tendencia") action += " Tendência: pouco estoque, não aposte todo o capital.";
  if (w == null) notes.push("Informe o peso para o frete e a logística ficarem reais (hoje uso 300 g).");
  if (!priced.length) notes.push("Cadastre pelo menos um fornecedor com custo, ou peça cotação.");
  if (!mk) notes.push("Não achei o produto no catálogo do ML: informe o código do produto (MLB…) ou um termo de busca melhor.");
  if (best?.capital_test) notes.push(`Capital para o teste na quantidade mínima: ${brl(best.capital_test)}.`);

  const ev = { score, class: klass, parts: { demanda: dem, margem: marg, concorrencia: comp, logistica: log, fornecedor: sup, conteudo: cont }, demand_why: demWhy,
    market: mk ? { product_id: mk.product_id, name: mk.product_name, median: med, min: num(mk.min_price), max: num(mk.max_price), sellers, full_pct: num(mk.full_pct), similarity: num(mk.similarity) } : null,
    category_id: cat, fee_pct: feePct, ship_at_market: shipMed, ship_basis: w == null ? "300 g padrão" : `${w} g`, offers: evalOffers, best_vendor_id: best?.vendor_id ?? null,
    recommendation: parts.join(", ") + ". " + action, notes, at: new Date().toISOString() };
  await sql`update radar.products set eval = ${sql.json(ev)}, eval_at = now(), category_id = coalesce(category_id, ${cat}) where id = ${id}`;
  return ev;
}

/* ---------- atendimento: perguntas e reclamações ---------- */
async function routeService() {
  const me = await ok("/users/me"); if (!me) return { error: "conta não vinculada" };
  const [qu, qa, cl] = await Promise.all([
    ml(`/questions/search?seller_id=${me.id}&api_version=4&status=UNANSWERED&sort_fields=date_created&sort_types=DESC&limit=50`),
    ml(`/questions/search?seller_id=${me.id}&api_version=4&status=ANSWERED&limit=1`),
    ml(`/post-purchase/v1/claims/search?status=opened&limit=30`),
  ]);
  const titles = new Map<string, string>();
  const qs = qu.status === 200 ? (qu.body.questions ?? []) : [];
  const claims = cl.status === 200 ? (cl.body.data ?? []) : [];
  const itemIds = [...new Set([...qs.map((q: any) => q.item_id), ...claims.map((c: any) => c.resource_id).filter((x: any) => /^MLB/.test(String(x)))])].slice(0, 20);
  if (itemIds.length) { const r = await ok(`/items?ids=${itemIds.join(",")}&attributes=id,title,permalink`); for (const x of r ?? []) if (x.body?.id) titles.set(x.body.id, x.body.title); }
  return {
    questions: { status: qu.status, unanswered: qu.status === 200 ? (qu.body.total ?? qs.length) : null, answered_total: qa.status === 200 ? (qa.body.total ?? null) : null,
      items: qs.map((q: any) => ({ id: q.id, item_id: q.item_id, item_title: titles.get(q.item_id) ?? null, text: q.text, date: q.date_created, hours_open: Math.round((Date.now() - new Date(q.date_created).getTime()) / 36e5) })) },
    claims: { status: cl.status, open: cl.status === 200 ? (cl.body.paging?.total ?? claims.length) : null,
      items: claims.map((c: any) => ({ id: c.id, type: c.type, stage: c.stage, status: c.status, reason: c.reason_id, resource: c.resource, resource_id: c.resource_id, date: c.date_created, due: c.players?.find?.((p: any) => p.role === "respondent")?.available_actions?.[0]?.due_date ?? null })) },
  };
}

/* ---------- inteligência de concorrentes (dados da extensão) ---------- */
async function routeIntel(ids: string[]) {
  if (!ids.length) {
    const s = await sql`select count(*)::int n, count(distinct item_id)::int items, max(captured_at) last from radar.item_snapshots where source like 'ext%'`;
    return { summary: s[0] };
  }
  const rows = await sql`select item_id, captured_at, sold_min, sold_label, reviews, price from radar.item_snapshots where item_id = any(${ids}) and source like 'ext%' order by item_id, captured_at`;
  const by: Record<string, any[]> = {}; for (const r of rows) (by[r.item_id] ??= []).push(r);
  const out: Record<string, any> = {};
  for (const [id, s] of Object.entries(by)) {
    const first = s[0], last = s[s.length - 1];
    const days = (new Date(last.captured_at).getTime() - new Date(first.captured_at).getTime()) / 86400000;
    let perDay: number | null = null, basis: string | null = null;
    if (days >= 1) {
      if (first.reviews != null && last.reviews != null && last.reviews > first.reviews) { perDay = r2((last.reviews - first.reviews) / days * 10); basis = "avaliações"; }
      else if (first.sold_min != null && last.sold_min != null && last.sold_min > first.sold_min) { perDay = r2((last.sold_min - first.sold_min) / days); basis = "faixa de vendidos"; }
    }
    out[id] = { observations: s.length, first_seen: first.captured_at, last_seen: last.captured_at, sold_label: last.sold_label, sold_min: last.sold_min, reviews: last.reviews, price: num(last.price), est_per_day: perDay, est_month: perDay == null ? null : Math.round(perDay * 30), basis };
  }
  return { items: out };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*?\/saude/, "") || "/";
  const qp = (k: string) => url.searchParams.get(k) ?? "";
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    if (req.headers.get("x-radar-key") !== await key()) return json({ error: "não autorizado" }, 401);
    if (route === "/health") return json(await routeHealth(qp("fresh") === "1"));
    if (route === "/opps") return json(await routeOpps(qp("supplier") || "GoBoox", Math.max(0, parseInt(qp("offset") || "0") || 0), Math.min(Math.max(parseInt(qp("limit") || "15") || 15, 1), 25), qp("fresh") === "1"));
    if (route === "/service") return json(await routeService());
    if (route === "/prod") return json(await routeProd(parseInt(qp("id")) || 0, qp("fresh") === "1"));
    if (route === "/intel") return json(await routeIntel(qp("ids").split(",").filter((x) => /^MLB\d+$/.test(x)).slice(0, 100)));
    return json({ error: "rota não encontrada" }, 404);
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
});
