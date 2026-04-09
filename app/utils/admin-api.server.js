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

async function adminGraphQL(shopDomain, query, variables = {}) {
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

const DRAFT_ORDER_CREATE_MUTATION = `
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Create a Shopify draft order with custom line item prices.
 * lineItems: [{ variantId, quantity, originalUnitPrice? }]
 * Returns { invoiceUrl, id } on success, { error } on failure.
 */
export async function createDraftOrder(shopDomain, { lineItems, email, note } = {}) {
  try {
    const { data, errors } = await adminGraphQL(
      shopDomain,
      DRAFT_ORDER_CREATE_MUTATION,
      {
        input: {
          lineItems,
          ...(email ? { email } : {}),
          ...(note ? { note } : {}),
        },
      },
    );

    if (errors?.length) {
      console.error("Draft order GraphQL errors:", errors);
      return { error: errors[0].message };
    }

    const userErrors = data?.draftOrderCreate?.userErrors;
    if (userErrors?.length) {
      console.error("Draft order user errors:", userErrors);
      return { error: userErrors[0].message };
    }

    const draftOrder = data?.draftOrderCreate?.draftOrder;
    if (!draftOrder?.invoiceUrl) {
      return { error: "Draft order created but no invoice URL returned" };
    }

    return { invoiceUrl: draftOrder.invoiceUrl, id: draftOrder.id };
  } catch (err) {
    console.error("createDraftOrder error:", err);
    return { error: "Failed to create order. Please try again." };
  }
}
