import postgres from "npm:postgres@3.4.4";

// Entrada de preços de fornecedor (botão de favoritos da GoBoox, outros fornecedores).
// A chave sup_key só permite gravar em radar.supplier_prices.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors } });

const KEYS: Record<string, string | null> = {};
async function key(k: string) { if (!(k in KEYS)) { const r = await sql`select v from radar.config where k = ${k}`; KEYS[k] = r[0]?.v ?? null; } return KEYS[k]; }
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null ? null : Number(v));
const txt = (v: unknown, n: number) => (v == null || v === "" ? null : String(v).slice(0, n));
const int = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Math.round(Number(v)));

/* Extensão do Chrome: grava o que aparece nas páginas do ML e devolve a estimativa de vendas. */
async function snap(b: any) {
  const kind = b.page === "item" ? "ext_item" : "ext_list";
  const query = txt(b.query, 200);
  const seen = new Set<string>();
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 120).filter((x: any) => /^MLB\d{6,}$/.test(String(x?.item_id ?? "")) && !seen.has(x.item_id) && !!seen.add(x.item_id));
  if (!items.length) return { ok: true, saved: 0, items: {} };
  const ids = items.map((x: any) => String(x.item_id));
  const last = await sql`select distinct on (item_id) item_id, captured_at, sold_min, reviews, price from radar.item_snapshots where item_id = any(${ids}) and source like 'ext%' order by item_id, captured_at desc`;
  const lm: Record<string, any> = {}; for (const r of last) lm[r.item_id] = r;
  const rows: any[] = [];
  for (const x of items) {
    const p = lm[x.item_id];
    const changed = !p || (int(x.sold_min) != null && int(x.sold_min) !== p.sold_min) || (int(x.reviews) != null && int(x.reviews) !== p.reviews) || (num(x.price) != null && num(x.price) !== num(p.price));
    const old = !p || Date.now() - new Date(p.captured_at).getTime() > 6 * 3600e3;
    if (!changed && !old) continue;
    rows.push({ item_id: String(x.item_id), source: kind, query, position: int(x.position), title: txt(x.title, 200), price: num(x.price), original_price: num(x.original_price), sold_label: txt(x.sold_label, 40), sold_min: int(x.sold_min), seller_name: txt(x.seller_name, 120), full_fulfillment: x.full == null ? null : !!x.full, free_shipping: x.free_shipping == null ? null : !!x.free_shipping, permalink: txt(x.permalink, 300), reviews: int(x.reviews), rating: num(x.rating) });
  }
  if (rows.length) await sql`insert into radar.item_snapshots ${sql(rows, "item_id", "source", "query", "position", "title", "price", "original_price", "sold_label", "sold_min", "seller_name", "full_fulfillment", "free_shipping", "permalink", "reviews", "rating")}`;
  return { ok: true, saved: rows.length, items: await estimates(ids) };
}

async function estimates(ids: string[]) {
  const rows = await sql`select item_id, captured_at, sold_min, sold_label, reviews, price from radar.item_snapshots where item_id = any(${ids}) and source like 'ext%' order by item_id, captured_at`;
  const by: Record<string, any[]> = {}; for (const r of rows) (by[r.item_id] ??= []).push(r);
  const out: Record<string, any> = {};
  for (const [id, s] of Object.entries(by)) {
    const lastRev = [...s].reverse().find((x) => x.reviews != null), firstRev = s.find((x) => x.reviews != null);
    const lastSold = [...s].reverse().find((x) => x.sold_min != null), firstSold = s.find((x) => x.sold_min != null);
    const first = s[0], last = s[s.length - 1];
    const days = (new Date(last.captured_at).getTime() - new Date(first.captured_at).getTime()) / 86400000;
    let perDay: number | null = null, basis: string | null = null;
    if (firstRev && lastRev && lastRev.reviews > firstRev.reviews) {
      const d = (new Date(lastRev.captured_at).getTime() - new Date(firstRev.captured_at).getTime()) / 86400000;
      if (d >= 1) { perDay = r2((lastRev.reviews - firstRev.reviews) / d * 10); basis = "avaliações"; }
    }
    if (perDay == null && firstSold && lastSold && lastSold.sold_min > firstSold.sold_min) {
      const d = (new Date(lastSold.captured_at).getTime() - new Date(firstSold.captured_at).getTime()) / 86400000;
      if (d >= 1) { perDay = r2((lastSold.sold_min - firstSold.sold_min) / d); basis = "faixa de vendidos"; }
    }
    const price = num(lastSold?.price ?? last.price);
    out[id] = { observations: s.length, days_tracked: r2(days), first_seen: first.captured_at, sold_label: lastSold?.sold_label ?? null, sold_min: lastSold?.sold_min ?? null, reviews: lastRev?.reviews ?? null, price, revenue_min: lastSold?.sold_min != null && price != null ? Math.round(lastSold.sold_min * price) : null, est_per_day: perDay, est_month: perDay == null ? null : Math.round(perDay * 30), basis };
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  try {
    const b = JSON.parse(await req.text());
    if (b?.kind === "snap" || b?.kind === "est" || b?.kind === "qf") {
      if (!b.k || b.k !== await key("ext_key")) return json({ error: "não autorizado" }, 401);
      if (b.kind === "qf") {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 3000).map((x: any) => ({ ext_id: txt(x.slug, 160), name: txt(x.nome, 160), city: txt(x.cidade, 80), uf: txt(x.estado, 2), website: txt(x.website, 300), tipos: (Array.isArray(x.tipo) ? x.tipo : []).slice(0, 20).map((t: any) => String(t).slice(0, 80)), categorias: [txt(b.category, 80)].filter(Boolean) })).filter((x: any) => x.ext_id && x.name);
        if (!items.length) return json({ error: "nenhum fornecedor válido" }, 400);
        const r = await sql`select radar.import_vendors('quemfornece', ${sql.json(items)}) as n`;
        return json({ ok: true, saved: r[0].n });
      }
      if (b.kind === "est") return json({ ok: true, items: await estimates((Array.isArray(b.ids) ? b.ids : []).filter((x: any) => /^MLB\d+$/.test(String(x))).slice(0, 120)) });
      return json(await snap(b));
    }
    if (!b?.k || b.k !== await key("sup_key")) return json({ error: "não autorizado" }, 401);
    const supplier = String(b.supplier ?? "").trim().slice(0, 60);
    if (!supplier) return json({ error: "fornecedor vazio" }, 400);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 5000)
      .map((x: any) => ({ sku: String(x.sku ?? "").trim().slice(0, 120), gtin: x.gtin ? String(x.gtin).slice(0, 20) : "", title: String(x.title ?? "").slice(0, 200), cost: x.cost == null || x.cost === "" ? "" : String(Number(x.cost)), stock: x.stock == null ? "" : String(parseInt(x.stock) || 0), url: x.url ? String(x.url).slice(0, 300) : "" }))
      .filter((x: any) => x.sku && (x.cost === "" || isFinite(Number(x.cost))));
    if (!items.length) return json({ error: "nenhum item válido" }, 400);
    const r = await sql`select radar.set_supplier_prices(${supplier}, ${sql.json(items)}) as n`;
    return json({ ok: true, supplier, saved: r[0].n });
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
});
