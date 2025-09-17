// api/parse.js
// Gerador de conteúdo para WhatsApp a partir de link encurtado de AFILIADOS.
// - Segue redirecionamentos (amzn.to, /sec/, etc.) e usa a URL expandida para parse.
// - NÃO usa API oficial das lojas. É "best-effort" (pode falhar em casos com captcha/robot).
// - Retorna: { store, title, price, oldPrice, installment, image, shareUrl, finalUrl, parseHint }

export const config = { runtime: "nodejs" };

/* ---------------- Utils ---------------- */
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
    const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
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

/**
 * Faz o fetch da página seguindo redirecionamentos.
 * Retorna { html, finalUrl } — importantíssimo usar finalUrl para decidir o parser.
 */
const fetchPageFollow = async (url) => {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
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

/* ---------------- Parsers por loja (best-effort) ---------------- */
const parseMercadoLivre = (html) => {
  const og = tryOG(html);
  const title =
    og.title ||
    clean(html.match(/<h1[^>]*class=["'][^"']*ui-pdp-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "") || "");

  const price =
    toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1]) ||
    toNumber(html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1]) ||
    null;

  const oldPrice =
    toNumber(html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1]) ||
    null;

  // tentativa simples de parcelas; varia muito
  const installment =
    clean(html.match(/em até[^<]{0,80}R\$\s?[\d\.\,]+/i)?.[0] || "");

  const image =
    og.image ||
    (html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/")) ||
    "";

  return { title, price, oldPrice, installment, image, parseHint: "ml_html" };
};

// Substitua sua parseAmazon por esta
const parseAmazon = (html) => {
  // 1) Título
  const title =
    (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]) ||
    clean(html.match(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");

  // 2) Tenta extrair do BLOCO OFICIAL DE PREÇO (desktop/mobile)
  //    Esse bloco tem o "a-price-whole" e "a-price-fraction".
  const priceBlock =
    html.match(/id=["']corePriceDisplay_[^"']+["'][\s\S]{0,4000}?<\/div>/i)?.[0] ||
    html.match(/id=["']apex_desktop["'][\s\S]{0,4000}?<\/div>/i)?.[0] ||
    "";

  let price = null, oldPrice = null;

  if (priceBlock) {
    const whole = priceBlock.match(/class=["']a-price-whole["'][^>]*>([\d\.\,]+)/i)?.[1];
    const frac  = priceBlock.match(/class=["']a-price-fraction["'][^>]*>(\d{1,2})/i)?.[1];
    if (whole && frac) {
      price = toNumber(`${whole},${frac}`);
    } else {
      // fallback dentro do bloco (algumas páginas ainda rendem a-offscreen)
      const off = priceBlock.match(/a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1];
      price = toNumber(off);
    }

    // preço antigo (strike) dentro do mesmo bloco
    const oldInBlock =
      priceBlock.match(/class=["'][^"']*a-text-price[^"']*["'][\s\S]*?a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      priceBlock.match(/id=["']priceblock_strikeprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      null;
    oldPrice = toNumber(oldInBlock);
  }

  // 3) Fallbacks globais (caso o bloco oficial não exista nesta variação)
  if (price == null) {
    const priceText =
      html.match(/id=["']priceblock_dealprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/id=["']priceblock_ourprice["'][^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] ||
      html.match(/"priceAmount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"price"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      null;
    price = toNumber(priceText);
  }
  if (oldPrice == null) {
    const oldText =
      html.match(/class=["'][^"']*a-text-price[^"']*["'][\s\S]*?a-offscreen[^>]*>(R\$\s?[\d\.\,]+)</i)?.[1] ||
      html.match(/(?:De:|Preço\s+de\s+tabela)[^<]*?(R\$\s?[\d\.\,]+)/i)?.[1] ||
      html.match(/"wasPrice".*?"amount"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      html.match(/"strikePrice"\s*:\s*"([\d\.\,]+)"/i)?.[1] ||
      null;
    oldPrice = toNumber(oldText);
  }

  // 4) Parcelamento — pegue o MAIOR “Nx de R$ … (sem juros)”
  //    (em algumas páginas aparecem várias opções; escolhemos a de maior N)
  const allInstallments = Array.from(
    html.matchAll(/(?:em\s+até\s+)?(\d{1,2})x[^<]{0,80}R\$\s?([\d\.\,]+)(?:\s+sem\s+juros)?/ig)
  ).map(m => ({ n: parseInt(m[1], 10), val: m[2] }));
  let installment = "";
  if (allInstallments.length) {
    const best = allInstallments.sort((a,b)=> b.n - a.n)[0];
    installment = `${best.n}x de R$ ${best.val}${/sem\s+juros/i.test(html) ? " sem juros" : ""}`;
  }

  // 5) Imagem (OG / data-old-hires / data-a-dynamic-image / landingImage)
  let image =
    (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]) ||
    (html.match(/data-old-hires=["']([^"']+)["']/i)?.[1]) ||
    "";
  if (!image) {
    const dyn = html.match(/data-a-dynamic-image=['"]({[^'"]+})['"]/i)?.[1];
    if (dyn) {
      try {
        const j = JSON.parse(dyn.replace(/&quot;/g, '"'));
        const first = Object.keys(j)[0];
        if (first) image = first;
      } catch {}
    }
  }
  if (!image) {
    image = html.match(/id=["']landingImage["'][^>]+src=["']([^"']+)["']/i)?.[1] || "";
  }

  return { title, price, oldPrice, installment, image, parseHint: "amazon_html_v3" };
};



const parseShopee = (html) => {
  const og = tryOG(html);
  const title =
    og.title ||
    clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");

  const price =
    toNumber(html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "")) ||
    toNumber(html.match(/"price_min"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "")) ||
    null;

  const oldPrice =
    toNumber(html.match(/"price_before_discount"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "")) ||
    null;

  const image = og.image || "";
  const installment = ""; // geralmente não vem fácil

  return { title, price, oldPrice, installment, image, parseHint: "shopee_html" };
};

const parseGeneric = (html) => {
  const og = tryOG(html);
  const title = og.title || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const price =
    toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1]) ||
    toNumber(html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1]) ||
    null;
  const oldPrice =
    toNumber(html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1]) ||
    null;
  const image = og.image || "";
  const installment = "";
  return { title, price, oldPrice, installment, image, parseHint: "generic_og" };
};

/* ---------------- Handler ---------------- */
export default async function handler(req, res) {
  try {
    const base = "http://localhost";
    const urlObj = new URL(req.url, base);
    const shortUrl = urlObj.searchParams.get("url"); // link encurtado do seu painel
    if (!shortUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link_encurtado_de_afiliado>" }));
    }

    // 1) Baixa e EXPANDE a URL
    const { html, finalUrl } = await fetchPageFollow(shortUrl);
    const host = new URL(finalUrl).hostname.toLowerCase();

    // 2) Decide parser pela URL FINAL (não pelo encurtado)
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

    // 3) Monta payload — shareUrl SEMPRE é o link encurtado original (preserva tracking do painel)
    const payload = {
      store: guessStore(finalUrl),
      title: clean(data?.title || ""),
      price: data?.price ?? null,
      oldPrice: data?.oldPrice ?? null,
      installment: clean(data?.installment || ""),
      image: data?.image || "",
      shareUrl: shortUrl,
      finalUrl: finalUrl,
      parseHint: data?.parseHint || "n/a"
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=30, s-maxage=120");
    return res.end(JSON.stringify(payload));
  } catch (e) {
    console.error("[/api/parse] ERRO:", e?.message || e);
    res.statusCode = 200; // mantém 200 para o front não estourar modal; devolve dados vazios e dica
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
      note: String(e?.message || e)
    }));
  }
}
