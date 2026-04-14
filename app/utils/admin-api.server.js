import prisma from "../db.server";

const ADMIN_API_VERSION = "2025-01";

async function getAccessToken(shopDomain) {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
  });
  if (!session?.accessToken) {
    throw new Error(`No offline session found for shop: ${shopDomain}`);
  }
  return session.accessToken;
}

export async function adminGraphQL(shopDomain, query, variables = {}) {
  const token = await getAccessToken(shopDomain);
  const res = await fetch(
    `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    throw new Error(`Admin API HTTP error: ${res.status}`);
  }

  return res.json();
}

/**
 * Create a Shopify draft order via the REST Admin API.
 * Using REST because the GraphQL API's originalUnitPrice is unreliable
 * for overriding variant catalog prices. The REST `price` field is explicit.
 *
 * lineItems: [
 *   { variantId, quantity }                          — variant item (no custom price)
 *   { title, originalUnitPrice, quantity, sku? }     — custom-priced item (no variantId)
 * ]
 * Returns { invoiceUrl, id } on success, { error } on failure.
 */
export async function createDraftOrder(shopDomain, { lineItems, email, note } = {}) {
  try {
    const token = await getAccessToken(shopDomain);

    const restLineItems = lineItems.map((item) => {
      if (item.variantId) {
        // Variant item — extract numeric ID from GID (gid://shopify/ProductVariant/12345678)
        const numericId = parseInt(item.variantId.split("/").pop(), 10);
        return { variant_id: numericId, quantity: item.quantity };
      }
      // Custom-priced item — REST `price` field is always used as-is by Shopify
      return {
        title: item.title || "Custom Item",
        price: item.originalUnitPrice,
        quantity: item.quantity,
        ...(item.sku ? { sku: item.sku } : {}),
        requires_shipping: item.requiresShipping !== false,
        taxable: item.taxable !== false,
      };
    });

    const payload = {
      draft_order: {
        line_items: restLineItems,
        ...(email ? { email } : {}),
        ...(note ? { note } : {}),
      },
    };

    const res = await fetch(
      `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/draft_orders.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("Draft order REST error:", res.status, errText);
      return { error: "Failed to create order. Please try again." };
    }

    const json = await res.json();
    const draftOrder = json?.draft_order;

    if (!draftOrder?.invoice_url) {
      console.error("No invoice_url in draft order response:", JSON.stringify(json));
      return { error: "Draft order created but no invoice URL returned" };
    }

    return { invoiceUrl: draftOrder.invoice_url, id: draftOrder.id };
  } catch (err) {
    console.error("createDraftOrder error:", err);
    return { error: "Failed to create order. Please try again." };
  }
}

/**
 * Fetch a specific metafield value for multiple product variants in one request.
 * metafieldKey: "namespace.key" (e.g., "custom.b2b_price")
 * Returns a Map of variantId -> price string (only variants where metafield has a valid number).
 */
export async function fetchVariantPricesFromMetafield(shopDomain, variantIds, metafieldKey) {
  if (!variantIds.length || !metafieldKey) return new Map();

  const dotIndex = metafieldKey.lastIndexOf(".");
  if (dotIndex === -1) {
    console.error("Invalid metafieldKey format (expected namespace.key):", metafieldKey);
    return new Map();
  }
  const namespace = metafieldKey.slice(0, dotIndex);
  const key = metafieldKey.slice(dotIndex + 1);

  // Build a single query with one alias per variant
  const aliases = variantIds
    .map((id, i) => `v${i}: productVariant(id: "${id}") { metafield(namespace: "${namespace}", key: "${key}") { value } }`)
    .join("\n");

  try {
    const { data } = await adminGraphQL(shopDomain, `query { ${aliases} }`);
    const prices = new Map();
    variantIds.forEach((id, i) => {
      const val = data?.[`v${i}`]?.metafield?.value;
      if (val == null) return;

      // Shopify money metafields are JSON: {"amount":"500.00","currency_code":"USD"}
      let amount;
      try {
        const parsed = JSON.parse(val);
        amount = parsed?.amount ?? parsed;
      } catch {
        amount = val;
      }

      const num = parseFloat(amount);
      if (!isNaN(num)) {
        prices.set(id, num.toFixed(2));
      }
    });
    return prices;
  } catch (err) {
    console.error("fetchVariantPricesFromMetafield error:", err);
    return new Map();
  }
}
