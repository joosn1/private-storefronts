import express from "express";
import { createRequestHandler } from "@react-router/express";
import { createRequire } from "module";
import crypto from "crypto";

// ─── Prisma + session utils loaded dynamically after build ────────────────────
// We import these lazily so the server file works both in dev and production.

let prisma;
let sessionUtils;

async function getPrisma() {
  if (!prisma) {
    const mod = await import("./app/db.server.js");
    prisma = mod.default;
  }
  return prisma;
}

async function getSessionUtils() {
  if (!sessionUtils) {
    sessionUtils = await import("./app/utils/session.server.js");
  }
  return sessionUtils;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getContrastColor(hex) {
  try {
    const h = (hex || "#000000").replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.5 ? "#000000" : "#ffffff";
  } catch {
    return "#ffffff";
  }
}

function fmtPrice(amount, currency = "USD") {
  const n = parseFloat(amount);
  if (isNaN(n)) return "$0.00";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

// ─── Storefront HTML builder ──────────────────────────────────────────────────

function buildStorefrontHtml(storefront, products, storefrontToken, shopDomain) {
  const accent = storefront.primaryColor || "#000000";
  const contrast = getContrastColor(accent);

  const productCards = products.map((product) => {
    const first = product.variants[0];
    const multi = product.variants.length > 1;
    const variantOpts = multi
      ? product.variants.map((v) =>
          `<option value="${esc(v.id)}" data-price="${esc(v.price)}" data-currency="${esc(v.currencyCode)}" data-available="${v.availableForSale}" data-title="${esc(v.title)}">${esc(v.title)} — ${fmtPrice(v.price, v.currencyCode)}${!v.availableForSale ? " (Sold out)" : ""}</option>`
        ).join("")
      : "";

    return `<div class="product-card" data-product-id="${esc(product.id)}">
  ${product.image ? `<img src="${esc(product.image)}" alt="${esc(product.imageAlt)}" style="width:100%;height:220px;object-fit:cover;">` : `<div style="width:100%;height:220px;background:#eee;display:flex;align-items:center;justify-content:center;color:#999;font-size:.875rem;">No image</div>`}
  <div style="padding:1rem;">
    <h3 style="margin:0 0 .5rem;font-size:1rem;font-weight:600;">${esc(product.title)}</h3>
    ${multi ? `<select class="variant-select" data-product-id="${esc(product.id)}" style="width:100%;padding:.5rem;margin-bottom:.75rem;border:1px solid #ddd;border-radius:4px;font-size:.875rem;">${variantOpts}</select>` : first ? `<div data-variant-id="${esc(first.id)}" data-price="${esc(first.price)}" data-currency="${esc(first.currencyCode)}" data-available="${first.availableForSale}" style="margin-bottom:.75rem;"></div>` : ""}
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <span class="product-price" style="font-weight:700;font-size:1.125rem;">${first ? fmtPrice(first.price, first.currencyCode) : "—"}</span>
      <button class="add-to-cart-btn" data-product-id="${esc(product.id)}" data-variant-id="${esc(first?.id || "")}" data-variant-title="${esc(product.variants.length === 1 ? first?.title || "" : "")}" ${!first?.availableForSale ? "disabled" : ""} style="padding:.625rem 1.25rem;background:${first?.availableForSale ? accent : "#ccc"};color:${first?.availableForSale ? contrast : "#666"};border:none;border-radius:6px;font-size:.875rem;font-weight:600;cursor:${first?.availableForSale ? "pointer" : "not-allowed"};">
        ${first?.availableForSale ? "Add to Cart" : "Sold Out"}
      </button>
    </div>
  </div>
</div>`;
  }).join("\n");

  const cartScript = buildCartScript(shopDomain, storefrontToken, accent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(storefront.name)}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;}
    body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#f5f5f5;}
    .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.5rem;}
    @media(max-width:600px){.product-grid{grid-template-columns:1fr;}}
    .product-card{background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);}
    .product-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.12);transition:box-shadow .2s;}
  </style>
