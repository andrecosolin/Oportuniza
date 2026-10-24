// Oportuniza na GoBoox: o agente lê o catálogo inteiro (custo e estoque), envia ao Oportuniza
// e compara com os seus anúncios do Mercado Livre. As mudanças seguras são aplicadas sozinhas.
(() => {
  if (window.__radarGBX) return;
  window.__radarGBX = true;
  const APP = "https://andrecosolin.github.io/Oportuniza/";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (body) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "radar", body }, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "sem resposta" })); } catch (e) { res({ ok: false, error: String(e.message || e) }); } });
  const token = () => { try { return JSON.parse(localStorage.getItem("auth-storage")).state.token || null; } catch { return null; } };

  let panel;
  function getPanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = "radarml-panel";
    panel.innerHTML = `<div class="rml-head"><b>Oportuniza</b><span class="rml-st"></span><button class="rml-min" title="Minimizar">–</button></div><div class="rml-body"></div>`;
    panel.querySelector(".rml-min").onclick = () => { panel.classList.toggle("rml-closed"); try { localStorage.setItem("radarml-min", panel.classList.contains("rml-closed") ? "1" : ""); } catch {} };
    try { if (localStorage.getItem("radarml-min")) panel.classList.add("rml-closed"); } catch {}
    document.body.appendChild(panel);
    return panel;
  }
  const status = (t) => { getPanel().querySelector(".rml-st").textContent = t; };
  const body = (h) => { getPanel().querySelector(".rml-body").innerHTML = h; };

  function idle(msg) {
    body(`<p class="rml-sub">Agente de estoque</p>
      <p class="rml-note" style="margin-top:0">Lê o catálogo da GoBoox, confere com os seus anúncios do Mercado Livre e ajusta sozinho: pausa o que zerou e reativa o que voltou. Preço fica para você decidir.</p>
      ${msg ? `<p class="rml-err">${esc(msg)}</p>` : ""}
      <button class="rml-btn" id="rmlScan">Varrer estoque agora</button>`);
    getPanel().querySelector("#rmlScan").onclick = scan;
  }

  async function readCatalog(tok, prog) {
    const all = new Map(); let page = 1, step = 1, n = 0;
    while (n++ < 600) {
      const r = await fetch(`https://api.goboox.com.br/v3/catalog/products?page=${page}&step=${step}&sort=sales_desc`, { headers: { authorization: "Bearer " + tok } });
      if (r.status === 401) throw new Error("A GoBoox pediu login de novo. Entre e tente outra vez.");
      if (!r.ok) throw new Error("GoBoox respondeu " + r.status);
      const j = await r.json(), p = j.pagination || {};
      for (const x of j.products || []) all.set(x.id, { sku: String(x.id), title: x.name, cost: x.price, stock: x.stock, gtin: x.ean || x.gtin || "" });
      prog(all.size);
      if (p.has_next_step) step = p.next_step; else if (p.has_next_page) { page = p.next_page; step = 1; } else return { items: [...all.values()], complete: true };
      await new Promise((res) => setTimeout(res, 150));
    }
    return { items: [...all.values()], complete: false };
  }

  async function scan() {
    const tok = token();
    if (!tok) { idle("Entre na sua conta da GoBoox primeiro."); return; }
    const btn = getPanel().querySelector("#rmlScan"); if (btn) btn.disabled = true;
    try {
      status("lendo catálogo…");
      const cat = await readCatalog(tok, (n) => body(`<p class="rml-sub">Lendo o catálogo da GoBoox… ${n} produtos</p>`));
      status("comparando com o ML…");
      body(`<p class="rml-sub">Li ${cat.items.length} produtos. Comparando com os seus anúncios do Mercado Livre…</p>`);
      const r = await send({ kind: "gbx", items: cat.items, full: cat.complete });
      if (!r.ok) throw new Error(r.error);
      const s = r.data;
      status("pronto");
      const line = (n, t) => (n ? `<div><small>${t}</small><b>${n}</b></div>` : "");
      body(`<p class="rml-sub">Varredura concluída: ${s.items} anúncios conferidos, ${s.matched} ligados à GoBoox.</p>
        <div class="rml-grid">
          ${line(s.pausar, "Pausados (zerou)")}${line(s.reativar, "Reativados")}${line(s.estoque, "Estoque ajustado")}
          ${line(s.preco, "Preço para revisar")}${line(s.new_products, "Novos na GoBoox")}
          ${s.pausar + s.reativar + s.estoque + s.preco === 0 ? `<div style="grid-column:span 3"><small>Resultado</small><b>Tudo em dia</b></div>` : ""}
        </div>
        ${s.auto ? `<p class="rml-note">${s.applied} mudança(s) aplicada(s) no ML${s.errors ? `, ${s.errors} com erro` : ""}.</p>` : `<p class="rml-note">Modo revisão: nada foi alterado no ML.</p>`}
        ${s.pending ? `<p class="rml-note">${s.pending} item(ns) esperando você no Oportuniza.</p>` : ""}
        ${!cat.complete ? `<p class="rml-err">A leitura parou antes do fim do catálogo, então não pausei o que não apareceu.</p>` : ""}
        <button class="rml-btn" id="rmlOpen">Abrir o agente no Oportuniza</button>`);
      getPanel().querySelector("#rmlOpen").onclick = () => window.open(APP + "#agente", "_blank", "noopener");
    } catch (e) {
      status("erro");
      idle("Não deu certo: " + (e.message || e));
    }
  }

  status("");
  idle();
})();
