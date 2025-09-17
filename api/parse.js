// api/parse.js
// Node runtime (Vercel). Best-effort scraping + geração tentativa de link de afiliado sem usar APIs oficiais.
// - Se AMAZON_TAG estiver setada nas ENV vars, será anexada automaticamente nos links da Amazon.
// - Se AFFILIATE_CONVERTER_URL estiver setada, o endpoint tentará chamar essa URL (POST { url }) para obter link convertido.
// - Fallback: retorna o link original e um hint informando que a conversão pode exigir API oficial.

export const config = { runtime: "nodejs" };

// ----------------- Utils -----------------
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const toNumber = (s) => {
  if (s === null || s === undefined) return null;
  const only = String(s).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  const norm = only.replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
};
const tryOG = (html) => {
  const getMeta = (p) => {
    const re = new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, "i");
    return html.match(re)?.[1] || "";
  };
  return { title: clean(getMeta("og:title")), image: getMeta("og:image") };
};
const fetchPage = async (url) => {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8",
      "cache-control": "no-cache",
    },
  });
  const html = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} buscando a página`);
  if (/Robot Check|captcha|Are you a human\??/i.test(html)) {
    throw new Error("Bloqueio/captcha detectado na loja (robot check).");
  }
  return html;
};
const guessStore = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h.includes("mercadolivre") || h.includes("mercadolibre") || h.includes("mlstatic")) return "Mercado Livre";
    if (h.includes("amazon")) return "Amazon";
    if (h.includes("shopee")) return "Shopee";
    if (h.includes("magalu") || h.includes("magazineluiza")) return "Magalu";
    return h.replace(/^www\./, "");
  } catch { return "Loja"; }
};

// ----------------- Parsers (simples, best-effort) -----------------
const parseMercadoLivre = (html) => {
  const og = tryOG(html);
  let title = og.title || clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  let price = toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1] || html.match(/"price"\s*:\s*("?[\d\.,]+"?)/)?.[1] || "");
  let oldPrice = toNumber(html.match(/"list_price"\s*:\s*("?[\d\.,]+"?)/)?.[1] || "");
  let installment = clean(html.match(/"installments"[\s\S]{0,200}/i)?.[0] || "");
  const image = og.image || html.match(/"secure_url"\s*:\s*"([^"]+)"/)?.[1] || "";
  return { title, price, oldPrice, installment, image };
};
const parseAmazon = (html) => {
  const og = tryOG(html);
  let title = og.title || clean(html.match(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
  let price = toNumber(html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] || html.match(/"priceAmount"\s*:\s*"([\d\.\,]+)"/i)?.[1] || "");
  let oldPrice = toNumber(html.match(/priceBlockStrikePriceString[^>]*>(R\$\s?[\d\.\,]+)<\/span>/i)?.[1] || "");
  let installment = clean(html.match(/em até[^<]+de[^<]+R\$\s?[\d\.\,]+/i)?.[0] || "");
  const image = og.image || html.match(/data-old-hires=["']([^"']+)["']/i)?.[1] || "";
  return { title, price, oldPrice, installment, image };
};
const parseShopee = (html) => {
  const og = tryOG(html);
  const title = og.title || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const price = toNumber(html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") || null);
  const oldPrice = toNumber(html.match(/"price_before_discount"\s*:\s*("?[\d\.\,]+"?)/i)?.[1]?.replace(/"/g, "") || null);
  const installment = "";
  const image = og.image || "";
  return { title, price, oldPrice, installment, image };
};
const parseGeneric = (html) => {
  const og = tryOG(html);
  const title = og.title || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const price = toNumber(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1] || html.match(/"price"\s*:\s*("?[\d\.\,]+"?)/)?.[1] || null);
  const oldPrice = toNumber(html.match(/"list_price"\s*:\s*("?[\d\.\,]+"?)/)?.[1] || null);
  const installment = "";
  const image = og.image || "";
  return { title, price, oldPrice, installment, image };
};

// ----------------- Affiliate attempt (sem API) -----------------
// Estratégia:
// 1) Se AFFILIATE_CONVERTER_URL estiver configurada, tenta POST { url } e espera { affiliateUrl }.
// 2) Se host Amazon e AMAZON_TAG estiver configurada, adiciona tag à url.
// 3) Para demais lojas, adiciona parâmetros UTM/placeholder (não é garantia de comissionamento).
const tryGenerateAffiliate = async (productUrl) => {
  const env = process.env;
  // 1) Rede conversora (opcional)
  const converter = env.AFFILIATE_CONVERTER_URL;
  if (converter) {
    try {
      const r = await fetch(converter, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: productUrl })
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.affiliateUrl) return { affiliateUrl: j.affiliateUrl, affiliateHint: "convertido_via_rede" };
      }
    } catch (e) {
      // se falhar, a gente continua para outras tentativas
      console.warn("Affiliate converter failed:", e?.message || e);
    }
  }

  // 2) Amazon simple append (se tiver TAG)
  try {
    const host = new URL(productUrl).hostname.toLowerCase();
    if (host.includes("amazon")) {
      const tag = process.env.AMAZON_TAG || "";
      if (tag) {
        try {
          const u = new URL(productUrl);
          // Amazon aceita 'tag' param (associates). Substitui ou adiciona.
          u.searchParams.set("tag", tag);
          return { affiliateUrl: u.toString(), affiliateHint: "amazon_tag_appended" };
        } catch {}
      } else {
        return { affiliateUrl: productUrl, affiliateHint: "amazon_no_tag_provided" };
      }
    }

    // 3) Mercado Livre / Shopee / Magalu - tentativa de UTM (não é link de afiliado real)
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host.includes("mlstatic")) {
      const u = new URL(productUrl);
      // adiciona utm mínimas para rastrear origem (útil localmente)
      u.searchParams.set("utm_source", "gerador");
      u.searchParams.set("utm_medium", "whatsapp");
      return { affiliateUrl: u.toString(), affiliateHint: "meli_utms_added_no_guarantee" };
    }
    if (host.includes("shopee")) {
      const u = new URL(productUrl);
      u.searchParams.set("utm_source", "gerador");
      u.searchParams.set("utm_medium", "whatsapp");
      return { affiliateUrl: u.toString(), affiliateHint: "shopee_utms_added_no_guarantee" };
    }
    if (host.includes("magalu") || host.includes("magazineluiza")) {
      const u = new URL(productUrl);
      u.searchParams.set("utm_source", "gerador");
      u.searchParams.set("utm_medium", "whatsapp");
      return { affiliateUrl: u.toString(), affiliateHint: "magalu_utms_added_no_guarantee" };
    }
  } catch (e) {
    // ignore
  }

  // Default: devolve original
  return { affiliateUrl: productUrl, affiliateHint: "no_affiliate_possible" };
};

// ----------------- Handler -----------------
export default async function handler(req, res) {
  try {
    const base = "http://localhost";
    const urlObj = new URL(req.url, base);
    const productUrl = urlObj.searchParams.get("url");
    if (!productUrl) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Informe ?url=<link-do-produto>" }));
    }

    // baixa HTML (try)
    let html = "";
    try {
      html = await fetchPage(productUrl);
    } catch (e) {
      // se bloqueou, ainda tentamos gerar affiliate e retornar hint
      const affiliate = await tryGenerateAffiliate(productUrl);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({
        store: guessStore(productUrl),
        title: "",
        price: null,
        oldPrice: null,
        installment: "",
        image: "",
        url: productUrl,
        affiliateUrl: affiliate.affiliateUrl,
        affiliateHint: affiliate.affiliateHint,
        note: "Não foi possível buscar HTML (bloqueio ou erro). Retornando affiliateHint."
      }));
    }

    // tenta parsers específicos
    const host = new URL(productUrl).hostname.toLowerCase();
    let parsed = null;
    // JSON-LD / OG
    const og = tryOG(html);
    if (og.title || og.image) parsed = { title: og.title, price: null, oldPrice: null, installment: "", image: og.image };

    if (!parsed || (!parsed.title && !parsed.image)) {
      if (host.includes("mercadolivre") || host.includes("mlstatic")) parsed = parseMercadoLivre(html);
      else if (host.includes("amazon")) parsed = parseAmazon(html);
      else if (host.includes("shopee")) parsed = parseShopee(html);
      else parsed = parseGeneric(html);
    }

    // tenta gerar affiliate (best-effort sem API)
    const affiliate = await tryGenerateAffiliate(productUrl);

    // resposta final
    const payload = {
      store: guessStore(productUrl),
      title: clean(parsed?.title || ""),
      price: parsed?.price ?? null,
      oldPrice: parsed?.oldPrice ?? null,
      installment: clean(parsed?.installment || ""),
      image: parsed?.image || "",
      url: productUrl,
      affiliateUrl: affiliate.affiliateUrl,
      affiliateHint: affiliate.affiliateHint
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=30, s-maxage=120");
    return res.end(JSON.stringify(payload));
  } catch (e) {
    console.error("[/api/parse] ERRO:", e?.message || e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}