</head>
<body>
  <header style="background:${accent};color:${contrast};padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;">
    ${storefront.logoUrl ? `<img src="${esc(storefront.logoUrl)}" alt="${esc(storefront.name)}" style="height:44px;object-fit:contain;">` : ""}
    <div style="flex:1;">
      <div style="font-weight:700;font-size:1.375rem;">${esc(storefront.name)}</div>
      <div style="font-size:.875rem;opacity:.85;">${esc(storefront.companyName)}</div>
    </div>
    <button id="cart-toggle" style="background:transparent;border:none;cursor:pointer;color:${contrast};display:flex;align-items:center;gap:.5rem;font-size:1rem;padding:.5rem;border-radius:6px;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
      </svg>
      <span id="cart-count" style="font-weight:600;">0</span>
    </button>
  </header>
  <main style="max-width:1200px;margin:0 auto;padding:2rem 1rem;">
    ${products.length === 0
      ? `<div style="text-align:center;padding:3rem;color:#666;"><p style="font-size:1.125rem;">No products are currently available in this storefront.</p></div>`
      : `<div class="product-grid">${productCards}</div>`}
  </main>
  <div id="cart-panel" style="display:none;position:fixed;right:0;top:0;bottom:0;width:360px;background:white;box-shadow:-4px 0 20px rgba(0,0,0,.15);z-index:1000;overflow:auto;padding:1.5rem;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <h2 style="margin:0;font-size:1.25rem;">Your Cart</h2>
      <button id="cart-close" style="background:none;border:none;cursor:pointer;font-size:1.5rem;">✕</button>
    </div>
    <div id="cart-items"><p style="color:#666;">Your cart is empty.</p></div>
    <div id="cart-footer" style="display:none;border-top:1px solid #eee;padding-top:1rem;margin-top:1rem;">
      <div style="display:flex;justify-content:space-between;margin-bottom:1rem;font-weight:600;font-size:1.125rem;">
        <span>Total</span><span id="cart-total">$0.00</span>
      </div>
      <button id="checkout-btn" style="width:100%;padding:.875rem;background:${accent};color:${contrast};border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer;">
        Proceed to Checkout
      </button>
    </div>
  </div>
  <script>
    (function(){
      document.getElementById('cart-toggle').addEventListener('click',function(){var p=document.getElementById('cart-panel');p.style.display=p.style.display==='none'?'block':'none';});
      document.getElementById('cart-close').addEventListener('click',function(){document.getElementById('cart-panel').style.display='none';});
      document.getElementById('checkout-btn').addEventListener('click',function(){var u=localStorage.getItem('psf_checkout_url');if(u)window.location.href=u;});
    })();
    ${cartScript}
  </script>
