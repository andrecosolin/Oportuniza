// Oportuniza no Quem Fornece: importa os fornecedores da categoria aberta para a aba Fornecedores do Oportuniza.
(() => {
  if (window.__radarQF) return;
  window.__radarQF = true;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (body) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "radar", body }, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "sem resposta" })); } catch (e) { res({ ok: false, error: String(e.message || e) }); } });
  const pageData = () => { try { return JSON.parse(document.querySelector("[data-page]")?.dataset.page || "null"); } catch { return null; } };

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

  async function fetchProps(qs, version) {
    const r = await fetch(location.pathname + "?" + qs, { headers: { "X-Inertia": "true", "X-Inertia-Version": version || "", "X-Requested-With": "XMLHttpRequest", accept: "text/html, application/xhtml+xml" }, credentials: "include" });
    if (!r.ok) throw new Error("Quem Fornece respondeu " + r.status);
    await new Promise((res) => setTimeout(res, 250));
    return (await r.json()).props;
  }

  // A paginação do Quem Fornece muda a ordem entre páginas e repete empresas. Para pegar todas,
  // divide por estado e depois por cidade até cada grupo caber numa página só.
  async function collect(qs, version, found, prog) {
    const first = await fetchProps(qs + "&page=1", version);
    const f = first.fornecedores; const local = new Set();
    const add = (list) => { for (const x of list || []) { local.add(x.slug); if (!found.has(x.slug)) found.set(x.slug, { slug: x.slug, nome: x.nome, cidade: x.cidade, estado: x.estado, website: x.website, tipo: x.tipo }); } };
    add(f.data); prog();
    if (f.total <= f.per_page) return;
    if (!/(^|&)estados=/.test(qs) && Object.keys(first.filtros?.estados || {}).length > 1) {
      for (const uf of Object.keys(first.filtros.estados)) await collect(qs + "&estados=" + encodeURIComponent(uf), version, found, prog);
      return;
    }
    if (!/(^|&)cidades=/.test(qs) && Object.keys(first.filtros?.cidades || {}).length > 1) {
      for (const c of Object.keys(first.filtros.cidades)) await collect(qs + "&cidades=" + encodeURIComponent(c), version, found, prog);
      return;
    }
    for (let round = 0; round < 5 && local.size < f.total; round++)
      for (let p = 1; p <= f.last_page; p++) { add((await fetchProps(qs + "&page=" + p, version)).fornecedores?.data); prog(); }
  }

  async function importAll(pd) {
    const btn = getPanel().querySelector("#rmlQfGo"); if (btn) btn.disabled = true;
    const cat = pd.props.categoria?.nome || document.title;
    const total = pd.props.fornecedores?.total || 0;
    const found = new Map();
    try {
      const base = new URLSearchParams(location.search); base.delete("page");
      await collect(base.toString() || "x=1", pd.version, found, () => status(`lendo… ${found.size} de ${total}`));
      const all = [...found.values()];
      status(`enviando ${all.length}…`);
      let saved = 0;
      for (let i = 0; i < all.length; i += 200) {
        const r = await send({ kind: "qf", category: cat, items: all.slice(i, i + 200) });
        if (!r.ok) throw new Error(r.error);
        saved += r.data.saved || 0;
      }
      status("pronto");
      body(`<p>✓ <b>${saved}</b> fornecedores de “${esc(cat)}” enviados ao Oportuniza${saved < total ? ` (o site lista ${total}; ${total - saved} não apareceram na leitura)` : ""}. Abra a aba <b>Fornecedores</b> no Oportuniza e toque em Atualizar.</p>`);
    } catch (e) {
      status("erro");
      body(`<p class="rml-err">Não deu certo: ${esc(e.message || e)}</p><button class="rml-btn" id="rmlQfGo">Tentar de novo</button>`);
      getPanel().querySelector("#rmlQfGo").onclick = () => importAll(pd);
    }
  }

  async function current() {
    const first = pageData();
    const r = await fetch(location.pathname + location.search, { headers: { "X-Inertia": "true", "X-Inertia-Version": first?.version || "", "X-Requested-With": "XMLHttpRequest", accept: "text/html, application/xhtml+xml" }, credentials: "include" });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return first;
    return await r.json();
  }
  async function run() {
    let pd = null; try { pd = await current(); } catch { pd = pageData(); }
    if (!pd || !pd.props?.fornecedores?.data) { if (panel) panel.remove(); panel = null; return; }
    const f = pd.props.fornecedores, cat = pd.props.categoria?.nome || "esta busca";
    const ufs = pd.props.filtros?.estados || {};
    const tipos = pd.props.filtros?.tipos || {};
    const k = (re) => Object.entries(tipos).filter(([t]) => re.test(t)).reduce((a, [, n]) => a + n, 0);
    status("");
    body(`
      <p style="margin:0 0 8px"><b>${f.total}</b> fornecedores em “${esc(cat)}”.</p>
      <div class="rml-grid">
        <div><small>Em SP</small><b>${ufs.SP || 0}</b></div>
        <div><small>Dropshipping</small><b>${k(/dropshipping/i)}</b></div>
        <div><small>Atacado</small><b>${k(/atacado/i)}</b></div>
        <div><small>Fabricante</small><b>${k(/fabricante/i)}</b></div>
        <div><small>Importador</small><b>${k(/importador/i)}</b></div>
        <div><small>Revenda online</small><b>${k(/revendas online/i)}</b></div>
      </div>
      <button class="rml-btn" id="rmlQfGo">Importar todos para o Oportuniza</button>
      <p class="rml-note">Leva nome, cidade, tipo e site. Preço, mínimo e prazo você completa no Oportuniza depois da cotação. Fornecedores já importados são atualizados, sem perder o que você preencheu.</p>`);
    getPanel().querySelector("#rmlQfGo").onclick = () => importAll(pd);
  }

  let href = "";
  setInterval(() => { if (location.href !== href) { href = location.href; setTimeout(run, 800); } }, 1000);
})();
