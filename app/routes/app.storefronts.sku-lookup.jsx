import { authenticate } from "../shopify.server";

/**
 * POST /app/storefronts/sku-lookup
 * Body: { skus: string[] }
 * Returns: { variants: VariantMatch[], notFound: string[] }
 *
 * Looks up Shopify product variants by SKU using the Admin API.
 * Batches in groups of 50 to avoid hitting query-length limits.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rawSkus = (body.skus || [])
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (!rawSkus.length) {
    return Response.json({ variants: [], notFound: [] });
  }

  // Deduplicate while preserving order
  const skus = [...new Set(rawSkus)];

  const found = [];
  const matchedSkus = new Set();

  // Batch in groups of 50 to stay under query string limits
  for (let i = 0; i < skus.length; i += 50) {
    const batch = skus.slice(i, i + 50);
    // Use quoted exact-match syntax for each SKU
    const queryStr = batch.map((s) => `sku:"${s.replace(/"/g, "")}"`).join(" OR ");

    const res = await admin.graphql(
      `#graphql
        query LookupBySku($q: String!) {
          productVariants(first: 250, query: $q) {
            edges {
              node {
                id
                sku
                title
                price
                availableForSale
                metafield(namespace: "custom", key: "private_storefront_price") {
                  value
                }
                product {
                  id
                  title
                  status
                  featuredImage { url altText }
                }
              }
            }
          }
        }
      `,
      { variables: { q: queryStr } },
    );

    const data = await res.json();
    const edges = data?.data?.productVariants?.edges || [];

    for (const { node } of edges) {
      // Skip archived/draft products
      if (node.product.status !== "ACTIVE") continue;
      matchedSkus.add(node.sku);
      const rawMetafield = node.metafield?.value ?? null;
      let storefrontPrice = null;
      if (rawMetafield) {
        try {
          const p = JSON.parse(rawMetafield);
          storefrontPrice = p?.amount ?? rawMetafield;
        } catch {
          storefrontPrice = rawMetafield;
        }
      }
      found.push({
        variantId: node.id,
        sku: node.sku,
        variantTitle: node.title === "Default Title" ? "" : node.title,
        variantSku: node.sku,
        price: node.price,
        availableForSale: node.availableForSale,
        productId: node.product.id,
        productTitle: node.product.title,
        productImage: node.product.featuredImage?.url || null,
        storefrontPrice,
      });
    }
  }

  const notFound = skus.filter((s) => !matchedSkus.has(s));

  return Response.json({ variants: found, notFound });
};
