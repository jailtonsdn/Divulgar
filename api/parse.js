// api/parse.js
// Serverless na Vercel (Node.js). Extrai dados de produto de várias lojas.
// Suporta: Mercado Livre, Amazon, Shopee (parsers dedicados) + fallback JSON-LD/OG.
// Retorna: { store, title, price, oldPrice, installment, image, url }

export const config = { runtime: "nodejs" };

// ------------ Utils ------------
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

const toNumber = (s) => {
  if (s === null || s === undefined) return null;
  // Aceita formatos: "R$ 1.234,56", "1.234,56", "1234.56"
  const only = String(s).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  const norm = only.replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
};

const between = (str, a, b) => {
  const i = str.indexOf(a);
  if (i === -1) return "";
  const j = str.indexOf(b, i + a.length);
  if (j === -1) return "";
  return str.slice(i + a.length, j);
};

const guessStore = (u) => {
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host.includes("mercadolivre") || host.includes("mercadolibre")) return "Mercado Livre";
    if (host.includes("mlstatic")) return "Mercado Livre";
    if (host.includes("amazon")) return "Amazon";
    if (host.includes("shopee")) return "Shopee";
    if (host.includes("magalu") || host.includes("magazineluiza")) return "Magalu";
    if (host.includes("americanas")) return "Americanas";
    if (host.includes("submarino")) return "Submarino";
    if (host.includes("kabum")) return "KaBuM!";
    if (host.includes("casasbahia")) return "Casas Bahia";
    if (host.includes("pontofrio")) return "Ponto";
    if (host.includes("aliexpress")) return "AliExpress";
    return host.replace(/^www\./, "");
  } catch {
    return "Loja";
  }
};

const fetchPage = async (url) => {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      // UA “realista” ajuda a evitar HTML reduzido
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1",
      "cache-control": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Sinais de bloqueio/robot
  if (/Robot Check|captcha|Enter the characters you see|Are you a human\??/i.test(html)) {
    throw new Error("A loja retornou uma página de verificação (captcha/robot). Tente novamente ou use a API oficial da loja.");
  }
  return html;
};

// ------------ Parsers genéricos (JSON-LD/OG) ------------
const tryJSONLD = (html) => {
  try {
    const scripts = [...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )].map((m) => m[1]);

    for (const raw of scripts) {
      let json;
      try { json = JSON.parse(raw.trim()); } catch { continue; }
      const arr = Array.isArray(json) ? json : [json];
      for (const node of arr) {
        const n = node || {};
        const t = (n["@type"] || n.type || "").toString().toLowerCase();
        if (t.includes("product")) {
          const title = clean(n.name || n.headline || "");
          const image = Array.isArray(n.image) ? n.image[0] : (n.image || "");
          // offers pode ser objeto ou array
          let price = null, oldPrice = null, installment = "";
          if (n.offers) {
            const off = Array.isArray(n.offers) ? n.offers[0] : n.offers;
            price = toNumber(off?.price || off?.priceSpecification?.price);
            // alguns schemas expõem "highPrice/lowPrice"
            if (off?.highPrice && off?.lowPrice && toNumber(off.highPrice) !== toNumber(off.lowPrice)) {
              oldPrice = toNumber(off.highPrice);
              price = toNumber(off.lowPrice) ?? price;
            }
          }
          if (title || price || image) {
            return { title, price, oldPrice, installment, image };
          }
        }
      }
  } catch {}
  return null;
};

const tryOG = (html) => {
  const get = (prop) => {
    const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
    return html.match(re)?.[1] || "";
  };
  return {
    title: clean(get("og:title")),
    image: get("og:image"),
  };
};

