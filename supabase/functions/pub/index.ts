import postgres from "npm:postgres@3.4.4";

// Publicação no Mercado Livre a partir do rascunho de um produto do Oportuniza.
// Só é chamada pela função app (dono logado) com a chave interna. Nada é publicado sem o clique "Publicar".
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const CLIENT_ID = "2244190709439067";
const API = "https://api.mercadolibre.com";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

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
async function accessToken(): Promise<string> {
  const r = await sql`select access_token, refresh_token, expires_at from radar.ml_tokens where id = 1`;
  const t = r[0];
  if (!t?.access_token) throw new Error("Conta do Mercado Livre não vinculada.");
  if (new Date(t.expires_at) > new Date()) return t.access_token;
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  const exp = new Date(Date.now() + (j.expires_in - 120) * 1000);
  await sql`update radar.ml_tokens set access_token = ${j.access_token}, refresh_token = coalesce(${j.refresh_token ?? null}, refresh_token), expires_at = ${exp}, updated_at = now() where id = 1`;
  return j.access_token;
}
async function ml(method: string, path: string, body?: unknown, raw?: BodyInit, ctype?: string) {
  const tok = await accessToken();
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${tok}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (ctype) headers["content-type"] = ctype;
  const r = await fetch(API + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const t = await r.text();
  let b: any = null; try { b = t ? JSON.parse(t) : null; } catch { b = t.slice(0, 500); }
  return { status: r.status, body: b };
}
const okGet = async (p: string) => { const r = await ml("GET", p); return r.status === 200 ? r.body : null; };
const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- prepara o formulário: categoria, atributos obrigatórios, tipos de anúncio ---------- */
async function prepare(id: number) {
  const r = await sql`select id, name, ml_query, category_id, weight_g, dims, draft, linked_item_id from radar.products where id = ${id}`;
  const p = r[0]; if (!p) throw new Error("produto não encontrado");
  const d = p.draft ?? {};
  let catId: string | null = p.category_id;
  const title = d.chosen_title || d.titles?.[0] || p.name;
  if (!catId) { const dd = await okGet(`/sites/MLB/domain_discovery/search?q=${encodeURIComponent(title)}&limit=1`); catId = dd?.[0]?.category_id ?? null; }
  if (!catId) throw new Error("Não achei a categoria do produto no ML.");
  const [cat, attrs, me] = await Promise.all([okGet(`/categories/${catId}`), okGet(`/categories/${catId}/attributes`), okGet(`/users/me`)]);
  const types = me?.id ? await okGet(`/users/${me.id}/available_listing_types?category_id=${catId}`) : null;
  const ficha: Record<string, string> = {}; for (const a of d.attributes ?? []) ficha[norm(a.name)] = a.value;
  const fields = (attrs ?? []).filter((a: any) => {
    const t = a.tags ?? {};
    if (t.read_only || t.hidden || t.fixed || t.others) return false;
    return t.required || t.catalog_required || t.conditional_required || ficha[norm(a.name)] != null || ["BRAND", "MODEL", "GTIN"].includes(a.id);
  }).map((a: any) => {
    const t = a.tags ?? {};
    let sug = ficha[norm(a.name)] ?? null;
    // a ficha do concorrente é um ponto de partida; marca e código de barras precisam ser do seu produto
    if (["BRAND", "GTIN", "SELLER_SKU", "MPN"].includes(a.id)) sug = null;
    let sugId: string | null = null;
    if (sug && a.values?.length) { const v = a.values.find((v: any) => norm(v.name) === norm(sug!)); if (v) sugId = v.id; }
    return { id: a.id, name: a.name, type: a.value_type, required: !!(t.required || t.catalog_required), conditional: !!t.conditional_required, multivalued: !!t.multivalued,
      values: (a.values ?? []).slice(0, 300).map((v: any) => ({ id: v.id, name: v.name })), units: (a.allowed_units ?? []).map((u: any) => u.id), default_unit: a.default_unit ?? null,
      hint: a.hint ?? a.tooltip ?? null, suggested: sug, suggested_id: sugId };
  }).sort((a: any, b: any) => Number(b.required) - Number(a.required));
  return { ok: true, product_id: p.id, linked_item_id: p.linked_item_id, title, titles: d.titles ?? [p.name], description: d.description ?? "", category: { id: catId, name: cat?.name ?? null, path: (cat?.path_from_root ?? []).map((x: any) => x.name), max_pictures: cat?.settings?.max_pictures_per_item ?? 10, buying_modes: cat?.settings?.buying_modes ?? [], listing_allowed: cat?.settings?.listing_allowed ?? true, catalog_domain: cat?.settings?.catalog_domain ?? null },
    listing_types: (types?.available ?? [{ id: "gold_special", name: "Clássico" }, { id: "gold_pro", name: "Premium" }]).filter((t: any) => ["gold_special", "gold_pro"].includes(t.id)),
    fields, ref_price: d.from?.price ?? null, weight_g: p.weight_g, dims: p.dims };
}

/* ---------- foto: sobe para o ML e devolve o id (arquivo do computador ou link, ex. foto do fornecedor) ---------- */
async function upload(b: any) {
  let type = String(b.type ?? "image/jpeg"); let bytes: Uint8Array;
  if (b.url) {
    const u = String(b.url); if (!/^https:\/\//.test(u)) throw new Error("Link da foto precisa começar com https://");
    const r = await fetch(u); if (!r.ok) throw new Error(`Não consegui baixar a foto (${r.status}).`);
    type = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim(); bytes = new Uint8Array(await r.arrayBuffer());
  } else bytes = Uint8Array.from(atob(String(b.data ?? "")), (c) => c.charCodeAt(0));
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error("Use foto JPG, PNG ou WEBP.");
  if (bytes.length < 2000 || bytes.length > 9e6) throw new Error("Foto muito pequena ou muito grande.");
  const fd = new FormData(); fd.append("file", new Blob([bytes], { type }), "foto." + type.split("/")[1]);
  const tok = await accessToken();
  const r = await fetch(`${API}/pictures/items/upload`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`O ML recusou a foto (${r.status}): ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
  const v = (j.variations ?? []).find((x: any) => /500x|400x/.test(x.size)) ?? j.variations?.[0];
  return { ok: true, id: j.id, url: v?.secure_url ?? v?.url ?? null, max_size: j.max_size ?? null };
}

/* ---------- monta o anúncio ---------- */
function buildItem(b: any) {
  const title = String(b.title ?? "").trim();
  if (!title || title.length > 60) throw new Error("O título precisa ter de 1 a 60 letras.");
  const price = Math.round(Number(b.price) * 100) / 100; if (!(price > 0)) throw new Error("Informe o preço.");
  const qty = Math.round(Number(b.quantity)); if (!(qty > 0)) throw new Error("Informe o estoque (quantidade disponível).");
  const pics = (Array.isArray(b.pictures) ? b.pictures : []).map(String).filter((x: string) => /^[\w-]{6,}$/.test(x)).slice(0, 12);
  if (!pics.length) throw new Error("Envie pelo menos uma foto.");
  const attributes = (Array.isArray(b.attributes) ? b.attributes : []).filter((a: any) => a?.id && (a.value_id || String(a.value_name ?? "").trim()))
    .map((a: any) => (a.value_id ? { id: String(a.id), value_id: String(a.value_id) } : { id: String(a.id), value_name: String(a.value_name).trim().slice(0, 255) }));
  const sale_terms: any[] = [];
  if (b.warranty_days > 0) sale_terms.push({ id: "WARRANTY_TYPE", value_name: b.warranty_type === "fabrica" ? "Garantia de fábrica" : "Garantia do vendedor" }, { id: "WARRANTY_TIME", value_name: `${Math.round(b.warranty_days)} dias` });
  else sale_terms.push({ id: "WARRANTY_TYPE", value_name: "Sem garantia" });
  // conta no modelo "User Products": o ML não aceita title; ele monta o título com family_name + ficha
  return { family_name: title, category_id: String(b.category_id), price, shipping: { mode: "me2" }, currency_id: "BRL", available_quantity: qty, buying_mode: "buy_it_now",
    listing_type_id: b.listing_type_id === "gold_pro" ? "gold_pro" : "gold_special", condition: "new", pictures: pics.map((id: string) => ({ id })), attributes, sale_terms };
}
// avisos que não impedem a publicação (o ML devolve 400 mesmo quando só há avisos)
const NOISE = new Set(["shipping.lost_me1_by_user"]);
const PT: Record<string, string> = { "item.shipping.mandatory_free_shipping": "Frete grátis obrigatório nesse preço (a partir de R$ 79): o ML coloca automaticamente e você paga parte do frete." };
const causes = (body: any) => (body?.cause ?? []).filter((c: any) => !NOISE.has(c.code)).map((c: any) => ({ type: c.type, code: c.code, message: PT[c.code] ?? c.message, refs: c.references ?? [] }));
const onlyWarnings = (body: any) => Array.isArray(body?.cause) && body.cause.every((c: any) => c.type === "warning");

async function validate(b: any) {
  const item = buildItem(b);
  const r = await ml("POST", "/items/validate", item);
  const fees = await okGet(`/sites/MLB/listing_prices?price=${item.price}&category_id=${item.category_id}&listing_type_id=${item.listing_type_id}`);
  const fee = Array.isArray(fees) ? fees[0] : fees;
  const ok = r.status === 204 || r.status === 200 || (r.status === 400 && onlyWarnings(r.body));
  return { ok, status: r.status, causes: r.status === 204 ? [] : causes(r.body), message: ok ? null : r.body?.message ?? null, fee: fee?.sale_fee_amount ?? null, fee_pct: fee?.sale_fee_details?.percentage_fee ?? null };
}

async function publish(b: any) {
  const id = Number(b.product_id); if (!id) throw new Error("produto inválido");
  const cur = await sql`select linked_item_id, draft from radar.products where id = ${id}`;
  if (!cur.length) throw new Error("produto não encontrado");
  if (cur[0].linked_item_id) throw new Error(`Este produto já tem anúncio (${cur[0].linked_item_id}).`);
  const item = buildItem(b);
  const r = await ml("POST", "/items", item);
  if (r.status !== 201 && r.status !== 200) return { ok: false, status: r.status, message: r.body?.message ?? "O ML recusou o anúncio.", causes: causes(r.body) };
  const itemId = r.body.id as string;
  const steps: string[] = [];
  const desc = String(b.description ?? "").replace(/\r/g, "").trim();
  if (desc) { const d = await ml("POST", `/items/${itemId}/description`, { plain_text: desc.slice(0, 50000) }); steps.push(d.status < 300 ? "descrição ok" : `descrição recusada (${d.status}): ${d.body?.message ?? ""}`); }
  if (b.paused) { const s = await ml("PUT", `/items/${itemId}`, { status: "paused" }); steps.push(s.status < 300 ? "pausado" : `não pausou (${s.status})`); }
  const pub = { item_id: itemId, permalink: r.body.permalink ?? null, status: b.paused ? "paused" : r.body.status, at: new Date().toISOString(), title: r.body.title ?? item.family_name, family_name: item.family_name, price: item.price, steps };
  await sql`update radar.products set linked_item_id = ${itemId}, stage = case when stage in ('descobrir','filtrar') then 'validar' else stage end, draft = coalesce(draft, '{}'::jsonb) || ${sql.json({ published: pub })}, updated_at = now() where id = ${id}`;
  return { ok: true, ...pub };
}


/* ================= agente de estoque ================= */
// Compara o estoque e o custo dos fornecedores com os anúncios do ML.
// Mudanças seguras (pausar quando zera, reativar o que o agente pausou, ajustar quantidade) são aplicadas sozinhas se sync_auto = 1.
// Preço fica pendente para o dono decidir. Produto que some do catálogo é pausado e volta quando reaparecer.
const skuNorm = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/^GBX-/, "");
const r2 = (x: number) => Math.round(x * 100) / 100;
async function settings() { const S: Record<string, number> = {}; for (const r of await sql`select k, v from radar.settings`) S[r.k] = Number(r.v); return S; }
async function myListings() {
  const me = await okGet("/users/me"); if (!me?.id) throw new Error("Conta do Mercado Livre não vinculada.");
  const ids: string[] = [];
  for (const st of ["active", "paused"]) for (let off = 0; off < 1000; off += 50) {
    const s = await okGet(`/users/${me.id}/items/search?status=${st}&limit=50&offset=${off}`); if (!s?.results?.length) break;
    ids.push(...s.results); if (off + 50 >= (s.paging?.total ?? 0)) break;
  }
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const r = await okGet(`/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,title,price,status,sub_status,available_quantity,seller_custom_field,attributes,variations,listing_type_id,category_id,permalink`);
    for (const x of r ?? []) if (x?.body?.id) out.push(x.body);
  }
  return out;
}
const FEEPCT = new Map<string, number>();
async function feePct(price: number, cat: string, type: string) {
  const k = `${cat}|${type}|${price >= 79 ? "a" : "b"}`; if (FEEPCT.has(k)) return FEEPCT.get(k)!;
  const f = await okGet(`/sites/MLB/listing_prices?price=${price}&category_id=${cat}&listing_type_id=${type}`); const o = Array.isArray(f) ? f[0] : f;
  const pct = Number(o?.sale_fee_details?.percentage_fee ?? 0); const fixed = Number(o?.sale_fee_details?.fixed_fee ?? 0);
  const v = pct + (price > 0 ? fixed / price * 100 : 0); FEEPCT.set(k, v); return v;
}

async function applyChange(c: any) {
  const a = c.after ?? {};
  try {
    if (a.available_quantity != null) { const r = await ml("PUT", `/items/${c.item_id}`, { available_quantity: a.available_quantity }); if (r.status >= 300) throw new Error(`estoque (${r.status}): ${r.body?.message ?? ""} ${(r.body?.cause ?? []).map((x: any) => x.message).join("; ")}`.trim()); }
    if (a.price != null) { const r = await ml("PUT", `/items/${c.item_id}`, { price: a.price }); if (r.status >= 300) throw new Error(`preço (${r.status}): ${r.body?.message ?? ""}`); }
    if (a.status) { const r = await ml("PUT", `/items/${c.item_id}`, { status: a.status }); if (r.status >= 300) throw new Error(`situação (${r.status}): ${r.body?.message ?? ""}`); }
    if (a.status === "paused") await sql`insert into radar.agent_paused (item_id, reason) values (${c.item_id}, ${c.reason ?? null}) on conflict (item_id) do update set at = now(), reason = excluded.reason`;
    if (a.status === "active") await sql`delete from radar.agent_paused where item_id = ${c.item_id}`;
    await sql`update radar.sync_changes set status = 'aplicado', applied_at = now(), error = null where id = ${c.id}`;
    return true;
  } catch (e) { await sql`update radar.sync_changes set status = 'erro', error = ${String((e as Error).message).slice(0, 400)} where id = ${c.id}`; return false; }
}

async function sync(b: any) {
  const S = await settings();
  const reserve = Math.max(0, S.sync_reserve ?? 2), cap = Math.max(1, S.sync_cap ?? 10);
  const auto = b.apply != null ? !!b.apply : (S.sync_auto ?? 1) === 1;
  // quantidade: desligado quando o fornecedor já sincroniza o estoque com o ML (ex.: GoBoox), para não brigar com ele
  const qtyOn = (S.sync_qty ?? 0) === 1;
  const SP = await sql`select supplier, sku, gtin, title, cost, stock, url, updated_at, first_seen from radar.supplier_prices`;
  const bySku = new Map<string, any>(), byGtin = new Map<string, any>();
  for (const r of SP) { const k = skuNorm(r.sku); if (!bySku.has(k) || r.updated_at > bySku.get(k).updated_at) bySku.set(k, r); if (r.gtin) byGtin.set(String(r.gtin), r); }
  const imps = await sql`select supplier, max(at) last, (array_agg(at order by at desc))[2] prev from radar.supplier_imports where full_catalog group by supplier`;
  const IMP = new Map(imps.map((r: any) => [r.supplier, r]));
  const pausedByAgent = new Set((await sql`select item_id from radar.agent_paused`).map((r: any) => r.item_id));
  const items = await myListings();
  const attr = (x: any, id: string) => (x.attributes ?? []).find((a: any) => a.id === id)?.value_name ?? null;
  const changes: any[] = [], unmatched: any[] = [], withVar: any[] = [], matchedSkus = new Set<string>();
  let matched = 0;
  for (const x of items) {
    const sku = attr(x, "SELLER_SKU") ?? x.seller_custom_field ?? null, gtin = attr(x, "GTIN");
    const sp = (sku && bySku.get(skuNorm(sku))) || (gtin && byGtin.get(String(gtin))) || null;
    const base = { item_id: x.id, title: x.title };
    if (!sp) { unmatched.push({ ...base, status: x.status, sku }); continue; }
    matched++; matchedSkus.add(sp.supplier + "|" + sp.sku);
    if ((x.variations ?? []).length) { withVar.push({ ...base, supplier: sp.supplier }); continue; }
    const before = { status: x.status, available_quantity: x.available_quantity, price: x.price, supplier: sp.supplier, supplier_stock: sp.stock, cost: sp.cost == null ? null : Number(sp.cost) };
    const imp: any = IMP.get(sp.supplier);
    const gone = imp && new Date(sp.updated_at).getTime() < new Date(imp.last).getTime() - 10 * 60e3;
    // sumiu do catálogo (sem estoque ou retirado): pausar é seguro e reversível; volta sozinho quando reaparecer
    if (gone) { if (x.status === "active") changes.push({ ...base, kind: "pausar", safe: true, before, after: { status: "paused" }, reason: `Não apareceu na última leitura completa de ${sp.supplier} (sem estoque ou retirado do catálogo).` }); continue; }
    if (sp.stock != null) {
      const want = Math.max(0, Math.min(cap, Number(sp.stock) - reserve));
      if (want === 0 && x.status === "active") changes.push({ ...base, kind: "pausar", safe: true, before, after: { status: "paused" }, reason: `${sp.supplier} tem ${sp.stock} (reserva de segurança ${reserve}).` });
      else if (want > 0 && x.status === "paused" && pausedByAgent.has(x.id)) changes.push({ ...base, kind: "reativar", safe: true, before, after: qtyOn ? { available_quantity: want, status: "active" } : { status: "active" }, reason: `Voltou a ter estoque em ${sp.supplier} (${sp.stock}).` });
      else if (qtyOn && want > 0 && x.status === "active" && x.available_quantity !== want) changes.push({ ...base, kind: "estoque", safe: true, before, after: { available_quantity: want }, reason: `${sp.supplier} tem ${sp.stock}. Publicado: ${sp.stock} − reserva ${reserve}, no máximo ${cap}.` });
    }
    // custo novo pode deixar o anúncio no prejuízo: sugere preço (não aplica sozinho)
    if (sp.cost != null && x.status === "active") {
      const cost = Number(sp.cost), extra = S.supplier_fee_order ?? 0, tax = S.tax_pct ?? 0;
      const ship = (p: number) => (p >= 79 ? S.ship_free_79 ?? 22 : S.ship_below_79 ?? 6.5);
      const fp = await feePct(x.price, x.category_id, x.listing_type_id);
      const margin = r2(x.price * (1 - fp / 100 - tax / 100) - ship(x.price) - cost - extra);
      if (margin < 0) {
        let p = x.price; for (let i = 0; i < 4; i++) { const f = await feePct(p, x.category_id, x.listing_type_id); p = (cost + extra + ship(p)) / (1 - f / 100 - tax / 100 - (S.target_margin_pct ?? 20) / 100); }
        const sug = Math.ceil(p) - 0.1;
        changes.push({ ...base, kind: "preco", safe: false, before, after: { price: r2(sug) }, reason: `Com custo de R$ ${cost.toFixed(2).replace(".", ",")} o anúncio dá prejuízo de R$ ${Math.abs(margin).toFixed(2).replace(".", ",")} por venda (frete estimado). Preço para ${S.target_margin_pct ?? 20}% de margem: R$ ${sug.toFixed(2).replace(".", ",")}.` });
      }
    }
  }
  // produtos novos no fornecedor e catálogo ainda não anunciado
  const newProducts: any[] = []; let notListed = 0;
  for (const r of SP) {
    if (matchedSkus.has(r.supplier + "|" + r.sku) || !(Number(r.stock ?? 0) > 0)) continue;
    notListed++;
    const imp: any = IMP.get(r.supplier);
    if (imp?.prev && new Date(r.first_seen).getTime() > new Date(imp.prev).getTime()) newProducts.push({ supplier: r.supplier, sku: r.sku, title: r.title, cost: r.cost == null ? null : Number(r.cost), stock: r.stock, url: r.url });
  }
  // grava a rodada; pendências antigas viram "substituído"
  const run = (await sql`insert into radar.sync_runs (source, auto) values (${String(b.source ?? "manual").slice(0, 40)}, ${auto}) returning id`)[0].id;
  await sql`update radar.sync_changes set status = 'substituido' where status in ('pendente','erro')`;
  const saved: any[] = [];
  for (const c of changes) {
    const r = await sql`insert into radar.sync_changes (run_id, item_id, title, kind, safe, before, after, reason) values (${run}, ${c.item_id}, ${c.title}, ${c.kind}, ${c.safe}, ${sql.json(c.before)}, ${sql.json(c.after)}, ${c.reason}) returning id`;
    saved.push({ ...c, id: r[0].id });
  }
  let applied = 0, errors = 0;
  if (auto) for (const c of saved.filter((c) => c.safe)) (await applyChange(c)) ? applied++ : errors++;
  const count = (k: string) => changes.filter((c) => c.kind === k).length;
  const summary = { items: items.length, matched, unmatched: unmatched.length, with_variations: withVar.length, pausar: count("pausar"), reativar: count("reativar"), estoque: count("estoque"), preco: count("preco"), sumiu: count("sumiu"),
    applied, errors, pending: changes.filter((c) => !c.safe || !auto).length, new_products: newProducts.length, not_listed: notListed, reserve, cap, auto, qty: qtyOn,
    suppliers: [...new Set(SP.map((r: any) => r.supplier))].map((s) => ({ supplier: s, items: SP.filter((r: any) => r.supplier === s).length, last_full: (IMP.get(s) as any)?.last ?? null, updated_at: SP.filter((r: any) => r.supplier === s).reduce((m: any, r: any) => (r.updated_at > m ? r.updated_at : m), null) })),
    new_list: newProducts.slice(0, 30), unmatched_list: unmatched.slice(0, 50), variations_list: withVar.slice(0, 30) };
  await sql`update radar.sync_runs set summary = ${sql.json(summary)} where id = ${run}`;
  return { ok: true, run_id: Number(run), ...summary };
}

async function applyIds(ids: number[]) {
  const rows = await sql`select id, item_id, title, kind, after, reason from radar.sync_changes where id = any(${ids}) and status in ('pendente','erro')`;
  let ok = 0, err = 0; for (const c of rows) (await applyChange(c)) ? ok++ : err++;
  return { ok: true, applied: ok, errors: err };
}
async function agent() {
  const S = await settings();
  const runs = await sql`select id, at, source, auto, summary from radar.sync_runs order by id desc limit 10`;
  const pending = await sql`select id, run_id, item_id, title, kind, safe, before, after, reason, status, error, at from radar.sync_changes where status in ('pendente','erro') order by safe, kind, id`;
  const recent = await sql`select id, item_id, title, kind, safe, before, after, reason, status, error, at, applied_at from radar.sync_changes where status in ('aplicado','ignorado') order by coalesce(applied_at, at) desc limit 40`;
  const paused = await sql`select item_id, at, reason from radar.agent_paused order by at desc`;
  const sup = await sql`select supplier, count(*)::int items, max(updated_at) updated_at, sum((coalesce(stock,0) > 0)::int)::int in_stock from radar.supplier_prices group by supplier order by 3 desc`;
  return { ok: true, settings: { sync_reserve: S.sync_reserve ?? 2, sync_cap: S.sync_cap ?? 10, sync_auto: S.sync_auto ?? 1, sync_qty: S.sync_qty ?? 0 }, runs, pending, recent, paused, suppliers: sup };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  if (req.headers.get("x-radar-key") !== (await key())) return json({ error: "não autorizado" }, 401);
  try {
    const b = await req.json();
    if (b.action === "prepare") return json(await prepare(Number(b.id)));
    if (b.action === "upload") return json(await upload(b));
    if (b.action === "validate") return json(await validate(b));
    if (b.action === "publish") return json(await publish(b));
    if (b.action === "sync") return json(await sync(b));
    if (b.action === "apply") return json(await applyIds((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean)));
    if (b.action === "ignore") { const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean); await sql`update radar.sync_changes set status = 'ignorado', applied_at = now() where id = any(${ids}) and status in ('pendente','erro')`; return json({ ok: true }); }
    if (b.action === "agent") return json(await agent());
    if (b.action === "scopes") { const r = await ml("GET", "/users/me"); return json({ ok: r.status === 200, nickname: r.body?.nickname ?? null }); }
    return json({ error: "ação inválida" }, 400);
  } catch (e) { return json({ ok: false, error: String((e as Error).message ?? e) }, 200); }
});
