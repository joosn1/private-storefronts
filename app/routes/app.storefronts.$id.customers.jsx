import { useEffect, useRef, useState } from "react"; // useRef kept for deleteModalRef
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Server ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const storefront = await prisma.storefront.findFirst({
    where: { id: params.id, shopDomain: session.shop },
  });
  if (!storefront) throw new Response("Not Found", { status: 404 });

  const customers = await prisma.storefrontCustomer.findMany({
    where: { storefrontId: params.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      createdAt: true,
    },
  });

  return {
    storefront: {
      id: storefront.id,
      name: storefront.name,
      slug: storefront.slug,
    },
    customers: customers.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  // Verify ownership
  const storefront = await prisma.storefront.findFirst({
    where: { id: params.id, shopDomain: session.shop },
  });
  if (!storefront) throw new Response("Not Found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add") {
    const email = formData.get("email")?.trim().toLowerCase();
    const name = formData.get("name")?.trim() || null;

    if (!email) return { error: "Email is required" };

    // Check for duplicate email in this storefront
    const existing = await prisma.storefrontCustomer.findFirst({
      where: { storefrontId: params.id, email },
    });
    if (existing) return { error: "A customer with this email already exists" };

    await prisma.storefrontCustomer.create({
      data: {
        storefrontId: params.id,
        email,
        name,
        passwordHash: "", // unused — customers authenticate via Shopify
        isActive: true,
      },
    });
    return { success: true, message: "Customer added successfully" };
  }

  if (intent === "toggle") {
    const customerId = formData.get("customerId");
    const customer = await prisma.storefrontCustomer.findFirst({
      where: { id: customerId, storefrontId: params.id },
    });
    if (customer) {
      await prisma.storefrontCustomer.update({
        where: { id: customerId },
        data: { isActive: !customer.isActive },
      });
    }
    return { success: true, message: customer?.isActive ? "Customer deactivated" : "Customer activated" };
  }

  if (intent === "delete") {
    const customerId = formData.get("customerId");
    await prisma.storefrontCustomer.deleteMany({
      where: { id: customerId, storefrontId: params.id },
    });
    return { success: true, message: "Customer removed" };
  }

  return { error: "Unknown action" };
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function StorefrontCustomers() {
  const { storefront, customers } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const deleteModalRef = useRef(null);

  const [newCustomer, setNewCustomer] = useState({ email: "", name: "" });
  const [pendingDelete, setPendingDelete] = useState(null);

  const isLoading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message || "Done");
      if (fetcher.data.message?.includes("added")) {
        setNewCustomer({ email: "", name: "" });
      }
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  function handleAddCustomer() {
    if (!newCustomer.email) return;
    const fd = new FormData();
    fd.set("intent", "add");
    fd.set("email", newCustomer.email);
    fd.set("name", newCustomer.name);
    fetcher.submit(fd, { method: "post" });
  }

  function handleToggle(customer) {
    const fd = new FormData();
    fd.set("intent", "toggle");
    fd.set("customerId", customer.id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleDeleteConfirm() {
    if (!pendingDelete) return;
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("customerId", pendingDelete.id);
    fetcher.submit(fd, { method: "post" });
    deleteModalRef.current?.hideOverlay();
    setPendingDelete(null);
  }

  return (
    <>
      <s-page heading={`Customers — ${storefront.name}`}>
        <s-button
          slot="primary-action"
          variant="secondary"
          onClick={() => navigate("/app")}
        >
          Back to Dashboard
        </s-button>

        {/* Add customer form */}
        <s-section heading="Add Customer">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Customers authenticate using their Shopify account. Enter their email address to grant access to this storefront.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-text-field
                label="Email"
                value={newCustomer.email}
                onInput={(e) => setNewCustomer((p) => ({ ...p, email: e.target.value }))}
                placeholder="customer@example.com"
                style={{ flex: 1 }}
                required
              />
              <s-text-field
                label="Name (optional)"
                value={newCustomer.name}
                onInput={(e) => setNewCustomer((p) => ({ ...p, name: e.target.value }))}
                placeholder="Full name"
                style={{ flex: 1 }}
              />
            </s-stack>
            <s-button
              variant="primary"
              onClick={handleAddCustomer}
              disabled={isLoading || !newCustomer.email}
            >
              Add Customer
            </s-button>
          </s-stack>
        </s-section>

        {/* Customers table */}
        <s-section heading={`Customers (${customers.length})`}>
          {customers.length === 0 ? (
            <s-paragraph>No customers yet. Add customers above.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header>
                <s-table-header-row>
                  <s-table-cell>Email</s-table-cell>
                  <s-table-cell>Name</s-table-cell>
                  <s-table-cell>Status</s-table-cell>
                  <s-table-cell>Added</s-table-cell>
                  <s-table-cell>Actions</s-table-cell>
                </s-table-header-row>
              </s-table-header>
              <s-table-body>
                {customers.map((customer) => (
                  <s-table-row key={customer.id}>
                    <s-table-cell>{customer.email}</s-table-cell>
                    <s-table-cell>{customer.name || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={customer.isActive ? "success" : "neutral"}>
                        {customer.isActive ? "Active" : "Inactive"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(customer.createdAt).toLocaleDateString()}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button-group>
                        <s-button
                          onClick={() => handleToggle(customer)}
                          disabled={isLoading}
                        >
                          {customer.isActive ? "Deactivate" : "Activate"}
                        </s-button>
                        <s-button
                          tone="critical"
                          onClick={() => {
                            setPendingDelete(customer);
                            deleteModalRef.current?.showOverlay();
                          }}
                          disabled={isLoading}
                        >
                          Remove
                        </s-button>
                      </s-button-group>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-page>

      {/* Delete modal */}
      <s-modal
        ref={deleteModalRef}
        heading="Remove Customer"
        onHide={() => setPendingDelete(null)}
      >
        <s-paragraph>
          Remove <strong>{pendingDelete?.email}</strong> from this storefront?
          They will no longer be able to log in.
        </s-paragraph>
        <s-button-group slot="primary-action">
          <s-button tone="critical" variant="primary" onClick={handleDeleteConfirm}>
            Remove Customer
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
