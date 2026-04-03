import { authenticate } from "../shopify.server";

/**
 * Resource route — searches Shopify companies for the storefront company-linking picker.
 * Query params:
 *   q - search string (company name)
 */
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (!q) {
    return new Response(JSON.stringify({ companies: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await admin.graphql(
    `#graphql
      query SearchCompanies($query: String!) {
        companies(first: 10, query: $query) {
          edges {
            node {
              id
              name
              mainContact {
                id
                customer {
                  id
                  firstName
                  lastName
                  email
                }
              }
              locations(first: 1) {
                edges {
                  node {
                    id
                    name
                  }
                }
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
    return new Response(JSON.stringify({ companies: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const companies = (json.data?.companies?.edges || []).map((e) => {
    const node = e.node;
    const location = node.locations?.edges?.[0]?.node;
    const contact = node.mainContact;
    const customer = contact?.customer;
    return {
      id: node.id,
      name: node.name,
      locationId: location?.id || null,
      locationName: location?.name || null,
      contactId: contact?.id || null,
      contactName: customer
        ? [customer.firstName, customer.lastName].filter(Boolean).join(" ")
        : null,
      contactEmail: customer?.email || null,
    };
  });

  return new Response(JSON.stringify({ companies }), {
    headers: { "Content-Type": "application/json" },
  });
};
