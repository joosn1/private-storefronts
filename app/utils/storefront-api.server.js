import { createStorefrontApiClient } from "@shopify/storefront-api-client";

const STOREFRONT_API_VERSION = "2025-01";

function getClient(shopDomain) {
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_STOREFRONT_TOKEN environment variable is not set");
  }
  return createStorefrontApiClient({
    storeDomain: shopDomain,
    apiVersion: STOREFRONT_API_VERSION,
    publicAccessToken: token,
  });
}

const PRODUCTS_BY_IDS_QUERY = `
  query GetProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        description
        featuredImage {
          url
          altText
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              price {
                amount
                currencyCode
              }
              availableForSale
              image {
                url
                altText
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch product data from Shopify Storefront API by an array of product GIDs.
 * Returns an array of product objects. Missing/deleted products are gracefully skipped.
 */
export async function fetchProductsByIds(shopDomain, productIds) {
  if (!productIds || productIds.length === 0) return [];

  try {
    const client = getClient(shopDomain);
    const { data, errors } = await client.request(PRODUCTS_BY_IDS_QUERY, {
      variables: { ids: productIds },
    });

    if (errors) {
      console.error("Storefront API errors:", JSON.stringify(errors));
      return [];
    }

    // Filter out null nodes (products that were deleted from Shopify)
    return (data?.nodes || []).filter(
      (node) => node !== null && node !== undefined && node.id,
    );
  } catch (err) {
    console.error("Storefront API fetch error:", err);
    return [];
  }
}

/**
 * Create a new Shopify cart via the Storefront API.
 * Returns { id, checkoutUrl } or null on failure.
 */
export async function createCart(shopDomain) {
  try {
    const client = getClient(shopDomain);
    const { data, errors } = await client.request(`
      mutation cartCreate {
        cartCreate {
          cart {
            id
            checkoutUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `);

    if (errors || data?.cartCreate?.userErrors?.length > 0) {
      console.error("Cart create errors:", errors || data?.cartCreate?.userErrors);
      return null;
    }

    return data?.cartCreate?.cart || null;
  } catch (err) {
    console.error("Cart create error:", err);
    return null;
  }
}
