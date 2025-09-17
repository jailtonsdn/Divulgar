// api/parse.js
export const config = { runtime: "nodejs" };

/* ... utils que você já tem (clean, toNumber, between, tryJSONLD, tryOG etc.) ... */

// === NEW: helpers Mercado Livre ===
const extractMeliIdFromUrlOrHtml = (productUrl, html = "") => {
  // tenta na URL
  const uMatch = productUrl.match(/(MLB\d{6,})/i);
  if (uMatch) return uMatch[1].toUpperCase();

  // tenta no og:url
  const ogUrl = (html.match(/property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1]) || "";
  const ogMatch = ogUrl.match(/(MLB\d{6,})/i);
  if (ogMatch) return ogMatch[1].toUpperCase();

  // tenta em qualquer lugar do HTML
  const any = html.match(/(MLB\d{6,})/i)?.[1];
  return any ? any.toUpperCase() : null;
};

const fetchMeliItem = async (id) => {
  const r = await fetch(`https://api.mercadolibre.com/items/${id}`);
  if (!r.ok) throw new Error(`ML API HTTP ${r.status}`);
  const j = await r.json();
  return {
    title: j.title || "",
    price: j.price ?? null,
    oldPrice: j.original_price ?? null,
    installment: "", // parcelas variam por vendedor; deixo vazio
    image: j.pictures?.[0]?.secure_url || j.thumbnail || "",
  };
};

// === seu fetchPage atual (Node headers) ===
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
    },
  });
  const html = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar a página`);
  if (/Robot Check|captcha|Are you a human/i.test(html)) {
    throw new Error("A loja retornou verificação (captcha/robot).");
  }
  return html;
};

// === parsers específicos (MercadoLivre, Amazon, Shopee) e parseGeneric como você já tem ===
// ... parseMercadoLivre(html) ...
// ... parseAmazon(html) ...
// ... parseShopee(html) ...
// ... parseGeneric(html) ...
// ... guessStore(url) ...

export default async function handler(req, res) {
  try {
    const urlObj = new URL(req.url, "http://localhost");
    const productUrl = urlObj.searchParams.get("url");
    if (!productUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link-do-produto>" }));
    }

    const host = new URL(productUrl).hostname.toLowerCase();
    let html = "";

    // 1) Para Mercado Livre, já tentamos pegar o ID antes mesmo do HTML
    let payload = null;
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) {
      try {
        html = await fetchPage(productUrl);
      } catch (e) {
        // mesmo sem HTML, dá pra tentar extrair MLB da própria URL
        const idFromUrl = extractMeliIdFromUrlOrHtml(productUrl);
        if (idFromUrl) {
          const meli = await fetchMeliItem(idFromUrl);
          payload = meli;
        } else {
          throw e; // sem ID e sem HTML, não há o que fazer
        }
      }

      if (!payload) {
        // tenta extrair MLB do HTML/og:url e chamar API oficial
        const meliId = extractMeliIdFromUrlOrHtml(productUrl, html);
        if (meliId) {
          payload = await fetchMeliItem(meliId);
        } else {
          // se não achou ID, cai no parser por HTML
          payload = parseMercadoLivre(html);
        }
      }
    } else {
      // Outras lojas: baixa HTML normalmente
      html = await fetchPage(productUrl);

      // 2) JSON-LD universal primeiro
      payload = tryJSONLD(html);

      // 3) Parsers por loja
      if (!payload) {
        if (host.includes("amazon")) payload = parseAmazon(html);
        else if (host.includes("shopee")) payload = parseShopee(html);
      }

      // 4) Fallback genérico
      if (!payload || (!payload.title && !payload.price && !payload.image)) {
        payload = parseGeneric(html);
      }
    }

    const response = {
      store: guessStore(productUrl),
      title: clean(payload?.title || ""),
      price: payload?.price ?? null,
      oldPrice: payload?.oldPrice ?? null,
      installment: clean(payload?.installment || ""),
      image: payload?.image || "",
      url: productUrl,
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.end(JSON.stringify(response));
  } catch (e) {
    console.error("[parse] ERRO:", e?.message || e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}
