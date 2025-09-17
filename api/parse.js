// api/parse.js
// Vercel serverless: GET /api/parse?url=<produto>
// Faz fetch do HTML e tenta extrair: título, preço, preço antigo, parcelas, imagem, loja.

export const config = { runtime: "edge" };

const fetchPage = async (url) => {
  const res = await fetch(url, {
    // user-agent “real” ajuda a receber HTML completo
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
};

const between = (str, a, b) => {
  const i = str.indexOf(a);
  if (i === -1) return "";
  const j = str.indexOf(b, i + a.length);
  if (j === -1) return "";
  return str.slice(i + a.length, j);
};

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

const toNumber = (s) => {
  if (!s) return null;
  // aceita “R$ 1.234,56”, “1234.56”, etc.
  const only = String(s).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  const norm = only.replace(",", ".");
  const n = parseFloat(norm);
  return isNaN(n) ? null : n;
};

const tryJSONLD = (html) => {
  // Pega todos <script type="application/ld+json"> e tenta achar “offers”
  const scripts = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )].map(m => m[1]);

  for (const raw of scripts) {
    try {
      const j = JSON.parse(raw.trim());
      const arr = Array.isArray(j) ? j : [j];
      for (const node of arr) {
        const n = node || {};
        if (n["@type"] && (n["@type"] === "Product" || n["@type"] === "Offer")) {
          const title = n.name || n.headline || "";
          const image = Array.isArray(n.image) ? n.image[0] : n.image || "";
          let price = null, oldPrice = null;
          let installment = "";

          if (n.offers) {
            const off = Array.isArray(n.offers) ? n.offers[0] : n.offers;
            price = toNumber(off.price || off.priceSpecification?.price);
            // algumas páginas trazem priceCurrency/priceValidUntil etc.
            // preço antigo às vezes vem como "price" em outra offers; ignoramos aqui.
          }

          // Mercado Livre costuma ter aggregateRating/brand etc., mas não precisamos.
          if (title || price || image) {
            return { title: clean(title), price, oldPrice, installment, image };
          }
        }
      }
    } catch {}
  }
  return null;
};

const tryOG = (html) => {
  // Fallback usando OpenGraph
  const og = (p) => {
    const r = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, "i");
    const m = html.match(r);
    return m ? m[1] : "";
  };
  return {
    title: clean(og("og:title")),
    image: og("og:image"),
  };
};

const parseMercadoLivre = (html) => {
  // Título
  let title = clean(
    between(html, '<h1 class="ui-pdp-title', "</h1>").replace(/^[^>]*>/, "")
  );
  if (!title) {
    // og:title
    const og = tryOG(html);
    title = og.title;
  }
  // Preço atual
  // (ML já mudou classes várias vezes; tentamos alguns padrões)
  let priceStr =
    between(html, 'itemprop="price" content="', '"') ||
    between(html, '"price":', ",").replace(/[^\d,.-]/g, "") ||
    between(html, '"price":"', '"');

  let price = toNumber(priceStr);

  // Preço antigo (se houver)
  let oldStr =
    between(html, "price__original-value", "</s>").replace(/<[^>]+>/g, "") ||
    between(html, '"list_price":', ",").replace(/[^\d,.-]/g, "") ||
    "";
  let oldPrice = toNumber(oldStr);

  // Parcelas (busca linhas comuns)
  let installment = clean(
    between(html, "text__secondary\">", "</p>").replace(/<[^>]+>/g, "")
  );
  if (!installment) {
    const maybe = between(html, '"installments":{"quantity":', "}").slice(0, 60);
    const qtd = parseInt(maybe, 10);
    const val = toNumber(between(html, '"amount":', ","));
    if (qtd && val) installment = `${qtd}x ${val.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})} sem juros`;
  }

  // Imagem
  let image =
    between(html, 'property="og:image" content="', '"') ||
    between(html, '"secure_url":"', '"').replace(/\\u002F/g, "/");

  return { title, price, oldPrice, installment, image };
};

const parseAmazonShopeeMagalu = (html) => {
  // Heurística genérica com OG e alguns metatags de produto
  const og = tryOG(html);
  let title = og.title;

  // Preço (tentativa com metatags comuns)
  let price =
    toNumber(between(html, 'product:price:amount" content="', '"')) ||
    toNumber(between(html, 'itemprop="price" content="', '"')) ||
    toNumber(between(html, '"price": "', '"')) ||
    null;

  // Preço antigo (muitos não expõem; fica null)
  let oldPrice = toNumber(between(html, "price-old", "</").replace(/<[^>]+>/g, ""));

  // Parcelas (texto solto)
  let installment = clean(
    between(html, ">em até", "</").replace(/<[^>]+>/g, "")
  );
  if (installment) installment = ("em até " + installment).trim();

  return { title, price, oldPrice, installment, image: og.image };
};

const guessStore = (u) => {
  try {
    const host = new URL(u).hostname;
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic"))
      return "Mercado Livre";
    if (host.includes("amazon")) return "Amazon";
    if (host.includes("shopee")) return "Shopee";
    if (host.includes("magalu") || host.includes("magazineluiza")) return "Magalu";
    return host.replace(/^www\./, "");
  } catch {
    return "Loja";
  }
};

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const productUrl = searchParams.get("url");
    if (!productUrl) {
      return new Response(JSON.stringify({ error: "Informe ?url=" }), { status: 400 });
    }

    const html = await fetchPage(productUrl);

    let data =
      tryJSONLD(html) ||
      (productUrl.includes("mercadolivre") ? parseMercadoLivre(html) : null) ||
      parseAmazonShopeeMagalu(html);

    // Normaliza
    data = {
      store: guessStore(productUrl),
      title: clean(data?.title) || "",
      price: data?.price ?? null,
      oldPrice: data?.oldPrice ?? null,
      installment: clean(data?.installment) || "",
      image: data?.image || "",
      url: productUrl,
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
