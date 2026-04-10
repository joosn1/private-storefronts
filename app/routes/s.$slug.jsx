import { useEffect, useState } from "react";
import { redirect, useFetcher, useLoaderData, useOutlet } from "react-router";
import prisma from "../db.server";
import {
  getSessionCookie,
  passwordCookieName,
  customerCookieName,
} from "../utils/session.server";
import { createDraftOrder } from "../utils/admin-api.server";
import { createCartWithLines } from "../utils/storefront-api.server";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function groupProducts(variants) {
  const map = new Map();
  for (const v of variants) {
    if (!map.has(v.shopifyProductId)) {
      map.set(v.shopifyProductId, {
        productId: v.shopifyProductId,
        title: v.productTitle,
        image: v.productImage,
        variants: [],
      });
    }
    map.get(v.shopifyProductId).variants.push({
      variantId: v.shopifyVariantId,
      title: v.variantTitle,
      price: v.customPrice != null ? v.customPrice.toString() : v.basePrice,
      availableForSale: v.availableForSale,
    });
  }
  return Array.from(map.values());
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { slug } = params;
  const url = new URL(request.url);
  const isIndex =
    url.pathname === `/s/${slug}` || url.pathname === `/s/${slug}/`;

  const storefront = await prisma.storefront.findUnique({
    where: { slug },
    ...(isIndex
      ? {
          include: {
            products: {
              where: { isVisible: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        }
      : {}),
  });

  if (!storefront || !storefront.isActive) {
    throw new Response("Not Found", { status: 404 });
  }

  // Only enforce auth on the index (product listing) page
  if (isIndex) {
    if (storefront.requireLogin) {
      const customerId = getSessionCookie(request, customerCookieName(slug));
      if (!customerId) return redirect(`/s/${slug}/login`);
    } else if (storefront.password) {
      const verified = getSessionCookie(request, passwordCookieName(slug));
      if (verified !== "verified") return redirect(`/s/${slug}/auth`);
    }
  }

  return {
    storefront: {
      name: storefront.name,
      companyName: storefront.companyName,
      logoUrl: storefront.logoUrl,
      primaryColor: storefront.primaryColor || "#000000",
      shopDomain: storefront.shopDomain,
      slug,
    },
    products: isIndex ? groupProducts(storefront.products) : [],
    isIndex,
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { slug } = params;

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "Invalid request" };
  }

  if (body._action !== "checkout") return { error: "Unknown action" };

  const { items } = body; // [{ variantId, quantity }]
  if (!items?.length) return { error: "Cart is empty" };

  const storefront = await prisma.storefront.findUnique({
    where: { slug },
    include: { products: true },
  });

  if (!storefront) return { error: "Storefront not found" };

  const variantMap = new Map(
    storefront.products.map((p) => [p.shopifyVariantId, p]),
  );

  // If any item has a custom price, the entire order must be a draft order
  const hasCustomPrice = items.some((item) => {
    const p = variantMap.get(item.variantId);
    return p?.customPrice != null;
  });

  if (hasCustomPrice) {
    const lineItems = items.map((item) => {
      const p = variantMap.get(item.variantId);
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        ...(p?.customPrice != null
          ? { originalUnitPrice: p.customPrice.toString() }
          : {}),
      };
    });

    const result = await createDraftOrder(storefront.shopDomain, { lineItems });
    if (result.error) return { error: result.error };
    return { checkoutUrl: result.invoiceUrl };
  } else {
    const lines = items.map((item) => ({
      merchandiseId: item.variantId,
      quantity: item.quantity,
    }));

    const cart = await createCartWithLines(storefront.shopDomain, lines);
    if (!cart) return { error: "Failed to create checkout. Please try again." };
    return { checkoutUrl: cart.checkoutUrl };
  }
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function StorefrontLayout() {
  const { storefront, products } = useLoaderData();
  const outlet = useOutlet();
  const fetcher = useFetcher();

  const [cart, setCart] = useState({}); // { variantId: quantity }
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);

  const primaryColor = storefront.primaryColor;
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  // Handle fetcher response (checkout result)
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.checkoutUrl) {
      window.location.href = fetcher.data.checkoutUrl;
    } else if (fetcher.data.error) {
      setCheckoutError(fetcher.data.error);
    }
  }, [fetcher.data]);

  function addToCart(variantId) {
    setCart((prev) => ({ ...prev, [variantId]: (prev[variantId] || 0) + 1 }));
  }

  function removeFromCart(variantId) {
    setCart((prev) => {
      const next = { ...prev };
      if (next[variantId] > 1) next[variantId] -= 1;
      else delete next[variantId];
      return next;
    });
  }

  function handleCheckout() {
    const items = Object.entries(cart).map(([variantId, quantity]) => ({
      variantId,
      quantity,
    }));
    if (!items.length) return;
    setCheckoutError(null);
    fetcher.submit(
      { _action: "checkout", items },
      { method: "post", encType: "application/json" },
    );
  }

  const headerBase = {
    background: primaryColor,
    color: "#fff",
    padding: "14px 24px",
  };

  // ─── Layout wrapper for child routes (auth / login) ───────────────────────
  if (outlet) {
    return (
      <div style={{ minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
        <header style={{ ...headerBase, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          {storefront.logoUrl ? (
            <img
              src={storefront.logoUrl}
              alt={storefront.companyName}
              style={{ height: 48, maxWidth: 200, objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontWeight: 700, fontSize: 20 }}>
              {storefront.companyName}
            </span>
          )}
          <span style={{ fontSize: 12, opacity: 0.8 }}>{storefront.name}</span>
        </header>
        <main>{outlet}</main>
      </div>
    );
  }

  // ─── Build variant lookup for cart display ────────────────────────────────
  const allVariants = products.flatMap((p) =>
    p.variants.map((v) => ({
      ...v,
      productTitle: p.title,
      productImage: p.image,
    })),
  );
  const variantLookup = new Map(allVariants.map((v) => [v.variantId, v]));

  const cartItems = Object.entries(cart)
    .map(([variantId, quantity]) => ({
      variantId,
      quantity,
      ...(variantLookup.get(variantId) || {}),
    }))
    .filter((item) => item.productTitle);

  const cartTotal = cartItems.reduce(
    (sum, item) => sum + parseFloat(item.price || 0) * item.quantity,
    0,
  );

  const isCheckingOut = fetcher.state !== "idle";

  // ─── Product page ─────────────────────────────────────────────────────────
  return (
    <div
      style={{
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        background: "#f5f5f5",
      }}
    >
      <style>{`
        .psf-card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); transition: box-shadow .2s; }
        .psf-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,.15); }
        .psf-btn { border: none; border-radius: 6px; padding: 10px 20px; cursor: pointer; font-size: 14px; font-weight: 600; transition: opacity .15s; }
        .psf-btn:hover:not(:disabled) { opacity: .85; }
        .psf-btn:disabled { opacity: .5; cursor: not-allowed; }
        .psf-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 100; }
        .psf-cart { position: fixed; right: 0; top: 0; bottom: 0; width: 380px; max-width: 100vw; background: #fff; z-index: 101; display: flex; flex-direction: column; box-shadow: -4px 0 24px rgba(0,0,0,.2); }
        @media (max-width: 600px) { .psf-cart { width: 100vw; } .psf-grid { grid-template-columns: 1fr !important; } }
      `}</style>

      {/* Header — three-column grid so logo stays perfectly centered */}
      <header
        style={{
          ...headerBase,
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 12,
        }}
      >
        {/* Left spacer — mirrors cart button column so center stays true */}
        <div />

        {/* Centered logo / company name */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {storefront.logoUrl ? (
            <img
              src={storefront.logoUrl}
              alt={storefront.companyName}
              style={{ height: 48, maxWidth: 200, objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontWeight: 700, fontSize: 20 }}>
              {storefront.companyName}
            </span>
          )}
          <span style={{ fontSize: 12, opacity: 0.8 }}>{storefront.name}</span>
        </div>

        {/* Cart button — right-aligned */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            className="psf-btn"
            onClick={() => setCartOpen(true)}
            style={{ background: "rgba(255,255,255,0.2)", color: "#fff" }}
          >
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </button>
        </div>
      </header>

      {/* Product grid */}
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 16px" }}>
        {products.length === 0 ? (
          <p style={{ textAlign: "center", color: "#666", marginTop: 64 }}>
            No products available.
          </p>
        ) : (
          <div
            className="psf-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 24,
            }}
          >
            {products.map((product) => (
              <ProductCard
                key={product.productId}
                product={product}
                primaryColor={primaryColor}
                onAddToCart={addToCart}
              />
            ))}
          </div>
        )}
      </main>

      {/* Cart sidebar */}
      {cartOpen && (
        <>
          <div
            className="psf-overlay"
            onClick={() => setCartOpen(false)}
          />
          <div className="psf-cart">
            <div
              style={{
                padding: "20px 24px",
                borderBottom: "1px solid #eee",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18 }}>Your Cart</h2>
              <button
                onClick={() => setCartOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: 24,
                  cursor: "pointer",
                  color: "#666",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            <div
              style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}
            >
              {cartItems.length === 0 ? (
                <p
                  style={{
                    color: "#888",
                    textAlign: "center",
                    marginTop: 32,
                  }}
                >
                  Your cart is empty.
                </p>
              ) : (
                cartItems.map((item) => (
                  <div
                    key={item.variantId}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      marginBottom: 16,
                      paddingBottom: 16,
                      borderBottom: "1px solid #f0f0f0",
                    }}
                  >
                    {item.productImage && (
                      <img
                        src={item.productImage}
                        alt={item.productTitle}
                        style={{
                          width: 56,
                          height: 56,
                          objectFit: "cover",
                          borderRadius: 4,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.productTitle}
                      </div>
                      {item.title && item.title !== "Default Title" && (
                        <div style={{ color: "#666", fontSize: 13 }}>
                          {item.title}
                        </div>
                      )}
                      <div style={{ color: "#333", fontSize: 14, marginTop: 4 }}>
                        ${parseFloat(item.price || 0).toFixed(2)}
                      </div>
                    </div>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <button
                        onClick={() => removeFromCart(item.variantId)}
                        style={{
                          width: 28,
                          height: 28,
                          border: "1px solid #ddd",
                          borderRadius: 4,
                          background: "#fff",
                          cursor: "pointer",
                          fontSize: 16,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        −
                      </button>
                      <span style={{ minWidth: 20, textAlign: "center" }}>
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => addToCart(item.variantId)}
                        style={{
                          width: 28,
                          height: 28,
                          border: "1px solid #ddd",
                          borderRadius: 4,
                          background: "#fff",
                          cursor: "pointer",
                          fontSize: 16,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div
              style={{ padding: "20px 24px", borderTop: "1px solid #eee" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 16,
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                <span>Total</span>
                <span>${cartTotal.toFixed(2)}</span>
              </div>
              {checkoutError && (
                <div
                  style={{
                    background: "#fee",
                    color: "#c00",
                    padding: "10px 14px",
                    borderRadius: 6,
                    marginBottom: 12,
                    fontSize: 14,
                  }}
                >
                  {checkoutError}
                </div>
              )}
              <button
                className="psf-btn"
                onClick={handleCheckout}
                disabled={cartItems.length === 0 || isCheckingOut}
                style={{
                  background: primaryColor,
                  color: "#fff",
                  width: "100%",
                  padding: "14px 20px",
                  fontSize: 16,
                }}
              >
                {isCheckingOut ? "Processing..." : "Checkout"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Product Card ─────────────────────────────────────────────────────────────

function ProductCard({ product, primaryColor, onAddToCart }) {
  const firstAvailable =
    product.variants.find((v) => v.availableForSale) || product.variants[0];

  const [selectedVariantId, setSelectedVariantId] = useState(
    firstAvailable?.variantId,
  );

  const selected = product.variants.find(
    (v) => v.variantId === selectedVariantId,
  );
  const hasMultipleVariants = product.variants.length > 1;

  return (
    <div className="psf-card">
      {product.image && (
        <img
          src={product.image}
          alt={product.title}
          style={{ width: "100%", height: 200, objectFit: "cover" }}
        />
      )}
      <div style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600 }}>
          {product.title}
        </h3>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: "#111",
            marginBottom: 12,
          }}
        >
          ${parseFloat(selected?.price || 0).toFixed(2)}
        </div>

        {hasMultipleVariants && (
          <select
            value={selectedVariantId}
            onChange={(e) => setSelectedVariantId(e.target.value)}
            style={{
              width: "100%",
              marginBottom: 12,
              padding: "8px 10px",
              border: "1px solid #ddd",
              borderRadius: 6,
              fontSize: 14,
            }}
          >
            {product.variants.map((v) => (
              <option
                key={v.variantId}
                value={v.variantId}
                disabled={!v.availableForSale}
              >
                {v.title !== "Default Title" ? v.title : ""}
                {!v.availableForSale ? " — Sold out" : ""} — $
                {parseFloat(v.price).toFixed(2)}
              </option>
            ))}
          </select>
        )}

        <button
          className="psf-btn"
          onClick={() => selectedVariantId && onAddToCart(selectedVariantId)}
          disabled={!selected?.availableForSale}
          style={{ background: primaryColor, color: "#fff", width: "100%" }}
        >
          {selected?.availableForSale ? "Add to Cart" : "Sold Out"}
        </button>
      </div>
    </div>
  );
}
