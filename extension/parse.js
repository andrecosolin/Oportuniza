// Oportuniza: leitura das páginas do Mercado Livre (busca, categoria e anúncio).
// Usado pela extensão (content script) e testado direto na página.
(function (root) {
  const soldToMin = (label) => {
    if (!label) return null;
    const m = /\+?\s*([\d.,]+)\s*(mil|k)?\s*vendid/i.exec(label);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
    if (m[2]) n *= 1000;
    return Math.round(n);
  };
  const money = (el) => {
    if (!el) return null;
    const f = el.querySelector(".andes-money-amount__fraction");
    const c = el.querySelector(".andes-money-amount__cents");
    if (!f) return null;
    return parseFloat(f.textContent.replace(/\./g, "") + "." + (c ? c.textContent.padStart(2, "0") : "00"));
  };
  const itemIdFrom = (href) => {
    if (!href) return null;
    let m = /[?&#]wid=(MLB\d+)/.exec(href) || /item_id%3A(MLB\d+)/.exec(href) || /item_id:(MLB\d+)/.exec(href) || /\/(MLB)-?(\d{6,})/.exec(href);
    if (!m) return null;
    return m[2] ? "MLB" + m[2] : m[1];
  };
  const productIdFrom = (href) => { const m = /\/p\/(MLB\d+)/.exec(href || ""); return m ? m[1] : null; };

  function parseList(doc, withEl) {
    const cards = [...doc.querySelectorAll("li.ui-search-layout__item, .poly-card")].filter((c, i, a) => !a.some((p) => p !== c && p.contains(c)));
    const out = [];
    let pos = 0;
    for (const c of cards) {
      const a = c.querySelector("a.poly-component__title, h2 a, h3 a");
      if (!a) continue;
      const href = a.getAttribute("href") || "";
      const id = itemIdFrom(href);
      if (!id) continue;
      pos++;
      const rev = c.querySelector(".poly-component__review-compacted");
      const revTxt = rev ? rev.textContent.replace(/\s+/g, " ").trim() : "";
      const soldM = /(\+?\s*[\d.,]+\s*(mil)?\s*vendid\w*)/i.exec(revTxt);
      const rating = /(\d[.,]\d)/.exec(revTxt);
      const priceEl = [...c.querySelectorAll(".poly-price__current .andes-money-amount, .andes-money-amount")].find((e) => !e.className.includes("--previous"));
      const prevEl = c.querySelector(".andes-money-amount--previous");
      const shipTxt = (c.querySelector("[class*='poly-component__shipping']")?.textContent || "").toLowerCase();
      const isFull = !!c.querySelector('[aria-label*="FULL" i], .poly-component__shipping svg[aria-label*="full" i]') || /full/.test(c.innerHTML.slice(0, 20000).match(/poly-component__shipping[\s\S]{0,600}/)?.[0]?.toLowerCase() || "");
      const ad = /is_advertising=true/.test(href) || !!c.querySelector(".poly-component__ads-promotions, .ui-search-item__pub-label");
      out.push({
        item_id: id, product_id: productIdFrom(href), position: pos, ad,
        title: a.textContent.trim(),
        price: money(priceEl), original_price: money(prevEl),
        sold_label: soldM ? soldM[1].replace(/\s+/g, " ").trim() : null, sold_min: soldM ? soldToMin(soldM[1]) : null,
        rating: rating ? parseFloat(rating[1].replace(",", ".")) : null,
        seller_name: (c.querySelector(".poly-component__seller")?.textContent || "").replace(/^por\s+/i, "").trim() || null,
        full: isFull, free_shipping: /grátis|gratis/.test(shipTxt),
        permalink: href.split("#")[0].startsWith("https://click") ? null : href.split("#")[0],
      });
      if (withEl) Object.defineProperty(out[out.length - 1], "el", { value: c, enumerable: false });
    }
    return out;
  }

  function parseItemPage(doc, loc) {
    const href = loc.href;
    const id = itemIdFrom(href) || (doc.querySelector('meta[name="twitter:app:url:iphone"]')?.content.match(/id=(MLB\d+)/)?.[1]) || (doc.body.innerHTML.match(/"item_id":"(MLB\d+)"/)?.[1]) || null;
    const subtitle = (doc.querySelector(".ui-pdp-header__subtitle")?.textContent || "").replace(/\s+/g, " ").trim();
    const soldM = /(\+?\s*[\d.,]+\s*(mil)?\s*vendid\w*)/i.exec(subtitle);
    const revTxt = (doc.querySelector(".ui-pdp-review__amount, .ui-review-capability__rating__label")?.textContent || "").replace(/\D/g, "");
    const priceEl = doc.querySelector(".ui-pdp-price__second-line .andes-money-amount, .ui-pdp-price .andes-money-amount:not(.andes-money-amount--previous)");
    return {
      item_id: id, product_id: productIdFrom(href),
      title: doc.querySelector("h1.ui-pdp-title")?.textContent.trim() || null,
      price: money(priceEl), original_price: money(doc.querySelector(".ui-pdp-price .andes-money-amount--previous")),
      sold_label: soldM ? soldM[1].trim() : null, sold_min: soldM ? soldToMin(soldM[1]) : null,
      reviews: revTxt ? parseInt(revTxt) : null,
      rating: parseFloat((doc.querySelector(".ui-pdp-review__rating")?.textContent || "").replace(",", ".")) || null,
      seller_name: (doc.querySelector(".ui-pdp-seller__link-trigger, .ui-seller-data-header__title")?.textContent || "").replace(/^Vendido por\s*/i, "").trim() || null,
      full: !!doc.querySelector(".ui-pdp-promotions-pill-label__icon, [class*='fulfillment']") || /enviado pelo full/i.test(doc.body.innerText.slice(0, 50000)),
    };
  }

  root.RadarParse = { parseList, parseItemPage, soldToMin, itemIdFrom };
})(typeof window !== "undefined" ? window : globalThis);