</body>
</html>`;
}

function buildAuthHtml(storefront, proxyBase, error) {
  const accent = storefront.primaryColor || "#000000";
  const contrast = getContrastColor(accent);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(storefront.name)} — Enter Password</title>
  <style>*,*::before,*::after{box-sizing:border-box;}body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#f5f5f5;}input{outline:none;}</style>
</head>
<body>
  <header style="background:${accent};color:${contrast};padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;">
    ${storefront.logoUrl ? `<img src="${esc(storefront.logoUrl)}" alt="${esc(storefront.name)}" style="height:40px;object-fit:contain;">` : ""}
    <div><div style="font-weight:700;font-size:1.25rem;">${esc(storefront.name)}</div><div style="font-size:.875rem;opacity:.85;">${esc(storefront.companyName)}</div></div>
  </header>
  <main style="max-width:480px;margin:3rem auto;padding:0 1rem;">
    <div style="background:white;border-radius:10px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <h2 style="margin:0 0 .5rem;font-size:1.375rem;font-weight:700;">Enter Password</h2>
      <p style="margin:0 0 1.5rem;color:#555;font-size:.9rem;">This storefront is password-protected.</p>
      ${error ? `<div style="background:#fff0f0;border:1px solid #ffcccc;border-radius:6px;padding:.75rem 1rem;margin-bottom:1rem;color:#cc0000;font-size:.9rem;">${esc(error)}</div>` : ""}
      <form method="post" action="${esc(proxyBase)}/auth">
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem;">Password</label>
          <input name="password" type="password" required autofocus style="width:100%;padding:.75rem;border:1px solid #ddd;border-radius:6px;font-size:1rem;" onfocus="this.style.borderColor='${accent}'" onblur="this.style.borderColor='#ddd'">
        </div>
        <button type="submit" style="width:100%;padding:.875rem;background:${accent};color:${contrast};border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer;">Access Storefront</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function buildLoginHtml(storefront, proxyBase, error) {
  const accent = storefront.primaryColor || "#000000";
  const contrast = getContrastColor(accent);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(storefront.name)} — Sign In</title>
  <style>*,*::before,*::after{box-sizing:border-box;}body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#f5f5f5;}input{outline:none;}</style>
</head>
<body>
  <header style="background:${accent};color:${contrast};padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;">
    ${storefront.logoUrl ? `<img src="${esc(storefront.logoUrl)}" alt="${esc(storefront.name)}" style="height:40px;object-fit:contain;">` : ""}
    <div><div style="font-weight:700;font-size:1.25rem;">${esc(storefront.name)}</div><div style="font-size:.875rem;opacity:.85;">${esc(storefront.companyName)}</div></div>
  </header>
  <main style="max-width:480px;margin:3rem auto;padding:0 1rem;">
    <div style="background:white;border-radius:10px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <h2 style="margin:0 0 .5rem;font-size:1.375rem;font-weight:700;">Sign In</h2>
      <p style="margin:0 0 1.5rem;color:#555;font-size:.9rem;">Sign in to access this private storefront.</p>
      ${error ? `<div style="background:#fff0f0;border:1px solid #ffcccc;border-radius:6px;padding:.75rem 1rem;margin-bottom:1rem;color:#cc0000;font-size:.9rem;">${esc(error)}</div>` : ""}
      <form method="post" action="${esc(proxyBase)}/login">
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem;">Email Address</label>
          <input name="email" type="email" required autofocus autocomplete="email" style="width:100%;padding:.75rem;border:1px solid #ddd;border-radius:6px;font-size:1rem;" onfocus="this.style.borderColor='${accent}'" onblur="this.style.borderColor='#ddd'">
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem;">Password</label>
          <input name="password" type="password" required autocomplete="current-password" style="width:100%;padding:.75rem;border:1px solid #ddd;border-radius:6px;font-size:1rem;" onfocus="this.style.borderColor='${accent}'" onblur="this.style.borderColor='#ddd'">
        </div>
        <button type="submit" style="width:100%;padding:.875rem;background:${accent};color:${contrast};border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer;">Sign In</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function buildCartScript(shopDomain, storefrontToken, accentColor) {
  return `(function(){
  const SHOP=${JSON.stringify(shopDomain)},TOKEN=${JSON.stringify(storefrontToken)};
  const API='https://'+SHOP+'/api/2025-01/graphql.json';
  let cartId=localStorage.getItem('psf_cart_id');
  let lines=JSON.parse(localStorage.getItem('psf_cart_lines')||'[]');
  async function gql(q,v){const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':TOKEN},body:JSON.stringify({query:q,variables:v})});return r.json();}
  async function ensureCart(){if(cartId)return cartId;const{data}=await gql('mutation{cartCreate{cart{id checkoutUrl}}}');cartId=data?.cartCreate?.cart?.id;localStorage.setItem('psf_cart_id',cartId||'');localStorage.setItem('psf_checkout_url',data?.cartCreate?.cart?.checkoutUrl||'');return cartId;}
  function updateUI(){const tot=lines.reduce((s,l)=>s+l.price*l.qty,0),cnt=lines.reduce((s,l)=>s+l.qty,0);const ce=document.getElementById('cart-count'),ie=document.getElementById('cart-items'),fe=document.getElementById('cart-footer'),te=document.getElementById('cart-total');if(ce)ce.textContent=cnt;if(ie){if(!lines.length){ie.innerHTML='<p style="color:#666">Your cart is empty.</p>';}else{ie.innerHTML=lines.map(l=>'<div style="display:flex;justify-content:space-between;align-items:center;padding:.75rem 0;border-bottom:1px solid #eee"><div><div style="font-weight:600;font-size:.9rem">'+l.t+'</div>'+(l.vt?'<div style="font-size:.8rem;color:#666">'+l.vt+'</div>':'')+'<div style="font-size:.8rem;color:#666">Qty: '+l.qty+'</div></div><div style="font-weight:600">'+new Intl.NumberFormat('en-US',{style:'currency',currency:l.cur||'USD'}).format(l.price*l.qty)+'</div></div>').join('');}}if(fe)fe.style.display=lines.length?'block':'none';if(te)te.textContent=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(tot);localStorage.setItem('psf_cart_lines',JSON.stringify(lines));}
  async function addToCart(vid,vt,title,price,cur){const id=await ensureCart();if(!id){alert('Could not create cart.');return;}const{data}=await gql('mutation AddLines($cid:ID!,$ln:[CartLineInput!]!){cartLinesAdd(cartId:$cid,lines:$ln){cart{id checkoutUrl}userErrors{message}}}',{cid:id,ln:[{merchandiseId:vid,quantity:1}]});if(data?.cartLinesAdd?.cart?.checkoutUrl)localStorage.setItem('psf_checkout_url',data.cartLinesAdd.cart.checkoutUrl);const ex=lines.find(l=>l.id===vid);if(ex){ex.qty++;}else{lines.push({id:vid,t:title,vt,price:parseFloat(price),qty:1,cur});}updateUI();document.getElementById('cart-panel').style.display='block';}
  function attach(){document.querySelectorAll('.variant-select').forEach(function(sel){sel.addEventListener('change',function(){var card=this.closest('.product-card');if(!card)return;var opt=this.options[this.selectedIndex],pe=card.querySelector('.product-price'),btn=card.querySelector('.add-to-cart-btn'),price=opt.dataset.price,cur=opt.dataset.currency||'USD',avail=opt.dataset.available==='true';if(pe)pe.textContent=new Intl.NumberFormat('en-US',{style:'currency',currency:cur}).format(parseFloat(price));if(btn){btn.dataset.variantId=opt.value;btn.dataset.variantTitle=opt.text.split(' — ')[0];btn.disabled=!avail;btn.textContent=avail?'Add to Cart':'Sold Out';btn.style.background=avail?${JSON.stringify(accentColor)}:'#ccc';btn.style.cursor=avail?'pointer':'not-allowed';}});});document.querySelectorAll('.add-to-cart-btn').forEach(function(btn){btn.addEventListener('click',function(){var vid=this.dataset.variantId,vt=this.dataset.variantTitle||'',card=this.closest('.product-card'),title=card?.querySelector('h3')?.textContent||'Product',pt=card?.querySelector('.product-price')?.textContent||'0',price=pt.replace(/[^0-9.]/g,'');if(vid)addToCart(vid,vt,title,price,'USD');});});}
  updateUI();if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',attach);}else{attach();}
})();`;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleProxyMain(req, res) {
  try {
    const db = await getPrisma();
    const { buildSetCookieHeader, getSessionCookie, passwordCookieName, customerCookieName, SESSION_MAX_AGE } = await getSessionUtils();
    const { slug } = req.params;
    const shop = req.query.shop || "";

    const storefront = await db.storefront.findUnique({ where: { slug } });
    if (!storefront || !storefront.isActive) {
      return res.status(404).send("<h1>Storefront not found</h1>");
    }

    const proxyBase = shop ? `https://${shop}/apps/storefronts/${slug}` : `/storefronts/${slug}`;

    // Convert express request to a Request object for cookie parsing
    const cookieHeader = req.headers.cookie || "";
    const fakeRequest = { headers: { get: (h) => h === "cookie" ? cookieHeader : null } };

    if (storefront.password && !storefront.requireLogin) {
      const verified = getSessionCookie(fakeRequest, passwordCookieName(slug));
      if (!verified) return res.redirect(302, `${proxyBase}/auth`);
    }

    if (storefront.requireLogin) {
      const customerId = getSessionCookie(fakeRequest, customerCookieName(slug));
      if (!customerId) return res.redirect(302, `${proxyBase}/login`);
    }

    // Load products
    const { fetchProductsByIds } = await import("./app/utils/storefront-api.server.js");
    const storefrontProducts = await db.storefrontProduct.findMany({
      where: { storefrontId: storefront.id, isVisible: true },
      orderBy: { sortOrder: "asc" },
    });

    const uniqueProductIds = [...new Set(storefrontProducts.map((p) => p.shopifyProductId))];
    let shopifyProducts = [];
    if (uniqueProductIds.length > 0) {
      shopifyProducts = await fetchProductsByIds(storefront.shopDomain, uniqueProductIds);
    }

    const customPriceMap = {};
    for (const sp of storefrontProducts) {
      if (sp.customPrice !== null) customPriceMap[sp.shopifyVariantId] = sp.customPrice.toString();
    }

    const allowedVariantIds = new Set(storefrontProducts.map((p) => p.shopifyVariantId));
    const products = shopifyProducts
      .filter((p) => p && p.id)
      .map((product) => ({
        id: product.id,
        title: product.title,
        image: product.featuredImage?.url || null,
        imageAlt: product.featuredImage?.altText || product.title,
        variants: (product.variants?.edges || [])
          .map((e) => e.node)
          .filter((v) => allowedVariantIds.has(v.id))
          .map((v) => ({
            id: v.id,
            title: v.title,
            price: customPriceMap[v.id] ?? v.price?.amount ?? "0",
            currencyCode: v.price?.currencyCode ?? "USD",
            availableForSale: v.availableForSale,
          })),
      }))
      .filter((p) => p.variants.length > 0);

    const token = process.env.SHOPIFY_STOREFRONT_TOKEN || "";
    const html = buildStorefrontHtml(storefront, products, token, storefront.shopDomain);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("Proxy main error:", err);
    res.status(500).send("<h1>Server error</h1>");
  }
}

