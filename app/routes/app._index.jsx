import { useEffect, useState } from "react";
import { Form, redirect, useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const storefronts = await prisma.storefront.findMany({
    where: { shopDomain: shop },
    include: {
      _count: { select: { products: true, customers: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const totalProducts = storefronts.reduce(
    (sum, s) => sum + s._count.products,
    0,
  );
  const totalCustomers = storefronts.reduce(
    (sum, s) => sum + s._count.customers,
    0,
  );
  const activeCount = storefronts.filter((s) => s.isActive).length;
  const appUrl = process.env.SHOPIFY_APP_URL || "";

  return {
    storefronts: storefronts.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    totalProducts,
    totalCustomers,
    activeCount,
    appUrl,
    shop,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const id = formData.get("id");

  if (intent === "delete") {
    await prisma.storefront.deleteMany({
      where: { id, shopDomain: session.shop },
    });
    return redirect("/app?flash=deleted");
  }

  if (intent === "toggle") {
    const storefront = await prisma.storefront.findFirst({
      where: { id, shopDomain: session.shop },
    });
    if (storefront) {
      await prisma.storefront.update({
        where: { id },
        data: { isActive: !storefront.isActive },
      });
    }
    return {
      success: true,
      message: storefront?.isActive ? "Storefront deactivated" : "Storefront activated",
    };
  }

  return { error: "Unknown action" };
};

export default function Index() {
  const { storefronts, totalProducts, totalCustomers, activeCount, shop } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [deleteConfirm, setDeleteConfirm] = useState(null); // { id, name }
  const [searchParams, setSearchParams] = useSearchParams();

  const isLoading = fetcher.state !== "idle";

  // Toast for delete (comes back via redirect ?flash=deleted)
  useEffect(() => {
    if (searchParams.get("flash") === "deleted") {
      shopify.toast.show("Storefront deleted");
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, shopify, setSearchParams]);

  // Toast for toggle
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  function handleToggle(sf) {
    fetcher.submit(
      { intent: "toggle", id: sf.id },
      { method: "post" },
    );
  }

  function getProxyUrl(slug) {
    return `https://${shop}/apps/storefronts/${slug}`;
  }

  return (
    <>
      {/* Buttons/modals OUTSIDE s-page so shadow DOM cannot swallow clicks */}
      <div style={{ padding: "16px 20px 0", display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => navigate("/app/storefronts/new")}
          style={{
            background: "#303030",
            color: "#fff",
            border: "none",
            borderRadius: "8px",
            padding: "12px 24px",
            fontSize: "14px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Create New Storefront
        </button>
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "12px",
              padding: "32px",
              maxWidth: "420px",
              width: "90%",
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: "18px" }}>Delete Storefront</h3>
            <p style={{ margin: "0 0 24px", color: "#555", fontSize: "14px" }}>
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>? This
              will permanently remove all its products and customer access. This cannot be
              undone.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="id" value={deleteConfirm.id} />
              <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(null)}
                  style={{
                    padding: "10px 20px",
                    border: "1px solid #ddd",
                    borderRadius: "6px",
                    background: "#fff",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: "10px 20px",
                    border: "none",
                    borderRadius: "6px",
                    background: "#d72c0d",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: "14px",
                    fontWeight: 600,
                  }}
                >
                  Delete
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      <s-page heading="Private Storefronts">

        {/* Stats row */}
        <s-section heading="Overview">
          <s-stack direction="inline" gap="large">
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text>Active Storefronts</s-text>
                <s-heading>{activeCount}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text>Products Configured</s-text>
                <s-heading>{totalProducts}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-200">
                <s-text>Total Customers</s-text>
                <s-heading>{totalCustomers}</s-heading>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>

        {/* Storefronts table */}
        <s-section heading="Your Storefronts">
          {storefronts.length === 0 ? (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                No private storefronts yet. Create your first one to give B2B
                clients a dedicated shopping experience.
              </s-paragraph>
              <s-text>Use the button above to create your first storefront.</s-text>
            </s-stack>
          ) : (
            <s-table>
              <s-table-header>
                <s-table-header-row>
                  <s-table-cell>Name</s-table-cell>
                  <s-table-cell>Company</s-table-cell>
                  <s-table-cell>Slug / URL</s-table-cell>
                  <s-table-cell>Status</s-table-cell>
                  <s-table-cell>Products</s-table-cell>
                  <s-table-cell>Customers</s-table-cell>
                  <s-table-cell>Actions</s-table-cell>
                </s-table-header-row>
              </s-table-header>
              <s-table-body>
                {storefronts.map((sf) => (
                  <s-table-row key={sf.id}>
                    <s-table-cell>
                      <s-text>{sf.name}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{sf.companyName}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-400">
                        <s-text>{sf.slug}</s-text>
                        <s-text style={{ fontSize: "12px", color: "#666" }}>
                          {getProxyUrl(sf.slug)}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={sf.isActive ? "success" : "neutral"}>
                        {sf.isActive ? "Active" : "Inactive"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{sf._count.products}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{sf._count.customers}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button
                          onClick={() => navigate(`/app/storefronts/${sf.id}/edit`)}
                          disabled={isLoading}
                          style={{
                            padding: "6px 14px",
                            border: "1px solid #8c9196",
                            borderRadius: "6px",
                            background: "#fff",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleToggle(sf)}
                          disabled={isLoading}
                          style={{
                            padding: "6px 14px",
                            border: "1px solid #8c9196",
                            borderRadius: "6px",
                            background: "#fff",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                          }}
                        >
                          {sf.isActive ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          onClick={() => setDeleteConfirm({ id: sf.id, name: sf.name })}
                          disabled={isLoading}
                          style={{
                            padding: "6px 14px",
                            border: "1px solid #d72c0d",
                            borderRadius: "6px",
                            background: "#fff",
                            color: "#d72c0d",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-page>
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
