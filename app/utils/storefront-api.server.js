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
 * Create a Shopify cart with line items via the Storefront API.
 * lines: [{ merchandiseId, quantity }]
 * Returns { id, checkoutUrl } or null on failure.
 */
export async function createCartWithLines(shopDomain, lines) {
  try {
    const client = getClient(shopDomain);
    const { data, errors } = await client.request(
      `
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
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
    `,
      { variables: { input: { lines } } },
    );

    if (errors || data?.cartCreate?.userErrors?.length > 0) {
      console.error(
        "Cart create with lines errors:",
        errors || data?.cartCreate?.userErrors,
      );
      return null;
    }

    return data?.cartCreate?.cart || null;
  } catch (err) {
    console.error("createCartWithLines error:", err);
    return null;
  }
}

/**
 * Authenticate a customer against Shopify's customer accounts via the Storefront API.
 * Returns { email, customerId } on success, or { error: string } on failure.
 */
export async function authenticateCustomer(shopDomain, email, password) {
  try {
    const client = getClient(shopDomain);
    const { data, errors } = await client.request(
      `
      mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
        customerAccessTokenCreate(input: $input) {
          customerAccessToken {
            accessToken
          }
          customerUserErrors {
            code
            message
          }
        }
      }
    `,
      { variables: { input: { email, password } } },
    );

    if (errors) {
      return { error: "Authentication error. Please try again." };
    }

    const userErrors = data?.customerAccessTokenCreate?.customerUserErrors;
    if (userErrors?.length > 0) {
      const code = userErrors[0].code;
      if (code === "UNIDENTIFIED_CUSTOMER") {
        return { error: "Invalid email or password." };
      }
      return { error: userErrors[0].message };
    }

    const token = data?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
    if (!token) return { error: "Authentication failed. Please try again." };

    // Fetch the customer's ID using the access token
    const { data: customerData } = await client.request(
      `
      query getCustomer($token: String!) {
        customer(customerAccessToken: $token) {
          id
          email
        }
      }
    `,
      { variables: { token } },
    );

    const customer = customerData?.customer;
    if (!customer) return { error: "Could not retrieve account details." };

    return { customerId: customer.id, email: customer.email };
  } catch (err) {
    console.error("authenticateCustomer error:", err);
    return { error: "Authentication error. Please try again." };
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
