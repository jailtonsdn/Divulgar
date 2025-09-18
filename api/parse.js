// Gerador de conteúdo para WhatsApp a partir de link encurtado de AFILIADOS.
// - Segue redirecionamentos (amzn.to, /sec/, etc.) e usa a URL EXPANDIDA para parse.
// - Segue também o <link rel="canonical"> quando a página final for uma “landing” (ex.: /social/ do ML).
// - NÃO usa API oficial. Best-effort (pode falhar em captcha/robot).
// - Retorna: { store, title, price, oldPrice, installment, image, shareUrl, finalUrl, parseHint }

export const config = { runtime: "nodejs" };

/* ---------- Utils ---------- */
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

const toNumber = (s) => {
  if (s === null || s === undefined) return null;
  const only = String(s).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  const norm = only.replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
};

const tryOG = (html) => {
  const get = (prop) => {
    const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`,"i");
    return html.match(re)?.[1] || "";
  };
  return { title: clean(get("og:title")), image: get("og:image") };
};

const guessStore = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h.includes("mercadolivre") || h.includes("mercadolibre") || h.includes("mlstatic")) return "Mercado Livre";
    if (h.includes("amazon")) return "Amazon";
    if (h.includes("shopee")) return "Shopee";
    if (h.includes("magalu") || h.includes("magazineluiza")) return "Magalu";
    if (h.includes("kabum")) return "KaBuM!";
    return h.replace(/^www\./, "");
  } catch { return "Loja"; }
};

const fetchPageFollow = async (url) => {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8",
      "upgrade-insecure-requests": "1",
      "cache-control": "no-cache",
    },
  });
  const html = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar a página`);
  if (/Robot Check|captcha|Are you a human\??|To discuss automated access/i.test(html)) {
    throw new Error("Bloqueio/captcha detectado (robot check).");
  }
  return { html, finalUrl: res.url || url };
};

/* ---------- Parsers ---------- */

// Mercado Livre – v8 (prioriza JSON "prices"; evita confundir parcela x preço)
/* const parseMercadoLivre = (html) => {
  const og = tryOG(html);

  const title =
    og.title ||
    clean(
      html.match(/<h1[^>]*class=["'][^"']*ui-pdp-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1]
        ?.replace(/<[^>]+>/g, "") || ""
    );

  let price = null, oldPrice = null, installment = "";

  // 1) JSON oficial "prices"
  const pricesBlock = html.match(/"prices"\s*:\s*{[\s\S]{0,40000}?}/i)?.[0] || "";
  if (pricesBlock) {
    const amounts = [...pricesBlock.matchAll(/"amount"\s*:\s*([\d\.,]+)/g)]
      .map(m => toNumber(m[1])).filter(v => v && v > 0);
    const regulars = [...pricesBlock.matchAll(/"regular_amount"\s*:\s*([\d\.,]+)/g)]
      .map(m => toNumber(m[1])).filter(v => v && v > 0);

    if (amounts.length)  price    = amounts.sort((a,b)=>a-b)[0];   // menor amount = preço promo
    if (regulars.length) oldPrice = regulars.sort((a,b)=>b-a)[0];  // maior regular = "De:"

    if (price != null && oldPrice != null && price >= oldPrice) {
      const alt = amounts.sort((a,b)=>a-b).find(v => v < oldPrice);
      if (alt) price = alt;
    }
  }

  // 2) Parcelas texto OU JSON "installments"
  installment =
    clean(html.match(/em\s+até\s+\d{1,2}x[^<]{0,120}R\$\s?[\d\.\,]+(?:\s+sem\s+juros)?/i)?.[0] || "");
  if (!installment) {
    const inst = html.match(/"installments"\s*:\s*{[\s\S]{0,2000}?}/i)?.[0] || "";
    const q = parseInt(inst.match(/"quantity"\s*:\s*(\d{1,2})/i)?.[1] || "", 10);
    const a = toNumber(inst.match(/"amount"\s*:\s*([\d\.,]+)/i)?.[1] || "");
    const r = toNumber(inst.match(/"rate"\s*:\s*([\d\.,]+)/i)?.[1] || "");
    if (q && a) {
      installment = `${q}x de ${a.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}${(r===0||r===null)?" sem juros":""}`;
    }
  }

  // 3) Fallbacks (quando JSON não veio)
  if (price == null) {
    price =
      toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1]) ||
      toNumber(html.match(/"price"\s*:\s*("?[\d\.,]+"?)/i)?.[1]) || null;
  }
  if (oldPrice == null) {
    const secondLine = html.match(/ui-pdp-price__second-line[\s\S]*?<\/div>/i)?.[0] || "";
    const prevBlock  = secondLine.match(/andes-money-amount--previous[\s\S]*?<\/span>/i)?.[0] || "";
    if (prevBlock) {
      const w = prevBlock.match(/andes-money-amount__fraction[^>]*>([\d\.]+)/i)?.[1];
      const c = prevBlock.match(/andes-money-amount__cents[^>]*>(\d{1,2})/i)?.[1] || "00";
      if (w) oldPrice = toNumber(`${w},${c}`);
    }
  }

  // 4) Imagem
  const image =
    og.image ||
    html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") ||
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    "";

  return { title, price, oldPrice, installment, image, parseHint: "ml_html_v8" };
};

*/

