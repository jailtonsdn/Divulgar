// api/parse.js
// Gera dados a partir de link encurtado de afiliados (amzn.to, mercadolivre.com/sec, shopee encurtado...)
// Estratégia:
// 1) Expande a URL e segue <link rel="canonical"> quando houver landing.
// 2) Tenta parse "rápido" por HTML/JSON embutido.
// 3) Se for Mercado Livre e faltar preço/parcelas, usa HEADLESS (Puppeteer) para renderizar e extrair.

export const config = { runtime: "nodejs" };

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

/* ---------------- Utils ---------------- */
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const toNumber = (s) => {
  if (s === null || s === undefined) return null;
  const only = String(s).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  const n = parseFloat(only.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const tryOG = (html) => {
  const get = (prop) => {
    const re = new RegExp(
      `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      "i"
    );
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

/* ---------------- Parsers rápidos (HTML/JSON) ---------------- */

// Mercado Livre – rápido (JSON "prices" + fallbacks)
const parseMLFast = (html) => {
  const og = tryOG(html);
  const title =
    og.title ||
    clean(
      html.match(/<h1[^>]*class=["'][^"']*ui-pdp-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1]
        ?.replace(/<[^>]+>/g, "") || ""
    );

  let price = null, oldPrice = null, installment = "";

  // JSON "prices"
  const pricesBlock = html.match(/"prices"\s*:\s*{[\s\S]{0,40000}?}/i)?.[0] || "";
  if (pricesBlock) {
    const amounts  = [...pricesBlock.matchAll(/"amount"\s*:\s*([\d\.,]+)/g)].map(m => toNumber(m[1])).filter(Boolean);
    const regulars = [...pricesBlock.matchAll(/"regular_amount"\s*:\s*([\d\.,]+)/g)].map(m => toNumber(m[1])).filter(Boolean);
    if (amounts.length)  price    = amounts.sort((a,b)=>a-b)[0];
    if (regulars.length) oldPrice = regulars.sort((a,b)=>b-a)[0];
    if (price != null && oldPrice != null && price >= oldPrice) {
      const alt = amounts.sort((a,b)=>a-b).find(v => v < oldPrice);
      if (alt) price = alt;
    }
    // installments do próprio bloco
    const instBlock = pricesBlock + (html.match(/"installments"\s*:\s*{[\s\S]{0,2000}?}/i)?.[0] || "");
    const q = parseInt(instBlock.match(/"quantity"\s*:\s*(\d{1,2})/i)?.[1] || "", 10);
    const a = toNumber(instBlock.match(/"amount"\s*:\s*([\d\.,]+)/i)?.[1] || "");
    const r = toNumber(instBlock.match(/"rate"\s*:\s*([\d\.,]+)/i)?.[1] || "");
    if (q && a) installment = `${q}x de ${a.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}${(r===0||r===null)?" sem juros":""}`;
  }

  // Fallbacks leves
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

  // Imagem
  const image =
    og.image ||
    html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") ||
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";

  return { title, price, oldPrice, installment, image, parseHint: "ml_fast" };
};

// Amazon – v3 (OK)
const parseAmazon = (html) => {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    clean(html.match(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");

  const priceBlock =
    html.match(/id=["']corePriceDisplay_[^"']+["'][\s\S]{0,4000}?<\/div>/i)?.[0] ||
    html.match(/id=["']apex_desktop["'][\s\S]{0,4000}?<\/div>/i)?.[0] || "";

  let price = null, oldPrice = null;

  if (priceBlock) {
    const w = priceBlock.match(/class=["']a-price-whole["'][^>]*>([\d\.\,]+)/i)?.[1];
    const f = priceBlock.match(/class=["']a-price-fraction["'][^>]*>(\d{1,2})/i)?.[1];
    price = (w && f) ? toNumber(`${w},${f}`) : toNumber(priceBlock.match(/a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1]);
    const oldInBlock =
      priceBlock.match(/class=["'][^"']*a-text-price[^"']*["'][\s\S]*?a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      priceBlock.match(/id=["']priceblock_strikeprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] || null;
    oldPrice = toNumber(oldInBlock);
  }
  if (price == null) {
    const t =
      html.match(/id=["']priceblock_dealprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/id=["']priceblock_ourprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
      html.match(/"priceAmount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"price"\s*:\s*"([\d\.\,]+)"/i)?.[1] || null;
    price = toNumber(t);
  }
  if (oldPrice == null) {
    const t =
      html.match(/class=["'][^"']*a-text-price[^"']*["'][\s\S]*?a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/(?:De:|Preço\s+de\s+tabela)[^<]*?(R\$\s?[\d\.\,]+)/i)?.[1] ||
      html.match(/"wasPrice".*?"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"strikePrice"\s*:\s*"([\d\.\,]+)"/i)?.[1] || null;
    oldPrice = toNumber(t);
  }

  const allInst = Array.from(
    html.matchAll(/(?:em\s+até\s+)?(\d{1,2})x[^<]{0,80}R\$\s?([\d\.\,]+)(?:\s+sem\s+juros)?/ig)
  ).map(m => ({ n: parseInt(m[1], 10), val: m[2] }));
  let installment = "";
  if (allInst.length) {
    const best = allInst.sort((a,b)=> b.n - a.n)[0];
    installment = `${best.n}x de R$ ${best.val}${/sem\s+juros/i.test(html) ? " sem juros" : ""}`;
  }

  let image =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/data-old-hires=["']([^"']+)["']/i)?.[1] || "";
  if (!image) {
    const dyn = html.match(/data-a-dynamic-image=['"]({[^'"]+})['"]/i)?.[1];
    if (dyn) { try { const j = JSON.parse(dyn.replace(/&quot;/g,'"')); const first = Object.keys(j)[0]; if (first) image = first; } catch {} }
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

/* ---------------- Fallback headless p/ Mercado Livre ---------------- */
async function renderMLFallback(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width: 1200, height: 900, deviceScaleFactor: 1 }
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );

    // Nordeste: timezone ajuda a receber o template correto
    try { await page.emulateTimezone("America/Fortaleza"); } catch {}

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // dá tempo do React hidratar
    await page.waitForTimeout(1200);

    const result = await page.evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

      const title =
        document.querySelector("h1.ui-pdp-title")?.textContent ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title;

      // preço atual
      const frac = document.querySelector(".ui-pdp-price__second-line .andes-money-amount__fraction");
      const cents = document.querySelector(".ui-pdp-price__second-line .andes-money-amount__cents");
      const priceStr = frac ? `${frac.textContent},${(cents && cents.textContent) || "00"}` : "";

      // preço antigo
      const prev = document.querySelector(".andes-money-amount--previous");
      let oldStr = "";
      if (prev) {
        const wf = prev.querySelector(".andes-money-amount__fraction");
        const wc = prev.querySelector(".andes-money-amount__cents");
        if (wf) oldStr = `${wf.textContent},${(wc && wc.textContent) || "00"}`;
      }

      // parcelas – aproximação
      let instTxt = "";
      const m = document.body.innerText.match(/(\d{1,2})x\s+de\s+R\$\s*[\d\.\,]+(?:\s+sem\s+juros)?/i);
      if (m) instTxt = m[0];

      const image =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('img.ui-pdp-image')?.src ||
        document.querySelector('figure img')?.src || "";

      return { title: clean(title), priceStr: priceStr && clean(priceStr), oldStr: oldStr && clean(oldStr), instTxt: clean(instTxt), image };
    });

    return {
      title: result.title,
      price: toNumber(result.priceStr),
      oldPrice: toNumber(result.oldStr),
      installment: result.instTxt,
      image: result.image,
      parseHint: "ml_headless"
    };
  } finally {
    try { await browser?.close(); } catch {}
  }
}

/* ---------------- Handler ---------------- */
export default async function handler(req, res) {
  try {
    const urlObj = new URL(req.url, "http://localhost");
    const shortUrl = urlObj.searchParams.get("url");
    if (!shortUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link_encurtado_de_afiliado>" }));
    }

    // 1) expandir
    let { html, finalUrl } = await fetchPageFollow(shortUrl);
    let host = new URL(finalUrl).hostname.toLowerCase();

    // canonical se landing (ex.: /social/ do ML)
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || "";
    const isMLSocal = host.includes("mercadolivre") && /\/social\//i.test(finalUrl);
    if ((isMLSocal || canonical) && canonical) {
      try {
        const again = await fetchPageFollow(canonical);
        html = again.html; finalUrl = again.finalUrl; host = new URL(finalUrl).hostname.toLowerCase();
      } catch {}
    }

    // 2) parser rápido
    let data;
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) {
      data = parseMLFast(html);
    } else if (host.includes("amazon")) {
      data = parseAmazon(html);
    } else if (host.includes("shopee")) {
      data = parseShopee(html);
    } else {
      data = parseGeneric(html);
    }

    // 3) Fallback headless só para ML se faltar preço/parcelas
    if ((host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) &&
        (data.price == null && data.oldPrice == null && !data.installment)) {
      try {
        const deep = await renderMLFallback(finalUrl);
        // mantém o que já veio, completa só o que faltou
        data = {
          ...data,
          ...Object.fromEntries(Object.entries(deep).filter(([k,v]) => v)) // preenche somente valores verdadeiros
        };
      } catch (e) {
        // Se headless falhar, seguimos com o que tínhamos
      }
    }

    // 4) payload normalizado
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
