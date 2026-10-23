import postgres from "npm:postgres@3.4.4";

// Entrada de preços de fornecedor (sup_key) e capturas da extensão do Chrome (ext_key): anúncios do ML, rascunhos e fornecedores do Quem Fornece.
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

/* ---------- rascunho de anúncio melhor (a partir de um concorrente) ---------- */
const STOP = new Set("de da do das dos com para por em e a o as os um uma kit cor sem mais muito super com novo nova original 1 2 3 un unidade unidades".split(" "));
const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// "à prova d'água" vira um termo só, senão o título quebra em "Prova Água"
const PHRASES: [RegExp, string][] = [[/\b(a )?prova (de |d )?agua\b|\bprova ?dagua\b/g, "provadagua"]];
const SHOW: Record<string, string> = { provadagua: "à Prova D'água" };
const words = (s: string) => { let t = norm(s).replace(/[’'`´]/g, " "); for (const [re, k] of PHRASES) t = t.replace(re, k); return t.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)); };
// grafia original (com acento) de cada termo, para o título sair escrito certo
function spellings(texts: string[]) {
  const M: Record<string, Record<string, number>> = {};
  for (const t of texts) for (const o of String(t ?? "").split(/[^0-9A-Za-zÀ-ÿ]+/)) { if (o.length < 3) continue; const k = norm(o); (M[k] ??= {})[o.toLowerCase()] = (M[k][o.toLowerCase()] ?? 0) + 1; }
  // forma com acento ganha sempre (concorrente costuma escrever sem acento)
  const acc = (w: string) => (w !== norm(w) ? 1 : 0);
  const out: Record<string, string> = {}; for (const [k, v] of Object.entries(M)) out[k] = Object.entries(v).sort((a, b) => acc(b[0]) - acc(a[0]) || b[1] - a[1])[0][0];
  return out;
}
function simT(a: string, b: string) { const A = new Set(words(a)), B = new Set(words(b)); if (!A.size || !B.size) return 0; let n = 0; A.forEach((w) => { if (B.has(w)) n++; }); return 2 * n / (A.size + B.size); }
let SP: Record<string, string> = {};
// acentos comuns em títulos do ML, quando nenhum texto lido traz a forma certa
const ACC: Record<string, string> = Object.fromEntries("cabeça água elétrico elétrica portátil tática tático recarregável automático automática magnético magnética plástico térmico térmica cerâmica luminária lâmpada máquina câmera música médio média pé pés mão mãos ônibus caminhão balcão colchão algodão silicone pressão proteção iluminação decoração cozinha escritório banheiro jardim pássaro cão gatos infantil bebê útil fácil rápido rápida prático prática ajustável dobrável lavável resistente higiênico óculos relógio".split(" ").map((w) => [norm(w), w]));
const show = (w: string) => { if (SHOW[w]) return SHOW[w]; const sp = SP[w]; if (sp && sp !== norm(sp)) return sp; return ACC[w] ?? sp ?? w; };
const cap = (s: string) => s.split(" ").map((w) => { if (SHOW[w]) return SHOW[w]; const o = show(w); return o.length > 2 ? o[0].toUpperCase() + o.slice(1) : o; }).join(" ");
function weightG(attrs: any[]) {
  const a = attrs.find((x) => /^peso/i.test(x.name)); if (!a) return null;
  const m = /([\d.,]+)\s*(kg|g)\b/i.exec(a.value); if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, "").replace(",", ".")); return Math.round(m[2].toLowerCase() === "kg" ? n * 1000 : n);
}
function dimsOf(attrs: any[]) {
  const get = (re: RegExp) => { const a = attrs.find((x) => re.test(x.name)); const m = a && /([\d.,]+)\s*cm/i.exec(a.value); return m ? Math.ceil(parseFloat(m[1].replace(",", "."))) : null; };
  const c = get(/^comprimento/i), l = get(/^largura|^di[aâ]metro/i), h = get(/^altura/i) ?? l;
  return c && l && h ? `${c}x${l}x${h}` : null;
}
async function draft(L: any) {
  const title = String(L.title ?? "").trim().slice(0, 200);
  if (!title) throw new Error("anúncio sem título");
  const attrs = (Array.isArray(L.attributes) ? L.attributes : []).slice(0, 80).map((a: any) => ({ name: String(a.name).slice(0, 80), value: String(a.value).slice(0, 200), group: a.group ?? null }));
  const core = words(title).slice(0, 3);
  const pat = "%" + core.filter((w) => !SHOW[w]).slice(0, 2).join("%") + "%";
  const rel = await sql`select distinct on (item_id) item_id, title, sold_min from radar.item_snapshots where title ilike ${pat} and source like 'ext%' order by item_id, captured_at desc`;
  const top = rel.filter((r: any) => r.title).sort((a: any, b: any) => (b.sold_min ?? 0) - (a.sold_min ?? 0)).slice(0, 40);
  SP = spellings([title, ...top.map((r: any) => r.title), ...attrs.map((a: any) => a.value)]);
  // palavras que os anúncios que mais vendem usam (peso pelo log das vendas)
  const W: Record<string, number> = {};
  for (const r of [{ title, sold_min: L.sold_min ?? 100 }, ...top]) { const w = Math.log10((r.sold_min ?? 0) + 10); for (const t of new Set(words(r.title))) W[t] = (W[t] ?? 0) + w; }
  const kw = Object.entries(W).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const build = (seed: string[], pool: string[]) => { const out: string[] = []; let len = 0; for (const t of [...seed, ...pool]) { if (out.includes(t)) continue; const L2 = show(t).length; if (len + L2 + 1 > 60) continue; out.push(t); len += L2 + 1; } return cap(out.join(" ")); };
  const t1 = build(core, kw);
  const t2 = build(core.slice(0, 2), kw.filter((k) => !core.includes(k)).reverse().slice(-12).reverse());
  const attrWords = attrs.filter((a: any) => /sim|n[aã]o/i.test(a.value) === false).flatMap((a: any) => words(a.value)).filter((w: string) => w.length > 3);
  const t3 = build(core, [...attrWords.filter((w: string) => W[w]), ...kw]);
  const titles = [...new Set([t1, t2, t3])].filter(Boolean);
  // reclamações dos compradores do concorrente
  const NEG_STOP = new Set(words("produto comprei chegou veio muito pouco bem bom boa ruim pra pois porque quando ainda mesmo nada tudo depois antes dias ser esta isso aqui achei gostei recomendo veio funciona funcionou nao mas tem fica ficou vem foi era estava ela ele elas eles uma uns umas meu minha sua seu voce vou vai fiz faz sim agora tambem entao ate sobre qualidade preco valor"));
  // tira as linhas de aspecto elogiado ("Iluminação: excelente.") que o ML inclui nas avaliações
  const negs: string[] = (Array.isArray(L.negatives) ? L.negatives : []).slice(0, 40).map((t: any) => String(t).slice(0, 400).split(/\n+/).filter((ln) => !/^[^:]{3,30}:\s*(excelente|[oó]tim[ao]|boa|bom|muito bo[am]|perfeit[ao])\.?\s*$/i.test(ln.trim())).map((ln) => ln.trim().replace(/^[A-Za-zÀ-ÿ ]{3,30}:\s*/, "")).join("\n").trim()).filter(Boolean);
  for (const [k, v] of Object.entries(spellings(negs))) if (!SP[k] || (SP[k] === norm(SP[k]) && v !== norm(v))) SP[k] = v;
  const NW: Record<string, number> = {}; for (const t of negs) for (const w of new Set(words(t))) if (!NEG_STOP.has(w)) NW[w] = (NW[w] ?? 0) + 1;
  const pains = Object.entries(NW).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => ({ word: show(w), count: n, example: negs.find((t) => norm(t).includes(w))?.slice(0, 160) ?? null }));
  // o que fazer melhor que o concorrente
  const check: string[] = [];
  const photos = Number(L.photos ?? 0);
  check.push(photos >= 8 ? `Ele tem ${photos} fotos: use pelo menos ${photos}, com fundo branco na principal e fotos de uso.` : `Ele tem só ${photos} foto(s): use 8 ou mais (principal com fundo branco, detalhes, medidas e uso).`);
  if (!L.has_video) check.push("Ele não tem vídeo: um clipe curto mostrando o produto funcionando ajuda a converter.");
  check.push(`Preencha a ficha técnica inteira (${attrs.length} campos no dele). Ficha completa aparece em mais filtros de busca.`);
  if ((L.description_len ?? 0) < 400) check.push("A descrição dele é curta: escreva uma completa, com medidas, o que vem na caixa e dúvidas comuns.");
  if (pains.length) check.push(`Compradores dele reclamam de: ${pains.map((p) => p.word).join(", ")}. Responda isso na descrição (sem prometer o que o produto não faz).`);
  if (L.full) check.push("Ele usa Full (entrega rápida). Se você não tiver Full, compense com preço ou com prazo de despacho curto.");
  if (L.catalog_product_id) check.push(`Ele está no catálogo (${L.catalog_product_id}). Você pode anunciar no mesmo produto de catálogo e disputar a mesma página.`);
  // descrição base (para revisar)
  const feat = attrs.filter((a: any) => !/^(marca|modelo)$/i.test(a.name)).slice(0, 12);
  const desc = [
    t1.toUpperCase(), "",
    "POR QUE ESCOLHER", ...feat.slice(0, 5).map((a: any) => `• ${a.name}: ${a.value}`), "",
    "FICHA TÉCNICA", ...feat.map((a: any) => `• ${a.name}: ${a.value}`), "",
    "O QUE VEM NA CAIXA", "• [preencher]", "",
    ...(pains.length ? ["DÚVIDAS FREQUENTES", ...pains.slice(0, 4).map((p) => `• Sobre ${p.word}: [responda com o que o seu produto entrega]`), ""] : []),
    "ENVIO E GARANTIA", "• Envio em até [X] dia útil após a confirmação do pagamento.", "• Garantia de [X] dias contra defeitos de fabricação.",
  ].join("\n");
  const d = { from: { item_id: L.item_id, url: L.url, title, price: L.price, sold_label: L.sold_label, sold_min: L.sold_min, reviews: L.reviews_total, rating: L.rating, full: !!L.full, free_shipping: !!L.free_shipping, photos, has_video: !!L.has_video, attributes_count: attrs.length, description_len: L.description_len ?? 0, oldest_days: L.oldest_days ?? null, first_review: typeof L.first_review === "string" ? L.first_review.slice(0, 30) : null, neg_count: L.neg_count ?? null, neg_pct: L.neg_pct ?? null, last30_reviews_est: L.last30_reviews_est ?? null, category_path: (L.category_path ?? []).slice(0, 8) },
    titles, keywords: kw.slice(0, 15).map(show), related_listings: top.length, attributes: attrs, highlights: (L.highlights ?? []).slice(0, 12), pains, checklist: check, description: desc, created_at: new Date().toISOString() };
  const ins = await sql`insert into radar.products (name, ml_query, ml_product_id, category_id, weight_g, dims, stage, draft, source_url)
    values (${t1 || title.slice(0, 120)}, ${core.join(" ")}, ${L.catalog_product_id ?? null}, ${L.category_id ?? null}, ${weightG(attrs)}, ${dimsOf(attrs)}, 'filtrar', ${sql.json(d)}, ${txt(L.url, 300)}) returning id`;
  const pid = ins[0].id;
  // liga fornecedor da GoBoox se tiver produto parecido
  const sp = await sql`select supplier, sku, title, cost, stock, updated_at from radar.supplier_prices where cost is not null`;
  const best = sp.map((r: any) => ({ r, s: simT(title, r.title ?? "") })).filter((x: any) => x.s >= 0.6).sort((a: any, b: any) => b.s - a.s)[0];
  if (best) {
    const v = await sql`select id from radar.vendors where lower(name) = lower(${best.r.supplier}) limit 1`;
    if (v.length) await sql`insert into radar.product_offers (product_id, vendor_id, cost, stock, confirmed_at, notes) values (${pid}, ${v[0].id}, ${best.r.cost}, ${best.r.stock}, ${best.r.updated_at}, ${"sku:" + best.r.sku + " (parecido " + Math.round(best.s * 100) + "%)"}) on conflict do nothing`;
  }
  return { ok: true, id: Number(pid), supplier_match: best ? { title: best.r.title, cost: Number(best.r.cost), similarity: Math.round(best.s * 100) } : null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  try {
    const b = JSON.parse(await req.text());
    if (b?.kind === "snap" || b?.kind === "est" || b?.kind === "qf" || b?.kind === "draft") {
      if (!b.k || b.k !== await key("ext_key")) return json({ error: "não autorizado" }, 401);
      if (b.kind === "draft") return json(await draft(b.listing ?? {}));
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