// ------------ Parsers específicos ------------
const parseMercadoLivre = (html) => {
  // Título
  let title =
    clean(between(html, '<h1 class="ui-pdp-title', "</h1>").replace(/^[^>]*>/, "")) ||
    tryOG(html).title;

  // Preço atual (seletor com itemprop ou JSON interno)
  let priceStr =
    between(html, 'itemprop="price" content="', '"') ||
    html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1]?.replace(/"/g, "") ||
    html.match(/"price":\s*([\d\.]+)/)?.[1] ||
    "";
  const price = toNumber(priceStr);

  // Preço antigo (list_price ou marcação de "original")
  let oldStr =
    between(html, "price__original-value", "</s>").replace(/<[^>]+>/g, "") ||
    html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1]?.replace(/"/g, "") ||
    "";
  const oldPrice = toNumber(oldStr);

  // Parcelas
  let installment = clean(
    between(html, 'class="ui-vip-installments', "</").replace(/<[^>]+>/g, "")
  );
  if (!installment) {
    // tentativa via JSON de installments
    const qtd = parseInt(html.match(/"installments"\s*:\s*{\s*"quantity"\s*:\s*(\d+)/)?.[1] || "", 10);
    const val = toNumber(html.match(/"amount"\s*:\s*("?[\d\.,]+"?)/)?.[1] || "");
    if (qtd && val) {
      installment = `${qtd}x ${val.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})} sem juros`;
    }
  }

  // Imagem
  const og = tryOG(html);
  const image =
    og.image ||
    html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") ||
    "";

  return { title, price, oldPrice, installment, image };
};

const parseAmazon = (html) => {
  // título
  let title =
    tryOG(html).title ||
    clean(html.match(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");

  // preço visível (a-offscreen) ou JSON interno
  const priceText =
    html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
    html.match(/"priceAmount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
    html.match(/"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1];
  const price = toNumber(priceText);

  // preço antigo
  const oldText =
    html.match(/priceBlockStrikePriceString[^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
    html.match(/"wasPrice".*?"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
    null;
  const oldPrice = toNumber(oldText);

  // parcelas (quando aparece em texto)
  let installment = clean(
    (html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || "")
  );

  // imagem principal
  const og = tryOG(html);
  const image =
    og.image ||
    html.match(/data-old-hires=["']([^"']+)["']/i)?.[1] ||
    html.match(/"hiRes"\s*:\s*"([^"]+)"/i)?.[1] ||
    "";

  return { title, price, oldPrice, installment, image };
};

const parseShopee = (html) => {
  // Shopee costuma renderizar via JS; mas muitas páginas expõem OG/JSON.
  const og = tryOG(html);
  let title = og.title;

  // Preço atual em JSON embutido
  const priceRaw =
    html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") ||
    html.match(/"price_min"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") ||
    null;
  const price = toNumber(priceRaw);

  // Preço antigo (se tiver "price_before_discount")
  const oldRaw =
    html.match(/"price_before_discount"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") ||
    null;
  const oldPrice = toNumber(oldRaw);

  // Parcelas: geralmente vem em texto solto “em até Xx de R$ Y”
  let installment = clean(
    (html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || "")
  );

  const image = og.image || "";

  return { title, price, oldPrice, installment, image };
};

// Fallback genérico (OG + tentativas de price metatags comuns)
const parseGeneric = (html) => {
  const og = tryOG(html);
  const title = og.title;

  const price =
    toNumber(between(html, 'product:price:amount" content="', '"')) ||
    toNumber(between(html, 'itemprop="price" content="', '"')) ||
    toNumber(html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/)?.[1]?.replace(/"/g, "")) ||
    null;

  const oldPrice =
    toNumber(html.match(/"list_price"\s*:\s*("?[\d\.\,]+"?)/)?.[1]?.replace(/"/g, "")) ||
    null;

  let installment = clean(
    (between(html, ">em até", "</").replace(/<[^>]+>/g, "")) ||
    (html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || "")
  );
  if (installment) installment = installment.replace(/^em até/i, (m) => m.toLowerCase());

  return { title, price, oldPrice, installment, image: og.image || "" };
};

// ------------ Handler ------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const productUrl = url.searchParams.get("url");
    if (!productUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link-do-produto>" }));
    }

    const html = await fetchPage(productUrl);

    // 1) Tenta JSON-LD universal
    let data = tryJSONLD(html);

    // 2) Se não achou, tenta parsers por loja
    const host = new URL(productUrl).hostname.toLowerCase();
    if (!data) {
      if (host.includes("mercadolivre") || host.includes("mlstatic") || host.includes("mercadolibre")) {
        data = parseMercadoLivre(html);
      } else if (host.includes("amazon")) {
        data = parseAmazon(html);
      } else if (host.includes("shopee")) {
        data = parseShopee(html);
      }
    }

    // 3) Fallback OG/metatags
    if (!data || (!data.title && !data.price && !data.image)) {
      data = parseGeneric(html);
    }

    // Normaliza payload
    const payload = {
      store: guessStore(productUrl),
      title: clean(data?.title || ""),
      price: data?.price ?? null,
      oldPrice: data?.oldPrice ?? null,
      installment: clean(data?.installment || ""),
      image: data?.image || "",
      url: productUrl,
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    // Cache curto para aliviar chamadas repetidas (ajuste conforme gosto)
    res.setHeader("cache-control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.end(JSON.stringify(payload));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: (e?.message || String(e)) }));
  }
}
