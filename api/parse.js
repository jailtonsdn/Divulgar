// api/parse.js
// v2 – Node runtime, logs e mensagens de erro detalhadas.
// Suporta ML, Amazon, Shopee + fallback genérico (JSON-LD/OG/metatags).

export const config = { runtime: "nodejs" };

// ---------- Utils ----------
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

const toNumber = (s) => {
  if (s === null || s === undefined) return null;
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
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) return "Mercado Livre";
    if (host.includes("amazon")) return "Amazon";
    if (host.includes("shopee")) return "Shopee";
    if (host.includes("magalu") || host.includes("magazineluiza")) return "Magalu";
    if (host.includes("americanas")) return "Americanas";
    if (host.includes("kabum")) return "KaBuM!";
    if (host.includes("casasbahia")) return "Casas Bahia";
    return host.replace(/^www\./, "");
  } catch { return "Loja"; }
};

const fetchPage = async (url) => {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
  const status = res.status;
  const html = await res.text().catch(() => "");
  if (!res.ok) {
    const msg = html?.slice(0, 400) || "";
    throw new Error(`HTTP ${status} ao buscar a página. Trecho: ${msg}`);
  }
  if (/Robot Check|captcha|Enter the characters you see|Are you a human\??/i.test(html)) {
    throw new Error("A loja retornou verificação (captcha/robot). Tente novamente ou use a API oficial da loja.");
  }
  return html;
};

// ---------- Genéricos ----------
const tryJSONLD = (html) => {
  try {
    const scripts = [...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )].map(m => m[1]);
    for (const raw of scripts) {
      let json; try { json = JSON.parse(raw.trim()); } catch { continue; }
      const arr = Array.isArray(json) ? json : [json];
      for (const node of arr) {
        const n = node || {};
        const t = String(n["@type"] || n.type || "").toLowerCase();
        if (t.includes("product")) {
          const title = clean(n.name || n.headline || "");
          const image = Array.isArray(n.image) ? n.image[0] : (n.image || "");
          let price = null, oldPrice = null, installment = "";
          if (n.offers) {
            const off = Array.isArray(n.offers) ? n.offers[0] : n.offers;
            price = toNumber(off?.price || off?.priceSpecification?.price);
            if (off?.highPrice && off?.lowPrice && toNumber(off.highPrice) !== toNumber(off.lowPrice)) {
              oldPrice = toNumber(off.highPrice);
              price = toNumber(off.lowPrice) ?? price;
            }
          }
          if (title || price || image) return { title, price, oldPrice, installment, image };
        }
      }
    }
  } catch {}
  return null;
};

const tryOG = (html) => {
  const get = (prop) => html.match(new RegExp(
    `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"
  ))?.[1] || "";
  return { title: clean(get("og:title")), image: get("og:image") };
};

// ---------- Parsers específicos ----------
const parseMercadoLivre = (html) => {
  let title = clean(between(html, '<h1 class="ui-pdp-title', "</h1>").replace(/^[^>]*>/, "")) || tryOG(html).title;
  let priceStr =
    between(html, 'itemprop="price" content="', '"') ||
    html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1]?.replace(/"/g, "") ||
    html.match(/"price":\s*([\d\.]+)/)?.[1] || "";
  const price = toNumber(priceStr);

  let oldStr =
    between(html, "price__original-value", "</s>").replace(/<[^>]+>/g, "") ||
    html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1]?.replace(/"/g, "") || "";
  const oldPrice = toNumber(oldStr);

  let installment = clean(
    between(html, 'class="ui-vip-installments', "</").replace(/<[^>]+>/g, "")
  );
  if (!installment) {
    const qtd = parseInt(html.match(/"installments"\s*:\s*{\s*"quantity"\s*:\s*(\d+)/)?.[1] || "", 10);
    const val = toNumber(html.match(/"amount"\s*:\s*("?[\d\.,]+"?)/)?.[1] || "");
    if (qtd && val) installment = `${qtd}x ${val.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})} sem juros`;
  }

  const og = tryOG(html);
  const image = og.image ||
    html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") || "";

  return { title, price, oldPrice, installment, image };
};

const parseAmazon = (html) => {
  let title = tryOG(html).title ||
    clean(html.match(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
  const priceText =
    html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
    html.match(/"priceAmount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
    html.match(/"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1];
  const price = toNumber(priceText);

  const oldText =
    html.match(/priceBlockStrikePriceString[^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
    html.match(/"wasPrice".*?"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] || null;
  const oldPrice = toNumber(oldText);

  let installment = clean((html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || ""));
  const og = tryOG(html);
  const image = og.image ||
    html.match(/data-old-hires=["']([^"']+)["']/i)?.[1] ||
    html.match(/"hiRes"\s*:\s*"([^"]+)"/i)?.[1] || "";

  return { title, price, oldPrice, installment, image };
};

const parseShopee = (html) => {
  const og = tryOG(html);
  let title = og.title;
  const priceRaw =
    html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") ||
    html.match(/"price_min"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") || null;
  const price = toNumber(priceRaw);

  const oldRaw =
    html.match(/"price_before_discount"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") || null;
  const oldPrice = toNumber(oldRaw);

  let installment = clean((html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || ""));
  const image = og.image || "";
  return { title, price, oldPrice, installment, image };
};

const parseGeneric = (html) => {
  const og = tryOG(html);
  const title = og.title;

  const price =
    toNumber(between(html, 'product:price:amount" content="', '"')) ||
    toNumber(between(html, 'itemprop="price" content="', '"')) ||
    toNumber(html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1]?.replace(/"/g, "")) || null;

  const oldPrice =
    toNumber(html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1]?.replace(/"/g, "")) || null;

  let installment = clean(
    (between(html, ">em até", "</").replace(/<[^>]+>/g, "")) ||
    (html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || "")
  );
  return { title, price, oldPrice, installment, image: og.image || "" };
};

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    const base = `http://localhost`;
    const urlObj = new URL(req.url, base);
    const productUrl = urlObj.searchParams.get("url");
    if (!productUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link-do-produto>" }));
    }

    const html = await fetchPage(productUrl);

    let data = tryJSONLD(html);
    const host = new URL(productUrl).hostname.toLowerCase();

    if (!data) {
      if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) {
        data = parseMercadoLivre(html);
      } else if (host.includes("amazon")) {
        data = parseAmazon(html);
      } else if (host.includes("shopee")) {
        data = parseShopee(html);
      }
    }
    if (!data || (!data.title && !data.price && !data.image)) {
      data = parseGeneric(html);
    }

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
    res.setHeader("cache-control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.end(JSON.stringify(payload));
  } catch (e) {
    // Log útil na Vercel
    console.error("[/api/parse] ERRO:", e?.message || e);

    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}
