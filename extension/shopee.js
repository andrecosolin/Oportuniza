// Oportuniza na Shopee: lê a busca aberta (título, preço, vendidos, cidade) e grava no Oportuniza.
// Só lê o que aparece na tela; a Shopee não tem API aberta de mercado.
(() => {
  if (window.__radarSHP) return;
  window.__radarSHP = true;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (body) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "radar", body }, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "sem resposta" })); } catch (e) { res({ ok: false, error: String(e.message || e) }); } });
  const brl = (n) => (n == null ? "–" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  const short = (n) => (n == null ? "–" : n >= 1000 ? (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : String(Math.round(n)));
  const median = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  function soldOf(t) {
    const m = /([\d.,]+)\s*(mil)?\+?\s*vendid/i.exec(t); if (!m) return null;
    let n = parseFloat(m[1].replace(/\./g, "").replace(",", ".")); if (m[2]) n *= 1000; return Math.round(n);
  }
  function parseCards(doc) {
    const out = new Map();
    for (const g of doc.querySelectorAll('[role="group"][aria-label^="Product card"]')) {
      const a = g.querySelector('a[href*="-i."]'); if (!a) continue;
      const m = /-i\.(\d+)\.(\d+)/.exec(a.getAttribute("href") || ""); if (!m) continue;
      const id = m[1] + "." + m[2]; if (out.has(id)) continue;
      const txt = g.innerText.replace(/\n/g, " | ");
      const title = (g.getAttribute("aria-label") || "").replace(/^Product card:\s*/, "").trim();
      const pm = /R\$\s*\|?\s*([\d.]+,\d{2})/.exec(txt);
      const sl = /([\d.,]+\s*(?:mil)?\+?\s*vendid\w*(?:\(s\))?)/i.exec(txt);
      const rt = /\|\s*([1-5][.,]\d)\s*(?:\||\d)/.exec(txt);
      const parts = txt.split(" | ").map((s) => s.trim());
      const simIdx = parts.lastIndexOf("Similares");
      const loc = simIdx > 0 && !/vendid|R\$|%|^\d/.test(parts[simIdx - 1]) ? parts[simIdx - 1] : null;
      out.set(id, { id, title, price: pm ? parseFloat(pm[1].replace(/\./g, "").replace(",", ".")) : null, sold_label: sl ? sl[1] : null, sold_min: soldOf(txt), rating: rt ? parseFloat(rt[1].replace(",", ".")) : null, location: loc, url: "https://shopee.com.br" + (a.getAttribute("href") || "").split("?")[0] });
    }
    return [...out.values()];
  }
  window.__radarShopeeParse = parseCards;

  let panel;
  function getPanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = "radarml-panel";
    panel.innerHTML = `<div class="rml-head"><b>Oportuniza</b><span class="rml-st"></span><button class="rml-min" title="Minimizar">–</button></div><div class="rml-body"></div>`;
    panel.querySelector(".rml-min").onclick = () => panel.classList.toggle("rml-closed");
    document.body.appendChild(panel);
    return panel;
  }
  const status = (t) => { getPanel().querySelector(".rml-st").textContent = t; };
  const body = (h) => { getPanel().querySelector(".rml-body").innerHTML = h; };

  let term = "", items = new Map(), sentCount = 0, timer = null;
  function summary(list) {
    const sold = list.map((x) => x.sold_min ?? 0);
    const top = [...list].sort((a, b) => (b.sold_min ?? 0) - (a.sold_min ?? 0));
    return { n: list.length, sold_median_top20: median(top.slice(0, 20).map((x) => x.sold_min ?? 0)), sold_total: sold.reduce((s, x) => s + x, 0), over_1k: list.filter((x) => (x.sold_min ?? 0) >= 1000).length, price_median: median(list.map((x) => x.price)), price_min: Math.min(...list.map((x) => x.price ?? Infinity)), top: top.slice(0, 5).map((x) => ({ title: x.title, price: x.price, sold_min: x.sold_min })) };
  }
  function render(s, saved, err) {
    body(`<p class="rml-sub">Shopee: “${esc(term)}” · ${s.n} anúncios lidos</p>
      <div class="rml-grid">
        <div><small>Vendidos (mediana top 20)</small><b>${short(s.sold_median_top20)}</b></div>
        <div><small>Com +1 mil vendidos</small><b>${s.over_1k}</b></div>
        <div><small>Preço mediano</small><b>${brl(s.price_median)}</b></div>
      </div>
      <p class="rml-note">${s.top.slice(0, 3).map((x) => `${esc(x.title.slice(0, 48))}… <b>${short(x.sold_min)}</b> · ${brl(x.price)}`).join("<br>")}</p>
      ${err ? `<p class="rml-err">${esc(err)}</p>` : `<p class="rml-note">${saved ? "Gravado no Oportuniza." : "Role a página para eu ler mais anúncios."}</p>`}`);
  }
  async function flush() {
    const list = [...items.values()];
    if (list.length < 5 || list.length === sentCount) return;
    const s = summary(list);
    status("gravando…");
    const r = await send({ kind: "sig", source: "shopee", term, geo: "BR", data: { ...s, items: list.slice(0, 120) } });
    sentCount = list.length;
    status(r.ok ? "gravado" : "não gravado");
    render(s, r.ok, r.ok ? null : r.error);
  }
  function scan() {
    const u = new URL(location.href);
    if (!/^\/search/.test(u.pathname)) return;
    const k = (u.searchParams.get("keyword") || "").trim(); if (!k) return;
    if (k !== term) { term = k; items = new Map(); sentCount = 0; status("lendo…"); body(`<p class="rml-sub">Lendo a busca “${esc(k)}”…</p>`); }
    const before = items.size;
    for (const x of parseCards(document)) if (!items.has(x.id)) items.set(x.id, x);
    if (items.size !== before) { clearTimeout(timer); timer = setTimeout(flush, 2500); if (items.size >= 5) render(summary([...items.values()]), false); }
  }
  setInterval(scan, 1500);
  scan();
})();