// ---------- Mercado Livre v9 (JSON prices + PRELOADED_STATE fallback) ----------
const parseMercadoLivre = (html) => {
  const og = tryOG(html);

  const title =
    og.title ||
    clean(
      html.match(/<h1[^>]*class=["'][^"']*ui-pdp-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1]
        ?.replace(/<[^>]+>/g, "") || ""
    );

  let price = null, oldPrice = null, installment = "";

  // 1) bloco "prices" que costuma vir no HTML SSR
  const pricesBlock = html.match(/"prices"\s*:\s*{[\s\S]{0,60000}?}/i)?.[0] || "";
  if (pricesBlock) {
    const amounts = [...pricesBlock.matchAll(/"amount"\s*:\s*([\d\.,]+)/g)].map(m => toNumber(m[1])).filter(Boolean);
    const regulars = [...pricesBlock.matchAll(/"regular_amount"\s*:\s*([\d\.,]+)/g)].map(m => toNumber(m[1])).filter(Boolean);
    if (amounts.length)  price    = amounts.sort((a,b)=>a-b)[0];   // menor = promocional
    if (regulars.length) oldPrice = regulars.sort((a,b)=>b-a)[0];  // maior = "De:"
    // coerência básica
    if (price != null && oldPrice != null && price >= oldPrice) {
      const p = amounts.sort((a,b)=>a-b).find(v => v < oldPrice);
      if (p) price = p;
    }
    // installments JSON
    const instBlock = pricesBlock + (html.match(/"installments"\s*:\s*{[\s\S]{0,2000}?}/i)?.[0] || "");
    const q = parseInt(instBlock.match(/"quantity"\s*:\s*(\d{1,2})/i)?.[1] || "", 10);
    const a = toNumber(instBlock.match(/"amount"\s*:\s*([\d\.,]+)/i)?.[1] || "");
    const r = toNumber(instBlock.match(/"rate"\s*:\s*([\d\.,]+)/i)?.[1] || "");
    if (q && a) {
      installment = `${q}x de ${a.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}${(r===0||r===null)?" sem juros":""}`;
    }
  }

  // 2) Fallback leve: metas/itemprop e texto solto
  if (price == null) {
    price =
      toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1]) ||
      toNumber(html.match(/"price"\s*:\s*("?[\d\.,]+"?)/i)?.[1]) || null;
  }
  if (oldPrice == null) {
    oldPrice =
      toNumber(html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/i)?.[1]) ||
      toNumber(html.match(/"original_price"\s*:\s*("?[\d\.,]+"?)/i)?.[1]) || null;
  }
  if (!installment) {
    installment = clean(
      html.match(/em\s+até\s+\d{1,2}x[^<]{0,120}R\$\s?[\d\.\,]+(?:\s+sem\s+juros)?/i)?.[0] || ""
    );
  }

  // 3) Fallback robusto: varrer __PRELOADED_STATE__ (React) quando nada acima vier
  const needDeep =
    (price == null && oldPrice == null) || (!installment && !/x/i.test(installment||""));
  if (needDeep) {
    // pega qualquer JSON grande embutido (inclui __PRELOADED_STATE__)
    const bigJsons = [
      ...html.matchAll(/__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/gi),
      ...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi),
      ...html.matchAll(/<script[^>]*>\s*({[\s\S]*?})\s*<\/script>/gi)
    ].map(m => m[1]).slice(0,5); // limita por segurança

    const nums = { amount:[], regular:[], inst:[] };
    const pushNum = (arr, v) => { const n = toNumber(v); if (n) arr.push(n); };

    for (const raw of bigJsons) {
      try {
        const j = JSON.parse(raw
          .replace(/&quot;/g,'"')
          .replace(/\\u002F/g,'/'));
        // varredura recursiva procurando chaves relevantes
        const walk = (o) => {
          if (!o || typeof o !== "object") return;
          for (const k of Object.keys(o)) {
            const v = o[k];
            const lk = k.toLowerCase();
            if (lk === "amount")            pushNum(nums.amount, v);
            if (lk === "regular_amount")    pushNum(nums.regular, v);
            if (lk === "price")             pushNum(nums.amount, v);
            if (lk === "list_price" || lk === "original_price") pushNum(nums.regular, v);

            if (lk === "installments" && v && typeof v === "object") {
              const q = toNumber(v.quantity);
              const a = toNumber(v.amount);
              const r = toNumber(v.rate);
              if (q && a) nums.inst.push({ q, a, r });
            }
            if (v && typeof v === "object") walk(v);
          }
        };
        walk(j);
      } catch {}
    }

    if (nums.amount.length && price == null) price = nums.amount.sort((a,b)=>a-b)[0];
    if (nums.regular.length && oldPrice == null) oldPrice = nums.regular.sort((a,b)=>b-a)[0];
    if (nums.inst.length && !installment) {
      const best = nums.inst.sort((a,b)=>b.q - a.q)[0];
      installment = `${best.q}x de ${best.a.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}${(best.r===0||best.r==null)?" sem juros":""}`;
    }
  }

  // 4) imagem
  const image =
    og.image ||
    html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") ||
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";

  return { title, price, oldPrice, installment, image, parseHint: "ml_html_v9" };
};


