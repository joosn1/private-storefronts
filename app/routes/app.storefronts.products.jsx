import { authenticate } from "../shopify.server";

/**
 * Resource route — returns JSON list of products from Shopify Admin API.
 * Used by the new/edit storefront multi-step form to load products with
 * cursor-based pagination and optional search query.
 *
 * Query params:
 *   first  - number of products per page (default 50, max 250)
 *   after  - pagination cursor
 *   query  - search query string
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const first = Math.min(parseInt(url.searchParams.get("first") || "50", 10), 250);
  const after = url.searchParams.get("after") || null;
  const query = url.searchParams.get("query") || "";

  const response = await admin.graphql(
    `#graphql
      query GetProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              status
              featuredImage {
                url
                altText
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    availableForSale
                    metafield(namespace: "custom", key: "private_storefront_price") {
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { first, after: after || null, query: query || null } },
  );

  const json = await response.json();

  if (json.errors) {
    return new Response(JSON.stringify({ error: "GraphQL error", details: json.errors }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const products = json.data.products.edges.map((e) => ({
    id: e.node.id,
    title: e.node.title,
    status: e.node.status,
    image: e.node.featuredImage?.url || null,
    imageAlt: e.node.featuredImage?.altText || e.node.title,
    variants: e.node.variants.edges.map((ve) => ({
      id: ve.node.id,
      title: ve.node.title,
      sku: ve.node.sku || "",
      price: ve.node.price,
      availableForSale: ve.node.availableForSale,
      storefrontPrice: ve.node.metafield?.value
        ? (() => { try { const p = JSON.parse(ve.node.metafield.value); return p?.amount ?? ve.node.metafield.value; } catch { return ve.node.metafield.value; } })()
        : null,
    })),
  }));

  return new Response(
    JSON.stringify({
      products,
      pageInfo: json.data.products.pageInfo,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
