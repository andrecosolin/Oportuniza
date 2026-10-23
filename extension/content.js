// Oportuniza: lê a página do Mercado Livre, envia ao Oportuniza e mostra as estimativas.
(() => {
  if (window.__radarML) return;
  window.__radarML = true;
  const P = window.RadarParse;
  const brl = (v, d = 0) => v == null ? "–" : "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const int = (v) => v == null ? "–" : Math.round(v).toLocaleString("pt-BR");
  const short = (v) => v == null ? "–" : v >= 1e6 ? (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi" : v >= 1e3 ? (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : int(v);
  const brlS = (v) => v == null ? "–" : "R$ " + short(v);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const APP = "https://andrecosolin.github.io/Oportuniza/";
  const askReviews = (id) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "reviews", id }, (r) => res(r || { ok: false })); } catch (e) { res({ ok: false }); } });
  const ageTxt = (d) => { if (d == null) return "–"; const y = Math.floor(d / 365), m = Math.floor((d % 365) / 30); if (y) return `${y} ano${y > 1 ? "s" : ""}${m ? ` e ${m} ${m > 1 ? "meses" : "mês"}` : ""}`; if (m) return `${m} ${m > 1 ? "meses" : "mês"}`; return `${d} dia${d === 1 ? "" : "s"}`; };
  const dBR = (iso) => iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";
  function summarizeReviews(items, totalReviews) {
    const now = Date.now();
    const days = items.map((x) => (x.created ? Math.floor((now - Date.parse(x.created)) / 864e5) : P.relDays(x.date))).filter((d) => d != null && !isNaN(d));
    const oldest = days.length ? Math.max(...days) : null;
    const first = items.map((x) => x.created).filter(Boolean).sort()[0] || null;
    const pos = items.filter((x) => x.rating >= 4);
    const last30 = items.filter((x) => x.rating >= 4 && x.created && now - Date.parse(x.created) < 30 * 864e5).length;
    const neg = items.filter((x) => x.rating <= 3 && x.text);
    const negTotal = items.filter((x) => x.rating <= 3).length;
    const factor = totalReviews && items.length ? totalReviews / items.length : 1;
    const negLast90 = neg.filter((x) => x.created && now - Date.parse(x.created) < 90 * 864e5).length;
    return { scanned: items.length, first_review: first, oldest_days: oldest, last30_comments: last30, last30_reviews_est: Math.round(last30 * (totalReviews && pos.length ? Math.max(1, (totalReviews - negTotal) / pos.length) : factor)), neg_count: negTotal, neg_pct: items.length ? Math.round((negTotal / items.length) * 1000) / 10 : null, neg_last90: negLast90, negatives: neg.map((x) => x.text).slice(0, 40) };
  }
  const send = (body) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "radar", body }, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "sem resposta" })); } catch (e) { res({ ok: false, error: String(e.message || e) }); } });

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

  function estLine(e, x) {
    if (!e) return "";
    if (e.est_month != null) return `<b>~${int(e.est_month)}/mês</b> <i>(${esc(e.basis)})</i>`;
    const rv = x?.reviews ?? e.reviews;
    if (rv) return `≈ ${short(rv * 10)} vendas no total <i>(avaliações × 10)</i>`;
    return e.observations > 1 ? `acompanhando há ${Math.max(1, Math.round(e.days_tracked))}d, sem variação` : `1ª leitura: volte amanhã para ver vendas/dia`;
  }

  /* ---------- página de busca / categoria ---------- */
  async function runList() {
    const list = P.parseList(document, true);
    if (!list.length) return false;
    const query = decodeURIComponent((location.pathname.split("/")[1] || "").replace(/_.*$/, "")).replace(/-/g, " ") || document.title;
    status("enviando…");
    renderList(list, {});
    const r = await send({ kind: "snap", page: "list", query, items: list.map((x) => ({ ...x })) });
    if (!r.ok) { status("erro"); body(`<p class="rml-err">Não consegui falar com o Oportuniza: ${esc(r.error)}</p>`); return true; }
    status(r.paused ? "pausado (só leitura)" : `${r.data.saved} novos registros`);
    const est = r.data.items || {};
    renderList(list, est);
    lastRender = { list: true, fn: () => { const l2 = P.parseList(document, true); if (l2.length) renderList(l2, est); } };
    return true;
  }

  function renderList(list, est) {
    for (const x of list) {
      const e = est[x.item_id];
      let b = x.el.querySelector(".rml-badge");
      if (!b) { b = document.createElement("div"); b.className = "rml-badge"; (x.el.querySelector(".poly-card__content") || x.el).appendChild(b); }
      const rev = x.sold_min != null && x.price != null ? x.sold_min * x.price : null;
      b.innerHTML = `<span>${x.sold_min != null ? "≥ " + short(x.sold_min) + " vendidos" : "sem vendas visíveis"}</span>${rev ? `<span>fat. ≥ ${brlS(rev)}</span>` : ""}${e ? `<span>${estLine(e, x)}</span>` : ""}`;
    }
    const n = list.length, sold = list.filter((x) => x.sold_min != null);
    const prices = list.map((x) => x.price).filter((v) => v != null);
    const totSold = sold.reduce((a, x) => a + x.sold_min, 0);
    const totRev = sold.reduce((a, x) => a + (x.price || 0) * x.sold_min, 0);
    const sellers = {};
    for (const x of list) { const k = x.seller_name || "(sem nome)"; (sellers[k] ??= { n: 0, sold: 0 }); sellers[k].n++; sellers[k].sold += x.sold_min || 0; }
    const top = Object.entries(sellers).filter(([k]) => k !== "(sem nome)").sort((a, b) => b[1].sold - a[1].sold).slice(0, 5);
    const top3 = Object.values(sellers).sort((a, b) => b.sold - a.sold).slice(0, 3).reduce((a, s) => a + s.sold, 0);
    const pct = (k) => Math.round(list.filter(k).length / n * 100) + "%";
    const big = list.filter((x) => (x.sold_min || 0) >= 100).length;
    const fresh = list.filter((x) => x.sold_min == null || x.sold_min <= 25).length;
    const comp = big / n >= 0.6 ? ["alta", "rml-hot"] : big / n >= 0.3 ? ["média", "rml-warm"] : ["baixa", "rml-cold"];
    body(`
      <div class="rml-grid">
        <div><small>Anúncios lidos</small><b>${n}</b></div>
        <div><small>Vendidos (mín.)</small><b>${short(totSold)}</b></div>
        <div><small>Faturamento (mín.)</small><b>${brlS(totRev)}</b></div>
        <div><small>Preço mediano</small><b>${brl(median(prices), 2)}</b></div>
        <div><small>Faixa de preço</small><b>${prices.length ? brl(Math.min(...prices)) + " a " + brl(Math.max(...prices)) : "–"}</b></div>
        <div><small>Concorrência</small><b class="${comp[1]}">${comp[0]}</b></div>
        <div><small>Full</small><b>${pct((x) => x.full)}</b></div>
        <div><small>Patrocinados</small><b>${pct((x) => x.ad)}</b></div>
        <div><small>Espaço p/ novos</small><b>${Math.round(fresh / n * 100)}%</b></div>
      </div>
      <p class="rml-note">Top 3 vendedores concentram <b>${totSold ? Math.round(top3 / totSold * 100) : 0}%</b> dos vendidos desta página. ${big} de ${n} anúncios têm +100 vendas.</p>
      ${top.length ? `<table class="rml-t"><tr><th>Vendedor</th><th>Anúnc.</th><th>Vend. mín.</th></tr>${top.map(([k, s]) => `<tr><td>${esc(k)}</td><td>${s.n}</td><td>${short(s.sold)}</td></tr>`).join("")}</table>` : ""}
      <p class="rml-note">"Vendidos" é a faixa que o ML mostra (+50, +100, +5 mil). Cada visita registra a página; com 2 leituras em dias diferentes o Oportuniza calcula vendas por mês.</p>`);
  }

  /* ---------- página do anúncio ---------- */
  async function runItem() {
    if (!document.querySelector("h1.ui-pdp-title")) return false;
    const x = P.parseItemPage(document, location);
    if (!x.item_id) return false;
    status("enviando…");
    let rv = null, e = null, err = null;
    const redraw = () => { renderItem(x, e, rv, err); lastRender = { list: false, fn: redraw }; };
    redraw();
    // avaliações (data no ar, ritmo, reclamações) não dependem da gravação no Oportuniza
    askReviews(x.item_id).then((res) => { if (res.ok) { rv = summarizeReviews(res.data.items, x.reviews); redraw(); } });
    const r = await send({ kind: "snap", page: "item", items: [x] });
    if (!r.ok) { status("sem registro"); err = r.error; redraw(); return true; }
    status(r.paused ? "pausado (só leitura)" : "registrado");
    e = r.data.items?.[x.item_id];
    redraw();
    return true;
  }

  async function createDraft(x, rv, btn) {
    btn.disabled = true;
    if (!rv) { btn.textContent = "Lendo avaliações…"; const res = await askReviews(x.item_id); if (res.ok) rv = summarizeReviews(res.data.items, x.reviews); }
    btn.textContent = "Lendo o anúncio…";
    const full = P.parseListingFull(document, location);
    const r = await send({ kind: "draft", listing: { ...full, reviews_total: x.reviews, rating: x.rating, sold_label: x.sold_label, sold_min: x.sold_min, oldest_days: rv?.oldest_days ?? null, first_review: rv?.first_review ?? null, neg_count: rv?.neg_count ?? null, neg_pct: rv?.neg_pct ?? null, last30_reviews_est: rv?.last30_reviews_est ?? null, negatives: rv?.negatives ?? [] } });
    if (!r.ok) { btn.disabled = false; btn.textContent = "Tentar de novo"; status("erro: " + r.error); return; }
    btn.textContent = "✓ Rascunho criado no Oportuniza";
    window.open(APP + "#prod=" + r.data.id, "_blank", "noopener");
  }

  function renderItem(x, e, rv, err) {
    const total = x.reviews ? x.reviews * 10 : null;
    const best = Math.max(x.sold_min || 0, total || 0) || null;
    const perMonth = e?.est_month != null ? "~" + int(e.est_month) + "/mês" : rv && rv.last30_reviews_est ? "~" + int(rv.last30_reviews_est * 10) + "/mês" : "–";
    body(`${err ? `<p class="rml-err">Não consegui falar com o Oportuniza: ${esc(err)}</p>` : ""}
      <div class="rml-sub">${esc(x.item_id)}${x.seller_name ? " · " + esc(x.seller_name) : ""}${x.full ? " · Full" : ""}</div>
      <div class="rml-grid">
        <div><small>Preço</small><b>${brl(x.price, 2)}</b></div>
        <div><small>Vendidos (ML)</small><b>${esc(x.sold_label || "–")}</b></div>
        <div><small>Avaliações</small><b>${int(x.reviews)}${x.rating ? " · " + x.rating : ""}</b></div>
        <div><small>Vendas totais (est.)</small><b>${short(best)}</b></div>
        <div><small>Faturamento (est.)</small><b>${best && x.price ? brlS(best * x.price) : "–"}</b></div>
        <div><small>Ritmo (est.)</small><b>${perMonth}</b></div>
        <div><small>No ar desde</small><b>${rv ? (rv.first_review ? dBR(rv.first_review) : "–") : "…"}</b>${rv && rv.oldest_days != null ? `<small>pelo menos ${ageTxt(rv.oldest_days)}</small>` : ""}</div>
        <div><small>Avaliações no mês</small><b>${rv ? int(rv.last30_reviews_est) : "…"}</b></div>
        <div><small>Reclamações (≤3★)</small><b>${rv ? int(rv.neg_count) + (rv.neg_pct != null ? ` · ${String(rv.neg_pct).replace(".", ",")}%` : "") : "…"}</b></div>
      </div>
      <button class="rml-btn" id="rmlDraft">Criar anúncio melhor</button>
      <p class="rml-note">O ML não mostra a data de criação. “No ar desde” é a data da avaliação mais antiga${rv ? ` (li ${int(rv.scanned)} avaliações com comentário)` : ""}. Ritmo: ${e?.est_month != null ? `calculado por ${esc(e.basis)} entre leituras` : "avaliações do último mês × 10"}, é estimativa.</p>`);
    const b = getPanel().querySelector("#rmlDraft"); if (b) b.onclick = () => createDraft(x, rv, b);
  }

  let lastRender = null;
  async function run() {
    for (let i = 0; i < 15; i++) {
      try {
        if (await runItem()) return;
        if (await runList()) return;
      } catch (e) { console.warn("[Oportuniza]", e); return; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  let href = location.href, timer;
  const kick = () => { clearTimeout(timer); lastRender = null; timer = setTimeout(run, 1200); };
  kick();
  setInterval(() => {
    if (location.href !== href) { href = location.href; kick(); return; }
    // o ML às vezes redesenha a página depois de carregar: recoloca painel e etiquetas
    if (lastRender && (!panel || !document.body.contains(panel) || (lastRender.list && !document.querySelector(".rml-badge")))) lastRender.fn();
  }, 1500);
})();
