import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
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
    return { success: true, message: "Storefront deleted" };
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
  const { storefronts, totalProducts, totalCustomers, activeCount, appUrl, shop } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const deleteModalRef = useRef(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const isLoading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  function handleDeleteClick(storefront) {
    setPendingDelete(storefront);
    deleteModalRef.current?.showOverlay();
  }

  function handleDeleteConfirm() {
    if (!pendingDelete) return;
    fetcher.submit({ intent: "delete", id: pendingDelete.id }, { method: "post" });
    deleteModalRef.current?.hideOverlay();
    setPendingDelete(null);
  }

  function handleToggle(storefront) {
    fetcher.submit({ intent: "toggle", id: storefront.id }, { method: "post" });
  }

  function getDirectUrl(slug) {
    return `${appUrl.replace(/\/$/, "")}/s/${slug}`;
  }

  function getProxyUrl(slug) {
    return `https://${shop}/apps/storefronts/${slug}`;
  }

  function copyUrl(slug) {
    navigator.clipboard.writeText(getProxyUrl(slug)).then(() => {
      shopify.toast.show("Storefront URL copied to clipboard");
    });
  }

  return (
    <>
      <s-page heading="Private Storefronts">
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => navigate("/app/storefronts/new")}
        >
          Create New Storefront
        </s-button>

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
              <s-button
                variant="primary"
                onClick={() => navigate("/app/storefronts/new")}
              >
                Create Your First Storefront
              </s-button>
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
                        <s-button onClick={() => copyUrl(sf.slug)}>
                          Copy Proxy URL
                        </s-button>
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
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <s-button
                          variant="primary"
                          onClick={() => window.open(getProxyUrl(sf.slug), "_blank")}
                          disabled={isLoading}
                        >
                          Preview
                        </s-button>
                        <s-button
                          onClick={() => navigate(`/app/storefronts/${sf.id}/edit`)}
                          disabled={isLoading}
                        >
                          Edit
                        </s-button>
                        <s-button
                          onClick={() => navigate(`/app/storefronts/${sf.id}/customers`)}
                          disabled={isLoading}
                        >
                          Customers
                        </s-button>
                        <s-button
                          onClick={() => handleToggle(sf)}
                          disabled={isLoading}
                        >
                          {sf.isActive ? "Deactivate" : "Activate"}
                        </s-button>
                        <s-button
                          tone="critical"
                          onClick={() => handleDeleteClick(sf)}
                          disabled={isLoading}
                        >
                          Delete
                        </s-button>
                      </div>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-page>

      {/* Delete confirmation modal */}
      <s-modal
        ref={deleteModalRef}
        heading="Delete Storefront"
        onHide={() => setPendingDelete(null)}
      >
        <s-paragraph>
          Are you sure you want to delete{" "}
          <strong>{pendingDelete?.name}</strong>? This will permanently remove
          the storefront, all configured products, and all customer accounts.
          This action cannot be undone.
        </s-paragraph>
        <s-button-group slot="primary-action">
          <s-button
            tone="critical"
            variant="primary"
            onClick={handleDeleteConfirm}
          >
            Delete Storefront
          </s-button>
          <s-button onClick={() => deleteModalRef.current?.hideOverlay()}>
            Cancel
          </s-button>
        </s-button-group>
      </s-modal>
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