async function handleProxyAuth(req, res) {
  try {
    const db = await getPrisma();
    const { buildSetCookieHeader, getSessionCookie, passwordCookieName, SESSION_MAX_AGE } = await getSessionUtils();
    const { slug } = req.params;
    const shop = req.query.shop || "";
    const proxyBase = shop ? `https://${shop}/apps/storefronts/${slug}` : `/storefronts/${slug}`;

    const storefront = await db.storefront.findUnique({ where: { slug } });
    if (!storefront || !storefront.isActive) return res.status(404).send("Not Found");
    if (!storefront.password) return res.redirect(302, proxyBase);

    const cookieHeader = req.headers.cookie || "";
    const fakeRequest = { headers: { get: (h) => h === "cookie" ? cookieHeader : null } };
    const verified = getSessionCookie(fakeRequest, passwordCookieName(slug));
    if (verified) return res.redirect(302, proxyBase);

    if (req.method === "POST") {
      const bcrypt = (await import("bcryptjs")).default;
      const password = req.body?.password || "";
      if (!password) {
        return res.send(buildAuthHtml(storefront, proxyBase, "Please enter the password."));
      }
      const isValid = await bcrypt.compare(password, storefront.password);
      if (!isValid) {
        return res.send(buildAuthHtml(storefront, proxyBase, "Incorrect password. Please try again."));
      }
      const cookieStr = buildSetCookieHeader(passwordCookieName(slug), "1", { maxAge: SESSION_MAX_AGE });
      res.setHeader("Set-Cookie", cookieStr);
      return res.redirect(302, proxyBase);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildAuthHtml(storefront, proxyBase, null));
  } catch (err) {
    console.error("Proxy auth error:", err);
    res.status(500).send("<h1>Server error</h1>");
  }
}

