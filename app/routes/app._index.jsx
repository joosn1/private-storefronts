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

  return {
    storefronts: storefronts.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    totalProducts,
    totalCustomers,
    activeCount,
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const btn = {
  base: {
    padding: "6px 14px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #ccc",
    background: "#fff",
    color: "#202020",
    lineHeight: "1.4",
  },
  primary: {
    padding: "8px 16px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    background: "#303030",
    color: "#fff",
    lineHeight: "1.4",
  },
  danger: {
    padding: "6px 14px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    background: "#d82c0d",
    color: "#fff",
    lineHeight: "1.4",
  },
};

const thStyle = {
  padding: "10px 12px",
  textAlign: "left",
  fontWeight: 600,
  fontSize: "12px",
  color: "#6d7175",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
  borderBottom: "2px solid #e1e3e5",
};

const tdStyle = {
  padding: "12px",
  verticalAlign: "middle",
  fontSize: "13px",
  color: "#202020",
  borderBottom: "1px solid #e1e3e5",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Index() {
  const { storefronts, totalProducts, totalCustomers, activeCount, shop } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const deleteModalRef = useRef(null);
  const createBtnRef = useRef(null);
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

  // s-button renders correctly in the slot but its onClick is unreliable —
  // attach a native listener directly to the element instead.
  useEffect(() => {
    const el = createBtnRef.current;
    if (!el) return;
    const handler = () => navigate("/app/storefronts/new");
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [navigate]);

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
        {/* s-button in slot renders correctly; native listener handles the click */}
        <s-button ref={createBtnRef} slot="primary-action" variant="primary">
          + Create New Storefront
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

        {/* Storefronts table — plain HTML so React onClick works reliably */}
        <s-section heading="Your Storefronts">
          {storefronts.length === 0 ? (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                No private storefronts yet. Create your first one to give B2B
                clients a dedicated shopping experience.
              </s-paragraph>
              <div>
                <button
                  style={btn.primary}
                  onClick={() => navigate("/app/storefronts/new")}
                >
                  Create Your First Storefront
                </button>
              </div>
            </s-stack>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Company</th>
                    <th style={thStyle}>Slug / URL</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Products</th>
                    <th style={thStyle}>Customers</th>
                    <th style={thStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {storefronts.map((sf) => (
                    <tr key={sf.id}>
                      <td style={tdStyle}>{sf.name}</td>
                      <td style={tdStyle}>{sf.companyName}</td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <span style={{ fontWeight: 600 }}>{sf.slug}</span>
                          <span style={{ fontSize: "11px", color: "#666", wordBreak: "break-all" }}>
                            {getProxyUrl(sf.slug)}
                          </span>
                          <button
                            style={{ ...btn.base, fontSize: "12px", padding: "4px 10px" }}
                            onClick={() => copyUrl(sf.slug)}
                          >
                            Copy URL
                          </button>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          display: "inline-block",
                          padding: "3px 10px",
                          borderRadius: "12px",
                          fontSize: "12px",
                          fontWeight: 600,
                          background: sf.isActive ? "#e3f1df" : "#f0f0f0",
                          color: sf.isActive ? "#1a6631" : "#6d7175",
                        }}>
                          {sf.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td style={tdStyle}>{sf._count.products}</td>
                      <td style={tdStyle}>{sf._count.customers}</td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          <button
                            style={btn.primary}
                            onClick={() => window.open(getProxyUrl(sf.slug), "_blank")}
                          >
                            Preview
                          </button>
                          <button
                            style={btn.base}
                            onClick={() => navigate(`/app/storefronts/${sf.id}/edit`)}
                          >
                            Edit
                          </button>
                          <button
                            style={btn.base}
                            onClick={() => handleToggle(sf)}
                            disabled={isLoading}
                          >
                            {sf.isActive ? "Deactivate" : "Activate"}
                          </button>
                          <button
                            style={btn.danger}
                            onClick={() => handleDeleteClick(sf)}
                            disabled={isLoading}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
        <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
          <button style={btn.danger} onClick={handleDeleteConfirm}>
            Delete Storefront
          </button>
          <button style={btn.base} onClick={() => deleteModalRef.current?.hideOverlay()}>
            Cancel
          </button>
        </div>
      </s-modal>
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
