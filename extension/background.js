// Oportuniza: envia as capturas para o Supabase (função sup) e devolve as estimativas.
const ENDPOINT = "https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/sup";

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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
