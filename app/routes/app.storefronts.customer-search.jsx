import { authenticate } from "../shopify.server";

/**
 * Resource route — searches Shopify customers for the storefront customer-linking picker.
 * Query params:
 *   q - search string (name or email)
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (!q) {
    return new Response(JSON.stringify({ customers: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await admin.graphql(
    `#graphql
      query SearchCustomers($query: String!) {
        customers(first: 10, query: $query) {
          edges {
            node {
              id
              firstName
              lastName
              email
              defaultAddress {
                company
              }
            }
          }
        }
      }
    `,
    { variables: { query: q } },
  );

  const json = await response.json();

  if (json.errors) {
    return new Response(JSON.stringify({ customers: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const customers = (json.data?.customers?.edges || []).map((e) => ({
    id: e.node.id,
    name: [e.node.firstName, e.node.lastName].filter(Boolean).join(" "),
    email: e.node.email || "",
    company: e.node.defaultAddress?.company || "",
  }));

  return new Response(JSON.stringify({ customers }), {
    headers: { "Content-Type": "application/json" },
  });
};
