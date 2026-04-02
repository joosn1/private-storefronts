import { useLoaderData, useOutlet } from "react-router";
import prisma from "../db.server";
import { fetchProductsByIds } from "../utils/storefront-api.server";
import {
  getSessionCookie,
  passwordCookieName,
  customerCookieName,
} from "../utils/session.server";

// ─── Server ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { slug } = params;

  // 1. Load storefront
  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront || !storefront.isActive) {
    throw new Response("Storefront not found", { status: 404 });
  }

  // Shopify App Proxy injects ?shop= into every request
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || storefront.shopDomain;

  // Proxy base URL on the merchant's domain
  const proxyBase = `https://${shop}/apps/storefronts/${slug}`;

  // Determine if this is the index path or a sub-route (auth/login)
  // Shopify forwards /apps/storefronts/slug → our server receives /storefronts/slug
  const normalizedPath = url.pathname.replace(/\/$/, "");
  const isIndex = normalizedPath === `/storefronts/${slug}`;

  if (!isIndex) {
    return {
      storefront: {
        id: storefront.id,
        name: storefront.name,
        slug: storefront.slug,
        companyName: storefront.companyName,
        logoUrl: storefront.logoUrl,
        primaryColor: storefront.primaryColor,
        requireLogin: storefront.requireLogin,
        hasPassword: !!storefront.password,
      },
      products: [],
      customPriceMap: {},
      isIndex: false,
      proxyBase,
    };
  }

  // 2. Auth checks for the main storefront page
  if (storefront.password && !storefront.requireLogin) {
    const verified = getSessionCookie(request, passwordCookieName(slug));
    if (!verified) {
      throw new Response(null, {
        status: 302,
        headers: { Location: `${proxyBase}/auth` },
      });
    }
  }

  if (storefront.requireLogin) {
    const customerId = getSessionCookie(request, customerCookieName(slug));
    if (!customerId) {
      throw new Response(null, {
        status: 302,
        headers: { Location: `${proxyBase}/login` },
      });
    }
  }

  // 3. Load products
  const storefrontProducts = await prisma.storefrontProduct.findMany({
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
    if (sp.customPrice !== null && sp.customPrice !== undefined) {
      customPriceMap[sp.shopifyVariantId] = sp.customPrice.toString();
    }
  }

  const allowedVariantIds = new Set(storefrontProducts.map((p) => p.shopifyVariantId));

  const products = shopifyProducts
    .filter((p) => p && p.id)
    .map((product) => ({
      id: product.id,
      title: product.title,
      description: product.description || "",
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
          image: v.image?.url || null,
        })),
    }))
    .filter((p) => p.variants.length > 0);

  return {
    storefront: {
      id: storefront.id,
      name: storefront.name,
      slug: storefront.slug,
      companyName: storefront.companyName,
      logoUrl: storefront.logoUrl,
      primaryColor: storefront.primaryColor,
      requireLogin: storefront.requireLogin,
      hasPassword: !!storefront.password,
    },
    products,
    customPriceMap,
    isIndex: true,
    storefrontToken: process.env.SHOPIFY_STOREFRONT_TOKEN || "",
    shopDomain: storefront.shopDomain,
    proxyBase,
  };
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProxyStorefrontRoute() {
  const data = useLoaderData();
  const outlet = useOutlet();
  const { storefront } = data;

  const headerStyle = {
    background: storefront.primaryColor,
    color: getContrastColor(storefront.primaryColor),
    padding: "1rem 1.5rem",
    display: "flex",
    alignItems: "center",
    gap: "1rem",
  };

  if (outlet) {
    return (
      <div style={{ fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
        <style>{globalStyles}</style>
        <header style={headerStyle}>
          {storefront.logoUrl && (
            <img
              src={storefront.logoUrl}
              alt={storefront.name}
              style={{ height: "40px", objectFit: "contain" }}
            />
          )}
          <div>
            <div style={{ fontWeight: 700, fontSize: "1.25rem" }}>{storefront.name}</div>
            <div style={{ fontSize: "0.875rem", opacity: 0.85 }}>{storefront.companyName}</div>
          </div>
        </header>
        <main style={{ maxWidth: "480px", margin: "3rem auto", padding: "0 1rem" }}>
          {outlet}
        </main>
      </div>
    );
  }

  return (
    <StorefrontPage
      storefront={storefront}
      products={data.products}
      storefrontToken={data.storefrontToken}
      shopDomain={data.shopDomain}
      headerStyle={headerStyle}
    />
  );
}

// ─── Main Storefront Page ─────────────────────────────────────────────────────

function StorefrontPage({ storefront, products, storefrontToken, shopDomain, headerStyle }) {
  const accentColor = storefront.primaryColor;
  const contrastColor = getContrastColor(accentColor);

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
      <style>{globalStyles}</style>

      <header style={headerStyle}>
        {storefront.logoUrl && (
          <img
            src={storefront.logoUrl}
            alt={storefront.name}
            style={{ height: "44px", objectFit: "contain" }}
          />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: "1.375rem" }}>{storefront.name}</div>
          <div style={{ fontSize: "0.875rem", opacity: 0.85 }}>{storefront.companyName}</div>
        </div>
        <button
          id="cart-toggle"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: contrastColor,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "1rem",
            padding: "0.5rem",
            borderRadius: "6px",
          }}
          onClick={() => {
            const panel = document.getElementById("cart-panel");
            if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          <span id="cart-count" style={{ fontWeight: 600 }}>0</span>
        </button>
      </header>

      <main style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 1rem" }}>
        {products.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "#666" }}>
            <p style={{ fontSize: "1.125rem" }}>No products are currently available in this storefront.</p>
          </div>
        ) : (
          <div className="product-grid">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                accentColor={accentColor}
                contrastColor={contrastColor}
              />
            ))}
          </div>
        )}
      </main>

      <div
        id="cart-panel"
        style={{
          display: "none",
          position: "fixed",
          right: 0,
          top: 0,
          bottom: 0,
          width: "360px",
          background: "white",
          boxShadow: "-4px 0 20px rgba(0,0,0,0.15)",
          zIndex: 1000,
          overflow: "auto",
          padding: "1.5rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Your Cart</h2>
          <button
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.5rem" }}
            onClick={() => { document.getElementById("cart-panel").style.display = "none"; }}
          >
            ✕
          </button>
        </div>
        <div id="cart-items">
          <p style={{ color: "#666" }}>Your cart is empty.</p>
        </div>
        <div id="cart-footer" style={{ display: "none", borderTop: "1px solid #eee", paddingTop: "1rem", marginTop: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem", fontWeight: 600, fontSize: "1.125rem" }}>
            <span>Total</span>
            <span id="cart-total">$0.00</span>
          </div>
          <button
            id="checkout-btn"
            style={{
              width: "100%",
              padding: "0.875rem",
              background: accentColor,
              color: contrastColor,
              border: "none",
              borderRadius: "6px",
              fontSize: "1rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
            onClick={() => {
              const checkoutUrl = localStorage.getItem("psf_checkout_url");
              if (checkoutUrl) window.location.href = checkoutUrl;
            }}
          >
            Proceed to Checkout
          </button>
        </div>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: buildCartScript(shopDomain, storefrontToken, accentColor),
        }}
      />
    </div>
  );
}

function ProductCard({ product, accentColor, contrastColor }) {
  return (
    <div
      className="product-card"
      data-product-id={product.id}
      style={{
        background: "white",
        borderRadius: "8px",
        overflow: "hidden",
        boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
      }}
    >
      {product.image ? (
        <img
          src={product.image}
          alt={product.imageAlt}
          style={{ width: "100%", height: "220px", objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "220px",
            background: "#eee",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#999",
            fontSize: "0.875rem",
          }}
        >
          No image
        </div>
      )}
      <div style={{ padding: "1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem", fontWeight: 600 }}>{product.title}</h3>

        {product.variants.length > 1 ? (
          <select
            className="variant-select"
            data-product-id={product.id}
            style={{
              width: "100%",
              padding: "0.5rem",
              marginBottom: "0.75rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
              fontSize: "0.875rem",
            }}
          >
            {product.variants.map((variant) => (
              <option
                key={variant.id}
                value={variant.id}
                data-price={variant.price}
                data-currency={variant.currencyCode}
                data-available={variant.availableForSale}
                data-title={variant.title}
              >
                {variant.title} — {formatPrice(variant.price, variant.currencyCode)}
                {!variant.availableForSale ? " (Sold out)" : ""}
              </option>
            ))}
          </select>
        ) : (
          product.variants[0] && (
            <div
              data-variant-id={product.variants[0].id}
              data-price={product.variants[0].price}
              data-currency={product.variants[0].currencyCode}
              data-available={product.variants[0].availableForSale}
              style={{ marginBottom: "0.75rem" }}
            />
          )
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="product-price" style={{ fontWeight: 700, fontSize: "1.125rem" }}>
            {product.variants[0]
              ? formatPrice(product.variants[0].price, product.variants[0].currencyCode)
              : "—"}
          </span>
          <button
            className="add-to-cart-btn"
            data-product-id={product.id}
            data-variant-id={product.variants[0]?.id}
            data-variant-title={product.variants.length === 1 ? product.variants[0]?.title : ""}
            disabled={!product.variants[0]?.availableForSale}
            style={{
              padding: "0.625rem 1.25rem",
              background: product.variants[0]?.availableForSale ? accentColor : "#ccc",
              color: product.variants[0]?.availableForSale ? contrastColor : "#666",
              border: "none",
              borderRadius: "6px",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: product.variants[0]?.availableForSale ? "pointer" : "not-allowed",
            }}
          >
            {product.variants[0]?.availableForSale ? "Add to Cart" : "Sold Out"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(amount, currency = "USD") {
  const num = parseFloat(amount);
  if (isNaN(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(num);
}

function getContrastColor(hex) {
  try {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? "#000000" : "#ffffff";
  } catch {
    return "#ffffff";
  }
}

const globalStyles = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }
  .product-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1.5rem;
  }
  @media (max-width: 600px) {
    .product-grid { grid-template-columns: 1fr; }
  }
  .product-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); transition: box-shadow 0.2s; }
`;

function buildCartScript(shopDomain, storefrontToken, accentColor) {
  return `
(function() {
  const SHOP_DOMAIN = ${JSON.stringify(shopDomain)};
  const STOREFRONT_TOKEN = ${JSON.stringify(storefrontToken)};
  const API_URL = 'https://' + SHOP_DOMAIN + '/api/2025-01/graphql.json';
  let cartId = localStorage.getItem('psf_cart_id');
  let cartLines = JSON.parse(localStorage.getItem('psf_cart_lines') || '[]');

  async function gql(query, variables) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  }

  async function ensureCart() {
    if (cartId) return cartId;
    const { data } = await gql(\`mutation { cartCreate { cart { id checkoutUrl } } }\`);
    cartId = data?.cartCreate?.cart?.id;
    localStorage.setItem('psf_cart_id', cartId || '');
    localStorage.setItem('psf_checkout_url', data?.cartCreate?.cart?.checkoutUrl || '');
    return cartId;
  }

  function updateCartUI() {
    const total = cartLines.reduce((s, l) => s + l.price * l.qty, 0);
    const count = cartLines.reduce((s, l) => s + l.qty, 0);
    const countEl = document.getElementById('cart-count');
    const itemsEl = document.getElementById('cart-items');
    const footerEl = document.getElementById('cart-footer');
    const totalEl = document.getElementById('cart-total');
    if (countEl) countEl.textContent = count;
    if (itemsEl) {
      if (cartLines.length === 0) {
        itemsEl.innerHTML = '<p style="color:#666">Your cart is empty.</p>';
      } else {
        itemsEl.innerHTML = cartLines.map(l => \`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:0.75rem 0;border-bottom:1px solid #eee">
            <div>
              <div style="font-weight:600;font-size:0.9rem">\${l.title}</div>
              \${l.variantTitle ? '<div style="font-size:0.8rem;color:#666">' + l.variantTitle + '</div>' : ''}
              <div style="font-size:0.8rem;color:#666">Qty: \${l.qty}</div>
            </div>
            <div style="font-weight:600">\${new Intl.NumberFormat('en-US',{style:'currency',currency:l.currency||'USD'}).format(l.price * l.qty)}</div>
          </div>
        \`).join('');
      }
    }
    if (footerEl) footerEl.style.display = cartLines.length > 0 ? 'block' : 'none';
    if (totalEl) totalEl.textContent = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(total);
    localStorage.setItem('psf_cart_lines', JSON.stringify(cartLines));
  }

  async function addToCart(variantId, variantTitle, productTitle, price, currency) {
    const id = await ensureCart();
    if (!id) { alert('Could not create cart. Please try again.'); return; }
    const { data } = await gql(\`
      mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart { id checkoutUrl }
          userErrors { message }
        }
      }
    \`, { cartId: id, lines: [{ merchandiseId: variantId, quantity: 1 }] });

    if (data?.cartLinesAdd?.cart?.checkoutUrl) {
      localStorage.setItem('psf_checkout_url', data.cartLinesAdd.cart.checkoutUrl);
    }

    const existing = cartLines.find(l => l.id === variantId);
    if (existing) {
      existing.qty++;
    } else {
      cartLines.push({ id: variantId, title: productTitle, variantTitle, price: parseFloat(price), qty: 1, currency });
    }
    updateCartUI();

    const panel = document.getElementById('cart-panel');
    if (panel) panel.style.display = 'block';
  }

  function attachListeners() {
    document.querySelectorAll('.variant-select').forEach(select => {
      select.addEventListener('change', function() {
        const card = this.closest('.product-card');
        if (!card) return;
        const option = this.options[this.selectedIndex];
        const priceEl = card.querySelector('.product-price');
        const btn = card.querySelector('.add-to-cart-btn');
        const price = option.dataset.price;
        const currency = option.dataset.currency || 'USD';
        const available = option.dataset.available === 'true';
        if (priceEl) priceEl.textContent = new Intl.NumberFormat('en-US',{style:'currency',currency}).format(parseFloat(price));
        if (btn) {
          btn.dataset.variantId = option.value;
          btn.dataset.variantTitle = option.text.split(' — ')[0];
          btn.disabled = !available;
          btn.textContent = available ? 'Add to Cart' : 'Sold Out';
          btn.style.background = available ? ${JSON.stringify(accentColor)} : '#ccc';
          btn.style.cursor = available ? 'pointer' : 'not-allowed';
        }
      });
    });

    document.querySelectorAll('.add-to-cart-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const variantId = this.dataset.variantId;
        const variantTitle = this.dataset.variantTitle || '';
        const card = this.closest('.product-card');
        const titleEl = card?.querySelector('h3');
        const priceEl = card?.querySelector('.product-price');
        const productTitle = titleEl?.textContent || 'Product';
        const priceText = priceEl?.textContent || '0';
        const price = priceText.replace(/[^0-9.]/g, '');
        const currency = 'USD';
        if (variantId) addToCart(variantId, variantTitle, productTitle, price, currency);
      });
    });
  }

  updateCartUI();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachListeners);
  } else {
    attachListeners();
  }
})();
`;
}
