// Oportuniza no Google Trends: lê a curva de 5 anos do termo aberto (Brasil) e as buscas relacionadas,
// resume (subindo, estável, caindo, sazonal) e grava no Oportuniza para entrar na nota de demanda.
(() => {
  if (window.__radarGT) return;
  window.__radarGT = true;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (body) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "radar", body }, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "sem resposta" })); } catch (e) { res({ ok: false, error: String(e.message || e) }); } });
  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const pct = (a, b) => (b > 0 ? Math.round((a / b - 1) * 100) : null);

  // resumo da curva semanal (valores relativos 0 a 100 do próprio termo)
  function analyze(points) {
    const pts = points.filter((p) => !p.partial);
    const v = pts.map((p) => p.v);
    if (v.length < 30) return null;
    const last12 = mean(v.slice(-12)), prev12 = mean(v.slice(-24, -12)), yearAgo = v.length >= 64 ? mean(v.slice(-64, -52)) : null;
    const momentum = pct(last12, prev12), yoy = yearAgo != null ? pct(last12, yearAgo) : null;
    // perfil por mês do ano e pico de cada ano (sazonal = o pico se repete em anos diferentes)
    const byM = Array.from({ length: 12 }, () => []), byY = {};
    for (const p of pts) { const d = new Date(p.t * 1000), m = d.getUTCMonth(), y = d.getUTCFullYear(); byM[m].push(p.v); ((byY[y] ??= Array.from({ length: 12 }, () => []))[m]).push(p.v); }
    const mAvg = byM.map((a) => (a.length ? mean(a) : null));
    const valid = mAvg.filter((x) => x != null), overall = mean(valid);
    // só anos com dados quase completos e busca de verdade (ano zerado não tem pico)
    const years = Object.values(byY).filter((ms) => ms.filter((a) => a.length).length >= 10).map((ms) => ms.map((a) => (a.length ? mean(a) : -1)));
    const topYear = Math.max(0, ...years.map((av) => Math.max(...av)));
    const yearPeaks = years.filter((av) => Math.max(...av) >= Math.max(3, topYear * 0.25)).map((av) => av.indexOf(Math.max(...av)));
    const near = (a, b) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b)) <= 1;
    const repeats = yearPeaks.length >= 2 && yearPeaks.some((m, i) => yearPeaks.filter((x, j) => j !== i && near(x, m)).length >= Math.max(1, Math.floor(yearPeaks.length / 2)));
    const maxM = Math.max(...valid), minM = Math.min(...valid);
    const seasonal = overall > 3 && repeats && (minM > 0 ? maxM / minM >= 1.8 : maxM >= 2 * overall);
    const peaks = seasonal ? mAvg.map((x, i) => [x, i]).filter(([x]) => x != null && x >= overall * 1.25).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i + 1).sort((a, b) => a - b) : [];
    // moda: um pico forte nos últimos 2 anos que não se repete
    const roll = v.map((_, i) => (i >= 11 ? mean(v.slice(i - 11, i + 1)) : null)).filter((x) => x != null);
    const peakR = Math.max(...roll), peakAt = roll.indexOf(peakR), sinceWeeks = roll.length - 1 - peakAt, firstYear = mean(v.slice(0, 52));
    const fad = !seasonal && peakR >= 3 * Math.max(firstYear, 2) && sinceWeeks <= 104;
    const low = mean(v) < 4;
    const nowM = new Date().getUTCMonth() + 1;
    let label;
    if (low) label = "pouca busca";
    else if (fad) label = last12 < peakR * 0.4 ? "moda passando" : "moda subindo";
    else if (seasonal) label = (yoy ?? 0) >= 25 ? "subindo" : (yoy ?? 0) <= -25 ? "caindo" : peaks.includes(nowM) ? "em época" : peaks.includes((nowM % 12) + 1) ? "época chegando" : "fora de época";
    else label = (momentum ?? 0) >= 20 || (yoy ?? 0) >= 25 ? "subindo" : (momentum ?? 0) <= -20 && (yoy ?? 0) <= 0 ? "caindo" : "estável";
    return { weeks: v.length, last12: Math.round(last12), momentum, yoy, label, seasonal, peak_months: peaks, fad, month_avg: mAvg.map((x) => (x == null ? null : Math.round(x))), low };
  }
  window.__radarGTAnalyze = analyze;

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
  const api = async (path) => { const r = await fetch(path, { credentials: "include" }); if (!r.ok) throw new Error("Google Trends respondeu " + r.status); const t = await r.text(); return JSON.parse(t.slice(t.indexOf("{"))); };

  let lastKey = "";
  async function run() {
    const u = new URL(location.href);
    const terms = (u.searchParams.get("q") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const geo = u.searchParams.get("geo") || "BR";
    if (!terms.length) return;
    const term = terms[0];
    const key = term + "|" + geo; if (key === lastKey) return; lastKey = key;
    status("lendo…"); body(`<p class="rml-sub">Lendo a busca por “${esc(term)}” nos últimos 5 anos…</p>`);
    try {
      const req = { comparisonItem: [{ keyword: term, geo, time: "today 5-y" }], category: 0, property: "" };
      const ex = await api(`/trends/api/explore?hl=pt-BR&tz=180&req=${encodeURIComponent(JSON.stringify(req))}`);
      const ts = ex.widgets.find((w) => w.id === "TIMESERIES"), rq = ex.widgets.find((w) => w.id === "RELATED_QUERIES");
      const ml = await api(`/trends/api/widgetdata/multiline?hl=pt-BR&tz=180&req=${encodeURIComponent(JSON.stringify(ts.request))}&token=${ts.token}`);
      const points = (ml.default?.timelineData || []).map((p) => ({ t: Number(p.time), v: Number(p.value?.[0] ?? 0), partial: !!p.isPartial }));
      let top = [], rising = [];
      if (rq) { try { const rr = await api(`/trends/api/widgetdata/relatedsearches?hl=pt-BR&tz=180&req=${encodeURIComponent(JSON.stringify(rq.request))}&token=${rq.token}`); const L = rr.default?.rankedList || []; top = (L[0]?.rankedKeyword || []).slice(0, 10).map((k) => ({ q: k.query, v: k.value })); rising = (L[1]?.rankedKeyword || []).slice(0, 10).map((k) => ({ q: k.query, v: k.formattedValue })); } catch {} }
      const a = analyze(points);
      if (!a) { status(""); body(`<p class="rml-sub">Pouca informação para “${esc(term)}”. Tente um termo mais comum.</p>`); return; }
      const r = await send({ kind: "sig", source: "gtrends", term, geo, data: { ...a, related_top: top, related_rising: rising, series: points.filter((p) => !p.partial).map((p) => p.v) } });
      status(r.ok ? "gravado" : "não gravado");
      const tone = /subindo|em época|chegando/.test(a.label) ? "#9BC27A" : /caindo|passando/.test(a.label) ? "#FFB4A8" : "#F1F3F6";
      const sig = (n) => (n == null ? "–" : (n > 0 ? "+" : "") + n + "%");
      body(`<p class="rml-sub">“${esc(term)}” no Brasil, últimos 5 anos</p>
        <div class="rml-grid">
          <div><small>Tendência</small><b style="color:${tone}">${esc(a.label)}</b></div>
          <div><small>3 meses vs 3 antes</small><b>${sig(a.momentum)}</b></div>
          <div><small>vs ano passado</small><b>${sig(a.yoy)}</b></div>
          <div style="grid-column:span 3"><small>Sazonal</small><b>${a.seasonal ? "sim, pico em " + a.peak_months.map((m) => MES[m - 1]).join(", ") : "não"}</b></div>
        </div>
        ${rising.length ? `<p class="rml-note"><b>Buscas em alta:</b> ${rising.slice(0, 5).map((k) => esc(k.q) + " (" + esc(k.v) + ")").join(" · ")}</p>` : ""}
        ${r.ok ? `<p class="rml-note">Gravado no Oportuniza${r.data?.products ? `: ${r.data.products} produto(s) seu(s) com esse termo atualizado(s)` : ""}.</p>` : `<p class="rml-err">${esc(r.error)}</p>`}`);
    } catch (e) { status("erro"); lastKey = ""; body(`<p class="rml-err">Não consegui ler o Trends: ${esc(e.message || e)}</p>`); }
  }
  run();
  setInterval(run, 1500); // o Trends troca o termo sem recarregar a página
})();