// Amazon – v3
const parseAmazon = (html) => {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    clean(html.match(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");

  const priceBlock =
    html.match(/id=["']corePriceDisplay_[^"']+["'][\s\S]{0,4000}?<\/div>/i)?.[0] ||
    html.match(/id=["']apex_desktop["'][\s\S]{0,4000}?<\/div>/i)?.[0] || "";

  let price = null, oldPrice = null;

  if (priceBlock) {
    const whole = priceBlock.match(/class=["']a-price-whole["'][^>]*>([\d\.\,]+)/i)?.[1];
    const frac  = priceBlock.match(/class=["']a-price-fraction["'][^>]*>(\d{1,2})/i)?.[1];
    price = (whole && frac) ? toNumber(`${whole},${frac}`) :
            toNumber(priceBlock.match(/a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1]);
    const oldInBlock =
      priceBlock.match(/class=["'][^"']*a-text-price[^"']*["'][\s\S]*?a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      priceBlock.match(/id=["']priceblock_strikeprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] || null;
    oldPrice = toNumber(oldInBlock);
  }

  if (price == null) {
    const priceText =
      html.match(/id=["']priceblock_dealprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/id=["']priceblock_ourprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
      html.match(/"priceAmount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"price"\s*:\s*"([\d\.\,]+)"/i)?.[1] || null;
    price = toNumber(priceText);
  }
  if (oldPrice == null) {
    const oldText =
      html.match(/class=["'][^"']*a-text-price[^"']*["'][\s\S]*?a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/(?:De:|Preço\s+de\s+tabela)[^<]*?(R\$\s?[\d\.\,]+)/i)?.[1] ||
      html.match(/"wasPrice".*?"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"strikePrice"\s*:\s*"([\d\.\,]+)"/i)?.[1] || null;
    oldPrice = toNumber(oldText);
  }

  const allInstallments = Array.from(
    html.matchAll(/(?:em\s+até\s+)?(\d{1,2})x[^<]{0,80}R\$\s?([\d\.\,]+)(?:\s+sem\s+juros)?/ig)
  ).map(m => ({ n: parseInt(m[1], 10), val: m[2] }));
  let installment = "";
  if (allInstallments.length) {
    const best = allInstallments.sort((a,b)=> b.n - a.n)[0];
    installment = `${best.n}x de R$ ${best.val}${/sem\s+juros/i.test(html) ? " sem juros" : ""}`;
  }

  let image =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/data-old-hires=["']([^"']+)["']/i)?.[1] || "";
  if (!image) {
    const dyn = html.match(/data-a-dynamic-image=['"]({[^'"]+})['"]/i)?.[1];
    if (dyn) {
      try { const j = JSON.parse(dyn.replace(/&quot;/g,'"')); const first = Object.keys(j)[0]; if (first) image = first; } catch {}
    }
  }
  if (!image) image = html.match(/id=["']landingImage["'][^>]+src=["']([^"']+)["']/i)?.[1] || "";

  return { title, price, oldPrice, installment, image, parseHint: "amazon_html_v3" };
};

const parseShopee = (html) => {
  const og = tryOG(html);
  const title = og.title || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const price =
    toNumber(html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "")) ||
    toNumber(html.match(/"price_min"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "")) || null;
  const oldPrice =
    toNumber(html.match(/"price_before_discount"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "")) || null;
  const image = og.image || "";
  const installment = "";
  return { title, price, oldPrice, installment, image, parseHint: "shopee_html" };
};

const parseGeneric = (html) => {
  const og = tryOG(html);
  const title = og.title || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const price =
    toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1]) ||
    toNumber(html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1]) || null;
  const oldPrice = toNumber(html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1]) || null;
  const image = og.image || "";
  const installment = "";
  return { title, price, oldPrice, installment, image, parseHint: "generic_og" };
};

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  try {
    const base = "http://localhost";
    const urlObj = new URL(req.url, base);
    const shortUrl = urlObj.searchParams.get("url");
    if (!shortUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link_encurtado_de_afiliado>" }));
    }

    // 1) expandir URL
    let { html, finalUrl } = await fetchPageFollow(shortUrl);
    let host = new URL(finalUrl).hostname.toLowerCase();

    // 1.1) seguir canonical se for landing (ex.: /social/ do ML)
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || "";
    const isMLSocal = host.includes("mercadolivre") && /\/social\//i.test(finalUrl);
    if ((isMLSocal || canonical) && canonical) {
      try {
        const again = await fetchPageFollow(canonical);
        html = again.html; finalUrl = again.finalUrl; host = new URL(finalUrl).hostname.toLowerCase();
      } catch {}
    }

    // 2) parser por host final
    let data = null;
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) {
      data = parseMercadoLivre(html);
    } else if (host.includes("amazon")) {
      data = parseAmazon(html);
    } else if (host.includes("shopee")) {
      data = parseShopee(html);
    } else {
      data = parseGeneric(html);
    }

    // 3) payload normalizado (price/oldPrice como número quando possível)
    const asNum = (x) => (typeof x === "number" ? x : toNumber(x));
    const payload = {
      store: guessStore(finalUrl),
      title: clean(data?.title || ""),
      price: asNum(data?.price),
      oldPrice: asNum(data?.oldPrice),
      installment: clean(data?.installment || ""),
      image: data?.image || "",
      shareUrl: shortUrl,
      finalUrl,
      parseHint: data?.parseHint || "n/a",
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=30, s-maxage=120");
    return res.end(JSON.stringify(payload));
  } catch (e) {
    console.error("[/api/parse] ERRO:", e?.message || e);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({
      store: "Loja",
      title: "",
      price: null,
      oldPrice: null,
      installment: "",
      image: "",
      shareUrl: new URL(req.url, "http://localhost").searchParams.get("url") || "",
      finalUrl: "",
      parseHint: "error",
      note: String(e?.message || e),
    }));
  }
}
