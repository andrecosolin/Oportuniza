// Oportuniza: envia as capturas para o Supabase (função sup) e devolve as estimativas.
const ENDPOINT = "https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/sup";

async function reviewsScan(itemId) {
  // A lista padrão do ML só traz avaliações com comentário e quase só 4 e 5 estrelas; as de 1 a 3 vêm pelo filtro rating.
  const out = { pages: 0, items: [] }, seen = new Set();
  const cd = (x) => x.comment?.menu_options?.items?.[0]?.track?.event_data?.review?.created_date || x.comment?.denounce?.track?.event_data?.review?.created_date || null;
  for (const rating of [null, 1, 2, 3]) {
    for (let off = 0; off < (rating ? 150 : 600); off += 15) {
      const r = await fetch(`https://www.mercadolivre.com.br/noindex/catalog/reviews/${itemId}/search?objectId=${itemId}&siteId=MLB&isItem=true&offset=${off}&limit=15${rating ? "&rating=" + rating : ""}`);
      if (!r.ok) break;
      let j; try { j = await r.json(); } catch { break; }
      const rs = j.reviews || []; out.pages++;
      if (!rs.length) break;
      for (const x of rs) { if (seen.has(x.id)) continue; seen.add(x.id); out.items.push({ rating: x.rating, created: cd(x), date: (x.comment?.date || "").trim(), text: (x.comment?.content?.text || "").slice(0, 400) }); }
      if (rs.length < 15) break;
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "reviews") { reviewsScan(String(msg.id || "")).then((r) => reply({ ok: true, data: r })).catch((e) => reply({ ok: false, error: String(e.message || e) })); return true; }
  if (msg?.type !== "radar") return;
  (async () => {
    const { paused, key } = await chrome.storage.local.get(["paused", "key"]);
    if (!key) { reply({ ok: false, error: "falta a chave: toque no ícone da extensão e cole a chave que está em Oportuniza > Minha conta > Acessos." }); return; }
    const body = { k: key, ...msg.body };
    if (paused && body.kind === "snap") { body.kind = "est"; body.ids = (body.items || []).map((x) => x.item_id); delete body.items; }
    try {
      const r = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "erro " + r.status);
      if (body.kind === "snap") {
        const s = await chrome.storage.local.get(["sent", "pages"]);
        await chrome.storage.local.set({ sent: (s.sent || 0) + (j.saved || 0), pages: (s.pages || 0) + 1, last: Date.now() });
      }
      reply({ ok: true, data: j, paused: !!paused });
    } catch (e) { reply({ ok: false, error: String(e.message || e) }); }
  })();
  return true;
});
