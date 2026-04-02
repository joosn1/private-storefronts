import { useEffect, useState } from "react";
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

  const totalProducts = storefronts.reduce((sum, s) => sum + s._count.products, 0);
  const totalCustomers = storefronts.reduce((sum, s) => sum + s._count.customers, 0);
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
    await prisma.storefront.deleteMany({ where: { id, shopDomain: session.shop } });
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

const btnBase = {
  padding: "7px 14px",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid #babfc3",
  background: "#ffffff",
  color: "#202020",
  lineHeight: "1.4",
  textDecoration: "none",
  display: "inline-block",
  boxSizing: "border-box",
};

const btnPrimary = {
  padding: "8px 16px",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  border: "none",
  background: "#303030",
  color: "#ffffff",
  lineHeight: "1.4",
  textDecoration: "none",
  display: "inline-block",
  boxSizing: "border-box",
};

const btnDanger = {
  padding: "7px 14px",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  border: "none",
  background: "#d82c0d",
  color: "#ffffff",
  lineHeight: "1.4",
  textDecoration: "none",
  display: "inline-block",
  boxSizing: "border-box",
};

const thStyle = {
  padding: "10px 14px",
  textAlign: "left",
  fontWeight: 600,
  fontSize: "12px",
  color: "#6d7175",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
  borderBottom: "2px solid #e1e3e5",
  background: "#f6f6f7",
};

const tdStyle = {
  padding: "12px 14px",
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

  function handleDeleteConfirm() {
    if (!pendingDelete) return;
    fetcher.submit({ intent: "delete", id: pendingDelete.id }, { method: "post" });
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
      shopify.toast.show("URL copied to clipboard");
    });
  }

  return (
    <div style={{ padding: "24px", fontFamily: "Inter, sans-serif", color: "#202020" }}>

      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#202020" }}>
          Private Storefronts
        </h1>
        <button type="button" style={btnPrimary} onClick={() => navigate("/app/storefronts/new")}>
          + Create New Storefront
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "28px" }}>
        {[
          { label: "Active Storefronts", value: activeCount },
          { label: "Products Configured", value: totalProducts },
          { label: "Total Customers", value: totalCustomers },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "16px" }}>
            <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "6px" }}>{label}</div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "#202020" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Storefronts card */}
      <div style={{ background: "#ffffff", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e1e3e5" }}>
          <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Your Storefronts</h2>
        </div>

        {storefronts.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#6d7175" }}>
            <p style={{ marginBottom: "20px", fontSize: "14px" }}>
              No private storefronts yet. Create your first one to give B2B clients a dedicated shopping experience.
            </p>
            <button type="button" style={btnPrimary} onClick={() => navigate("/app/storefronts/new")}>
              Create Your First Storefront
            </button>
          </div>
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
                  <tr key={sf.id} style={{ background: "#fff" }}>
                    <td style={tdStyle}>
                      <span style={{ fontWeight: 600 }}>{sf.name}</span>
                    </td>
                    <td style={tdStyle}>{sf.companyName}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <span style={{ fontWeight: 600, fontSize: "13px" }}>{sf.slug}</span>
                        <span style={{ fontSize: "11px", color: "#6d7175", wordBreak: "break-all" }}>
                          {getProxyUrl(sf.slug)}
                        </span>
                        <button
                          type="button"
                          style={{ ...btnBase, fontSize: "12px", padding: "3px 8px" }}
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
                        borderRadius: "20px",
                        fontSize: "12px",
                        fontWeight: 600,
                        background: sf.isActive ? "#d4edda" : "#f0f0f0",
                        color: sf.isActive ? "#155724" : "#6d7175",
                      }}>
                        {sf.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={tdStyle}>{sf._count.products}</td>
                    <td style={tdStyle}>{sf._count.customers}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                        <a
                          href={getProxyUrl(sf.slug)}
                          target="_blank"
                          rel="noreferrer"
                          style={btnPrimary}
                        >
                          Preview
                        </a>
                        <button
                          type="button"
                          style={btnBase}
                          onClick={() => navigate(`/app/storefronts/${sf.id}/edit`)}
                          disabled={isLoading}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          style={btnBase}
                          onClick={() => navigate(`/app/storefronts/${sf.id}/customers`)}
                          disabled={isLoading}
                        >
                          Customers
                        </button>
                        <button
                          type="button"
                          style={btnBase}
                          onClick={() => handleToggle(sf)}
                          disabled={isLoading}
                        >
                          {sf.isActive ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          type="button"
                          style={btnDanger}
                          onClick={() => setPendingDelete(sf)}
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
      </div>

      {/* Delete confirmation — pure React overlay, no web components */}
      {pendingDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
        >
          <div style={{
            background: "#fff",
            borderRadius: "8px",
            padding: "28px",
            maxWidth: "480px",
            width: "90%",
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          }}>
            <h2 style={{ margin: "0 0 12px", fontSize: "18px", fontWeight: 700 }}>
              Delete Storefront
            </h2>
            <p style={{ margin: "0 0 24px", fontSize: "14px", color: "#6d7175", lineHeight: "1.5" }}>
              Are you sure you want to delete{" "}
              <strong style={{ color: "#202020" }}>{pendingDelete.name}</strong>?
              This will permanently remove the storefront, all configured products, and all customer accounts.
              This action cannot be undone.
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
              <button type="button" style={btnBase} onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button type="button" style={btnDanger} onClick={handleDeleteConfirm}>
                Delete Storefront
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