async function handleProxyLogin(req, res) {
  try {
    const db = await getPrisma();
    const { buildSetCookieHeader, getSessionCookie, customerCookieName, SESSION_MAX_AGE } = await getSessionUtils();
    const { slug } = req.params;
    const shop = req.query.shop || "";
    const proxyBase = shop ? `https://${shop}/apps/storefronts/${slug}` : `/storefronts/${slug}`;

    const storefront = await db.storefront.findUnique({ where: { slug } });
    if (!storefront || !storefront.isActive) return res.status(404).send("Not Found");
    if (!storefront.requireLogin) return res.redirect(302, proxyBase);

    const cookieHeader = req.headers.cookie || "";
    const fakeRequest = { headers: { get: (h) => h === "cookie" ? cookieHeader : null } };
    const customerId = getSessionCookie(fakeRequest, customerCookieName(slug));
    if (customerId) {
      const customer = await db.storefrontCustomer.findFirst({
        where: { id: customerId, storefrontId: storefront.id, isActive: true },
      });
      if (customer) return res.redirect(302, proxyBase);
    }

    if (req.method === "POST") {
      const bcrypt = (await import("bcryptjs")).default;
      const email = (req.body?.email || "").trim().toLowerCase();
      const password = req.body?.password || "";
      if (!email || !password) {
        return res.send(buildLoginHtml(storefront, proxyBase, "Email and password are required."));
      }
      const customer = await db.storefrontCustomer.findFirst({
        where: { storefrontId: storefront.id, email, isActive: true },
      });
      if (!customer || !(await bcrypt.compare(password, customer.passwordHash))) {
        return res.send(buildLoginHtml(storefront, proxyBase, "Invalid email or password."));
      }
      const cookieStr = buildSetCookieHeader(customerCookieName(slug), customer.id, { maxAge: SESSION_MAX_AGE });
      res.setHeader("Set-Cookie", cookieStr);
      return res.redirect(302, proxyBase);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildLoginHtml(storefront, proxyBase, null));
  } catch (err) {
    console.error("Proxy login error:", err);
    res.status(500).send("<h1>Server error</h1>");
  }
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Proxy routes — handled BEFORE React Router so no hydration issues
app.all("/storefronts/:slug/auth", handleProxyAuth);
app.all("/storefronts/:slug/login", handleProxyLogin);
app.get("/storefronts/:slug", handleProxyMain);

// Everything else goes to React Router
const BUILD_PATH = "./build/server/index.js";
app.all("*", async (req, res, next) => {
  try {
    const build = await import(BUILD_PATH);
    return createRequestHandler({ build })(req, res, next);
  } catch (err) {
    next(err);
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
