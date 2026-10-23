import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CLIENT_ID = "2244190709439067";
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

/* ---------- financeiro ---------- */
const FEE = new Map<string, any>();
async function feeFor(price: number, catId: string, type: string) {
  const k = `${price}|${catId}|${type}`; if (FEE.has(k)) return FEE.get(k);
  const r = await ok(`/sites/MLB/listing_prices?price=${price}&category_id=${catId}&listing_type_id=${type}`);
  const o = Array.isArray(r) ? r[0] : r;
  const v = { pct: o?.sale_fee_details?.percentage_fee ?? null, amount: o?.sale_fee_amount ?? null };
  FEE.set(k, v); return v;
}
async function myItems(uid: number) {
  const ids: string[] = [];
  for (let off = 0; off < 500; off += 50) { const s = await ok(`/users/${uid}/items/search?limit=50&offset=${off}`); if (!s?.results?.length) break; ids.push(...s.results); if (ids.length >= (s.paging?.total ?? 0)) break; }
  const chunks: string[][] = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  return (await pool(chunks, 4, (c) => ok(`/items?ids=${c.join(",")}&attributes=id,title,price,sold_quantity,available_quantity,status,permalink,listing_type_id,category_id,shipping,attributes`))).flat().filter(Boolean).map((x: any) => x.body).filter((b: any) => b?.id);
}
const r2 = (x: number) => Math.round(x * 100) / 100;
async function routeFinance(days: number) {
  const me = await ok("/users/me");
  if (!me) return { error: "conta não vinculada" };
  const S: Record<string, number> = {}; for (const r of await sql`select k, v from radar.settings`) S[r.k] = Number(r.v);
  const C = new Map((await sql`select item_id, cost, extra, ship_override, source from radar.item_costs`).map((r: any) => [r.item_id, r]));
  const SP = await sql`select supplier, sku, gtin, title, cost, updated_at from radar.supplier_prices where cost is not null order by updated_at desc`;
  const bySku = new Map<string, any>(), byGtin = new Map<string, any>();
  const norm = (s: string) => String(s ?? "").trim().toUpperCase().replace(/^GBX-/, "");
  for (const r of SP) { if (!bySku.has(norm(r.sku))) bySku.set(norm(r.sku), r); if (r.gtin && !byGtin.has(String(r.gtin))) byGtin.set(String(r.gtin), r); }
  const attr = (x: any, id: string) => (x.attributes ?? []).find((a: any) => a.id === id)?.value_name ?? null;
  const items = (await myItems(me.id)).map((x: any) => ({ ...x, sku: attr(x, "SELLER_SKU") ?? x.seller_custom_field ?? null, gtin: attr(x, "GTIN") }));
  // custo efetivo: digitado > fornecedor por SKU > fornecedor por GTIN
  const resolve = (x: any) => {
    const c: any = C.get(x.id);
    const sp = (x.sku && bySku.get(norm(x.sku))) || (x.gtin && byGtin.get(String(x.gtin))) || null;
    if (c?.cost != null) return { cost: Number(c.cost), source: c.source ?? "manual", sp };
    if (sp) return { cost: Number(sp.cost), source: sp.supplier, sp };
    return { cost: null, source: null, sp };
  };
  const RES = new Map(items.map((x: any) => [x.id, resolve(x)]));

  // margem projetada por anúncio (tarifa real do ML + custo real de envio da conta)
  const projected = await pool(items, 8, async (x: any) => {
    const fee = await feeFor(x.price, x.category_id, x.listing_type_id);
    const c: any = C.get(x.id);
    const shipEst = x.price >= 79 ? S.ship_free_79 : S.ship_below_79;
    const shipML = c?.ship_override != null ? null : await shipReal("item:" + x.id, x.price);
    const ship = c?.ship_override != null ? Number(c.ship_override) : shipML ?? shipEst;
    const shipSrc = c?.ship_override != null ? "manual" : shipML != null ? "ml" : "estimativa";
    const tax = x.price * (S.tax_pct ?? 0) / 100;
    const rs: any = RES.get(x.id); const cost = rs.cost;
    const extra = Number(c?.extra ?? 0) + (S.supplier_fee_order ?? 0);
    const feeAmt = fee.amount ?? (fee.pct != null ? x.price * fee.pct / 100 : 0);
    const margin = cost == null ? null : r2(x.price - feeAmt - ship - tax - cost - extra);
    const pct = margin == null ? null : r2(margin / x.price * 100);
    const status = cost == null ? "sem_custo" : margin! < 0 ? "prejuizo" : pct! < 8 ? "isca" : "ok";
    return { id: x.id, title: x.title, permalink: x.permalink, status_ml: x.status, price: x.price, sold: x.sold_quantity, stock: x.available_quantity, listing_type: x.listing_type_id === "gold_pro" ? "Premium" : "Clássico", fee_pct: fee.pct, fee: r2(feeAmt), ship: r2(ship), ship_is_estimate: c?.ship_override == null, ship_source: shipSrc, tax: r2(tax), cost, extra: Number(c?.extra ?? 0), margin, margin_pct: pct, status, manual_cost: c?.cost != null ? Number(c.cost) : null, sku: x.sku, gtin: x.gtin, cost_source: rs.source, supplier_cost: rs.sp ? Number(rs.sp.cost) : null, supplier: rs.sp?.supplier ?? null, supplier_updated: rs.sp?.updated_at ?? null };
  });

  // realizado: pedidos do período, com tarifa e frete reais
  const from = new Date(Date.now() - days * 86400000);
  const fromStr = from.toISOString().slice(0, 19) + ".000-00:00";
  const orders: any[] = []; let total = 0;
  for (let off = 0; off < 1000; off += 50) {
    const s = await ok(`/orders/search?seller=${me.id}&order.date_created.from=${encodeURIComponent(fromStr)}&sort=date_desc&limit=50&offset=${off}`);
    if (!s?.results?.length) { total = s?.paging?.total ?? total; break; }
    orders.push(...s.results); total = s.paging?.total ?? orders.length; if (orders.length >= total) break;
  }
  const shipIds = [...new Set(orders.map((o: any) => o.shipping?.id).filter(Boolean))];
  const shipCost = new Map<string, number>();
  await pool(shipIds, 8, async (sid) => { const c = await ok(`/shipments/${sid}/costs`); const v = c?.senders?.reduce((a: number, s: any) => a + Number(s.cost ?? 0), 0); if (v != null) shipCost.set(String(sid), v); });
  const T = { orders: 0, units: 0, revenue: 0, fees: 0, shipping: 0, tax: 0, cogs: 0, supplier: 0, margin: 0, cancelled: 0, missing_cost_units: 0 };
  const byItem: Record<string, any> = {}; const byDay: Record<string, any> = {};
  for (const o of orders) {
    if (o.status === "cancelled") { T.cancelled++; continue; }
    const day = String(o.date_created).slice(0, 10);
    let rev = 0, fees = 0, cogs = 0, units = 0, miss = 0;
    for (const oi of o.order_items ?? []) {
      const q = Number(oi.quantity ?? 1), up = Number(oi.unit_price ?? 0), sf = Number(oi.sale_fee ?? 0);
      const c: any = C.get(oi.item?.id); const rs: any = RES.get(oi.item?.id); const uc = c?.cost != null ? Number(c.cost) : rs?.cost ?? null;
      const cost = uc != null ? (uc + Number(c?.extra ?? 0)) * q : 0;
      if (uc == null) miss += q;
      rev += up * q; fees += sf * q; cogs += cost; units += q;
      const bi = (byItem[oi.item?.id] ??= { id: oi.item?.id, title: oi.item?.title, units: 0, revenue: 0, fees: 0, cogs: 0, shipping: 0, margin: 0 });
      bi.units += q; bi.revenue += up * q; bi.fees += sf * q; bi.cogs += cost;
    }
    const ship = shipCost.get(String(o.shipping?.id)) ?? 0;
    const tax = rev * (S.tax_pct ?? 0) / 100; const sup = S.supplier_fee_order ?? 0;
    const m = rev - fees - ship - tax - cogs - sup;
    T.orders++; T.units += units; T.revenue += rev; T.fees += fees; T.shipping += ship; T.tax += tax; T.cogs += cogs; T.supplier += sup; T.margin += m; T.missing_cost_units += miss;
    const first = (o.order_items ?? [])[0]?.item?.id; if (first && byItem[first]) { byItem[first].shipping += ship; }
    const d = (byDay[day] ??= { day, orders: 0, revenue: 0, margin: 0 }); d.orders++; d.revenue += rev; d.margin += m;
  }
  for (const b of Object.values(byItem) as any[]) { b.margin = r2(b.revenue - b.fees - b.shipping - b.revenue * (S.tax_pct ?? 0) / 100 - b.cogs); b.revenue = r2(b.revenue); b.fees = r2(b.fees); b.cogs = r2(b.cogs); b.shipping = r2(b.shipping); }
  for (const k of Object.keys(T) as (keyof typeof T)[]) T[k] = r2(T[k]);
  // custos fixos, lucro líquido e ponto de equilíbrio
  const FX = (await sql`select name, amount from radar.fixed_costs order by id`).map((r: any) => ({ name: r.name, amount: Number(r.amount) }));
  const fixedMonthly = r2(FX.reduce((a: number, x: any) => a + x.amount, 0));
  const fixedPeriod = r2(fixedMonthly * days / 30);
  const net = r2(T.margin - fixedPeriod);
  const pv = projected.filter((x: any) => x && x.margin != null && x.status_ml === "active");
  const unitFromSales = T.units ? T.margin / T.units : null;
  const unitFromListings = pv.length ? pv.reduce((a: number, x: any) => a + x.margin, 0) / pv.length : null;
  const unitBasis = unitFromSales ?? unitFromListings;
  const breakEven = fixedMonthly > 0 && unitBasis && unitBasis > 0 ? Math.ceil(fixedMonthly / unitBasis) : (fixedMonthly > 0 ? null : 0);
  return {
    account: { nickname: me.nickname }, settings: S, days, from: from.toISOString(),
    fixed: { items: FX, monthly: fixedMonthly, period: fixedPeriod, net, unit_margin: unitBasis == null ? null : r2(unitBasis), unit_basis: unitFromSales != null ? "vendas" : unitFromListings != null ? "anuncios" : null, break_even_units: breakEven, break_even_per_day: breakEven ? r2(breakEven / 30) : null },
    totals: { ...T, margin_pct: T.revenue ? r2(T.margin / T.revenue * 100) : null, ticket: T.orders ? r2(T.revenue / T.orders) : null, orders_found: total },
    by_item: Object.values(byItem).sort((a: any, b: any) => b.revenue - a.revenue),
    daily: Object.values(byDay).sort((a: any, b: any) => a.day.localeCompare(b.day)).map((d: any) => ({ ...d, revenue: r2(d.revenue), margin: r2(d.margin) })),
    projected: projected.filter(Boolean).sort((a: any, b: any) => (a.margin ?? 1e9) - (b.margin ?? 1e9)),
  };
}


Deno.serve(async (req) => {
  const url = new URL(req.url);
  const qp = (k: string) => url.searchParams.get(k) ?? "";
  try {
    if (req.headers.get("x-radar-key") !== await key()) return json({ error: "não autorizado" }, 401);
    const d = Math.min(Math.max(parseInt(qp("days") || "30") || 30, 1), 365);
    return json(await routeFinance(d));
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
});
