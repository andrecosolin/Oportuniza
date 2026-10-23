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
const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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

/* ---------- foto: sobe para o ML e devolve o id ---------- */
async function upload(b: any) {
  const data = String(b.data ?? ""); const type = String(b.type ?? "image/jpeg");
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error("Use foto JPG, PNG ou WEBP.");
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
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
  return { title, category_id: String(b.category_id), price, currency_id: "BRL", available_quantity: qty, buying_mode: "buy_it_now",
    listing_type_id: b.listing_type_id === "gold_pro" ? "gold_pro" : "gold_special", condition: "new", pictures: pics.map((id: string) => ({ id })), attributes, sale_terms };
}
const causes = (body: any) => (body?.cause ?? []).filter((c: any) => c.type !== "warning" || true).map((c: any) => ({ type: c.type, code: c.code, message: c.message, refs: c.references ?? [] }));

async function validate(b: any) {
  const item = buildItem(b);
  const r = await ml("POST", "/items/validate", item);
  const fees = await okGet(`/sites/MLB/listing_prices?price=${item.price}&category_id=${item.category_id}&listing_type_id=${item.listing_type_id}`);
  const fee = Array.isArray(fees) ? fees[0] : fees;
  return { ok: r.status === 204 || r.status === 200, status: r.status, causes: r.status === 204 ? [] : causes(r.body), message: r.body?.message ?? null, fee: fee?.sale_fee_amount ?? null, fee_pct: fee?.sale_fee_details?.percentage_fee ?? null };
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
  const pub = { item_id: itemId, permalink: r.body.permalink ?? null, status: b.paused ? "paused" : r.body.status, at: new Date().toISOString(), title: item.title, price: item.price, steps };
  await sql`update radar.products set linked_item_id = ${itemId}, stage = case when stage in ('descobrir','filtrar') then 'validar' else stage end, draft = coalesce(draft, '{}'::jsonb) || ${sql.json({ published: pub })}, updated_at = now() where id = ${id}`;
  return { ok: true, ...pub };
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
    if (b.action === "scopes") { const r = await ml("GET", "/users/me"); return json({ ok: r.status === 200, nickname: r.body?.nickname ?? null }); }
    return json({ error: "ação inválida" }, 400);
  } catch (e) { return json({ ok: false, error: String((e as Error).message ?? e) }, 200); }
});
