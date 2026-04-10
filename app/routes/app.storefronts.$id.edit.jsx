import { useCallback, useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import bcrypt from "bcryptjs";

// ─── Server ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const storefront = await prisma.storefront.findFirst({
    where: { id: params.id, shopDomain: session.shop },
    include: {
      products: { orderBy: { sortOrder: "asc" } },
      customers: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!storefront) {
    throw new Response("Storefront not found", { status: 404 });
  }

  return {
    storefront: {
      ...storefront,
      createdAt: storefront.createdAt.toISOString(),
      updatedAt: storefront.updatedAt.toISOString(),
      products: storefront.products.map((p) => ({
        ...p,
        customPrice: p.customPrice ? p.customPrice.toString() : null,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
      customers: storefront.customers.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
      })),
    },
    shop: session.shop,
  };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "Invalid request body" };
  }

  const {
    name, companyName, slug, primaryColor, logoUrl, isActive,
    passwordEnabled, password, requireLogin, selectedVariants,
    shopifyCustomerId, shopifyCompanyId, shopifyCompanyLocationId,
    shopifyCompanyContactId,
  } = body;

  if (!name?.trim()) return { error: "Storefront name is required" };
  if (!companyName?.trim()) return { error: "Company name is required" };
  if (!slug?.trim()) return { error: "URL slug is required" };

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
    return { error: "Slug must be lowercase letters, numbers, and hyphens only" };
  }

  // Verify ownership
  const existing = await prisma.storefront.findFirst({
    where: { id: params.id, shopDomain: session.shop },
  });
  if (!existing) {
    throw new Response("Not Found", { status: 404 });
  }

  // Check slug uniqueness (excluding current storefront)
  const slugConflict = await prisma.storefront.findFirst({
    where: { slug, NOT: { id: params.id } },
  });
  if (slugConflict) {
    return { error: `The slug "${slug}" is already in use.` };
  }

  // Handle password update
  let hashedPassword = existing.password; // keep existing by default
  if (!passwordEnabled) {
    hashedPassword = null;
  } else if (password?.trim()) {
    hashedPassword = await bcrypt.hash(password.trim(), 12);
  }

  // Update storefront
  await prisma.storefront.update({
    where: { id: params.id },
    data: {
      name: name.trim(),
      slug: slug.trim(),
      companyName: companyName.trim(),
      logoUrl: logoUrl?.trim() || null,
      primaryColor: primaryColor || "#000000",
      password: hashedPassword,
      requireLogin: !!requireLogin,
      isActive: isActive !== false,
      shopifyCustomerId: shopifyCustomerId || null,
      shopifyCompanyId: shopifyCompanyId || null,
      shopifyCompanyLocationId: shopifyCompanyLocationId || null,
      shopifyCompanyContactId: shopifyCompanyContactId || null,
    },
  });

  // Replace all products
  await prisma.storefrontProduct.deleteMany({ where: { storefrontId: params.id } });
  if (selectedVariants?.length) {
    await prisma.storefrontProduct.createMany({
      data: selectedVariants.map((v, i) => ({
        storefrontId: params.id,
        shopifyProductId: v.productId,
        shopifyVariantId: v.variantId,
        customPrice: (v.customPrice !== "" && v.customPrice != null && !isNaN(Number(v.customPrice))) ? String(v.customPrice) : null,
        productTitle: v.productTitle || "",
        productImage: v.productImage || null,
        variantTitle: v.variantTitle || "",
        variantSku: v.variantSku || "",
        basePrice: v.basePrice || "0",
        availableForSale: v.availableForSale !== false,
        sortOrder: i,
        isVisible: true,
      })),
    });
  }

  return { success: true };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STEPS = ["Basic Info", "Access Control", "Products", "Review & Save"];

// ─── Native form field components ────────────────────────────────────────────

const inputStyle = {
  padding: "6px 12px",
  border: "1px solid #8c9196",
  borderRadius: "4px",
  fontSize: "14px",
  color: "#202223",
  background: "white",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle = {
  display: "block",
  fontSize: "14px",
  fontWeight: 500,
  color: "#202223",
  marginBottom: "4px",
};

function Field({ label, type = "text", value, onChange, placeholder, required, min, style }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", ...style }}>
      {label && <label style={labelStyle}>{label}</label>}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        min={min}
        style={inputStyle}
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function Checkbox({ label, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px" }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EditStorefront() {
  const { storefront, shop } = useLoaderData();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const saveFetcher = useFetcher();
  const productsFetcher = useFetcher();
  const customerFetcher = useFetcher();
  const companyFetcher = useFetcher();

  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState("");
  const [form, setForm] = useState({
    name: storefront.name,
    companyName: storefront.companyName,
    slug: storefront.slug,
    primaryColor: storefront.primaryColor,
    logoUrl: storefront.logoUrl || "",
    isActive: storefront.isActive,
    passwordEnabled: !!storefront.password,
    password: "",
    requireLogin: storefront.requireLogin,
    shopifyCustomerId: storefront.shopifyCustomerId || null,
    shopifyCompanyId: storefront.shopifyCompanyId || null,
    shopifyCompanyLocationId: storefront.shopifyCompanyLocationId || null,
    shopifyCompanyContactId: storefront.shopifyCompanyContactId || null,
    linkedEntity: storefront.shopifyCompanyId
      ? { type: "company", id: storefront.shopifyCompanyId, name: storefront.companyName || "" }
      : storefront.shopifyCustomerId
        ? { type: "customer", id: storefront.shopifyCustomerId, name: "" }
        : null,
    selectedVariants: storefront.products.map((p) => ({
      productId: p.shopifyProductId,
      variantId: p.shopifyVariantId,
      customPrice: p.customPrice || "",
      productTitle: p.productTitle || "",
      productImage: p.productImage || null,
      variantTitle: p.variantTitle || "",
      variantSku: p.variantSku || "",
      basePrice: p.basePrice || "0",
      availableForSale: p.availableForSale !== false,
    })),
  });

  const [products, setProducts] = useState([]);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimeout = useRef(null);

  const isSaving = saveFetcher.state !== "idle";

  // ── Linked entity search ─────────────────────────────────────────────────
  const [linkedTab, setLinkedTab] = useState("customer");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const customerSearchTimeout = useRef(null);
  const [companySearch, setCompanySearch] = useState("");
  const [companyResults, setCompanyResults] = useState([]);
  const companySearchTimeout = useRef(null);
  const linkedInputRef = useRef(null);
  const [linkedDropdownPos, setLinkedDropdownPos] = useState({ top: 0, left: 0, width: 0 });

  function measureInput() {
    if (linkedInputRef.current) {
      const rect = linkedInputRef.current.getBoundingClientRect();
      setLinkedDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    }
  }

  useEffect(() => {
    if (customerFetcher.data?.customers) {
      setCustomerResults(customerFetcher.data.customers);
      measureInput();
    }
  }, [customerFetcher.data]);

  useEffect(() => {
    if (companyFetcher.data?.companies) {
      setCompanyResults(companyFetcher.data.companies);
      measureInput();
    }
  }, [companyFetcher.data]);

  function handleCustomerSearch(value) {
    setCustomerSearch(value);
    setCustomerResults([]);
    clearTimeout(customerSearchTimeout.current);
    if (!value.trim()) return;
    measureInput();
    customerSearchTimeout.current = setTimeout(() => {
      customerFetcher.load(`/app/storefronts/customer-search?q=${encodeURIComponent(value)}`);
    }, 300);
  }

  function handleCompanySearch(value) {
    setCompanySearch(value);
    setCompanyResults([]);
    clearTimeout(companySearchTimeout.current);
    if (!value.trim()) return;
    measureInput();
    companySearchTimeout.current = setTimeout(() => {
      companyFetcher.load(`/app/storefronts/company-search?q=${encodeURIComponent(value)}`);
    }, 300);
  }

  function selectCustomer(c) {
    setForm((prev) => ({
      ...prev,
      shopifyCustomerId: c.id,
      shopifyCompanyId: null,
      shopifyCompanyLocationId: null,
      shopifyCompanyContactId: null,
      linkedEntity: { type: "customer", id: c.id, name: c.name, email: c.email, company: c.company },
    }));
    setCustomerSearch("");
    setCustomerResults([]);
  }

  function selectCompany(c) {
    setForm((prev) => ({
      ...prev,
      shopifyCustomerId: null,
      shopifyCompanyId: c.id,
      shopifyCompanyLocationId: c.locationId || null,
      shopifyCompanyContactId: c.contactId || null,
      linkedEntity: { type: "company", id: c.id, name: c.name, locationName: c.locationName, contactName: c.contactName, contactEmail: c.contactEmail },
    }));
    setCompanySearch("");
    setCompanyResults([]);
  }

  function clearLinkedEntity() {
    setForm((prev) => ({
      ...prev,
      shopifyCustomerId: null,
      shopifyCompanyId: null,
      shopifyCompanyLocationId: null,
      shopifyCompanyContactId: null,
      linkedEntity: null,
    }));
    setCustomerSearch("");
    setCustomerResults([]);
    setCompanySearch("");
    setCompanyResults([]);
  }

  useEffect(() => {
    if (productsFetcher.data && productsFetcher.state === "idle") {
      if (productsFetcher.data.products) {
        if (productsFetcher.data._append) {
          setProducts((prev) => [...prev, ...productsFetcher.data.products]);
        } else {
          setProducts(productsFetcher.data.products);
        }
        setPageInfo(productsFetcher.data.pageInfo);
        setProductsLoaded(true);
      }
    }
  }, [productsFetcher.data, productsFetcher.state]);

  useEffect(() => {
    if (step === 2 && !productsLoaded) {
      productsFetcher.load("/app/storefronts/products?first=50");
    }
  }, [step]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
      navigate("/app");
    }
    if (saveFetcher.data?.error) {
      shopify.toast.show(saveFetcher.data.error, { isError: true });
    }
  }, [saveFetcher.data, shopify]);

  const updateForm = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  function isVariantSelected(variantId) {
    return form.selectedVariants.some((v) => v.variantId === variantId);
  }

  function toggleVariant(product, variant) {
    setForm((prev) => {
      const exists = prev.selectedVariants.some((v) => v.variantId === variant.id);
      if (exists) {
        return {
          ...prev,
          selectedVariants: prev.selectedVariants.filter((v) => v.variantId !== variant.id),
        };
      }
      return {
        ...prev,
        selectedVariants: [
          ...prev.selectedVariants,
          {
            productId: product.id,
            variantId: variant.id,
            customPrice: "",
            productTitle: product.title,
            productImage: product.image || null,
            variantTitle: variant.title,
            variantSku: variant.sku || "",
            basePrice: variant.price,
            availableForSale: variant.availableForSale,
          },
        ],
      };
    });
  }

  function setCustomPrice(variantId, price) {
    setForm((prev) => ({
      ...prev,
      selectedVariants: prev.selectedVariants.map((v) =>
        v.variantId === variantId ? { ...v, customPrice: price } : v,
      ),
    }));
  }

  const filteredProducts = searchQuery
    ? products.filter((p) => p.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : products;

  function selectAllVisible() {
    const toAdd = [];
    filteredProducts.forEach((product) => {
      product.variants.forEach((variant) => {
        if (!isVariantSelected(variant.id)) {
          toAdd.push({
            productId: product.id,
            variantId: variant.id,
            customPrice: "",
            productTitle: product.title,
            productImage: product.image || null,
            variantTitle: variant.title,
            variantSku: variant.sku || "",
            basePrice: variant.price,
            availableForSale: variant.availableForSale,
          });
        }
      });
    });
    setForm((prev) => ({
      ...prev,
      selectedVariants: [...prev.selectedVariants, ...toAdd],
    }));
  }

  function deselectAllVisible() {
    const visibleVariantIds = new Set(
      filteredProducts.flatMap((p) => p.variants.map((v) => v.id)),
    );
    setForm((prev) => ({
      ...prev,
      selectedVariants: prev.selectedVariants.filter(
        (v) => !visibleVariantIds.has(v.variantId),
      ),
    }));
  }

  function handleSearch(value) {
    setSearchQuery(value);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setProducts([]);
      setProductsLoaded(false);
      productsFetcher.load(
        `/app/storefronts/products?first=50&query=${encodeURIComponent(value)}`,
      );
    }, 400);
  }

  function loadMore() {
    const url = `/app/storefronts/products?first=50${pageInfo.endCursor ? `&after=${pageInfo.endCursor}` : ""}${searchQuery ? `&query=${encodeURIComponent(searchQuery)}` : ""}&_append=1`;
    productsFetcher.load(url);
  }

  function handleSave() {
    saveFetcher.submit(form, { method: "post", encType: "application/json" });
  }

  function tryNext() {
    if (step === 0) {
      if (!form.name.trim()) { setStepError("Storefront name is required."); return; }
      if (!form.companyName.trim()) { setStepError("Company name is required."); return; }
      if (!form.slug.trim()) { setStepError("URL slug is required."); return; }
    }
    setStepError("");
    setStep((s) => s + 1);
  }

  const storefrontUrl = form.slug ? `https://${shop}/apps/storefronts/${form.slug}` : "";

  return (
    <s-page heading={`Edit: ${storefront.name}`}>
      <s-button
        slot="primary-action"
        variant="secondary"
        onClick={() => navigate("/app")}
      >
        Cancel
      </s-button>

      {/* Step indicator */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {STEPS.map((label, i) => (
            <s-box
              key={i}
              padding="small"
              borderRadius="base"
              background={i === step ? "base" : "subdued"}
              borderWidth={i === step ? "base" : "none"}
            >
              <s-stack direction="inline" gap="small-200">
                <s-badge tone={i < step ? "success" : i === step ? "accent" : "neutral"}>
                  {i + 1}
                </s-badge>
                <s-text>{label}</s-text>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      {/* ── Step 0: Basic Info ── */}
      {step === 0 && (
        <s-section heading="Basic Information">
          <s-stack direction="block" gap="base">
            <Field
              label="Storefront Name"
              value={form.name}
              onChange={(e) => updateForm("name", e.target.value)}
              required
            />
            <Field
              label="Company Name"
              value={form.companyName}
              onChange={(e) => updateForm("companyName", e.target.value)}
              required
            />
            <s-stack direction="block" gap="small-200">
              <Field
                label="URL Slug"
                value={form.slug}
                onChange={(e) =>
                  updateForm("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                }
                required
              />
              <s-box padding="small" borderRadius="base" background="subdued">
                <s-text>
                  Storefront URL: <strong>{storefrontUrl}</strong>
                </s-text>
              </s-box>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <Field
                label="Primary Color (hex)"
                value={form.primaryColor}
                onChange={(e) => updateForm("primaryColor", e.target.value)}
                style={{ flex: 1 }}
              />
              <div style={{ display: "flex", flexDirection: "column", alignSelf: "flex-end" }}>
                <label style={labelStyle}>Preview</label>
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(form.primaryColor) ? form.primaryColor : "#000000"}
                  onChange={(e) => updateForm("primaryColor", e.target.value)}
                  style={{ width: "40px", height: "38px", border: "1px solid #8c9196", borderRadius: "4px", padding: "2px", cursor: "pointer", background: "white" }}
                />
              </div>
            </s-stack>
            <Field
              label="Logo URL"
              value={form.logoUrl}
              onChange={(e) => updateForm("logoUrl", e.target.value)}
              placeholder="https://example.com/logo.png (optional)"
            />
            <Toggle
              label="Active"
              checked={form.isActive}
              onChange={(e) => updateForm("isActive", e.target.checked)}
            />

            {/* Linked Shopify Customer or Company */}
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <label style={labelStyle}>Linked Customer / Company (optional)</label>
              <p style={{ margin: "0 0 8px", fontSize: "13px", color: "#6d7175" }}>
                Attach a Shopify customer or company so draft orders are automatically associated with them.
              </p>
              {form.linkedEntity ? (
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", background: "#f1f8f5", border: "1px solid #b5e0ca", borderRadius: "6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, padding: "2px 7px", borderRadius: "10px", background: form.linkedEntity.type === "company" ? "#e3f0ff" : "#f1f8f5", color: form.linkedEntity.type === "company" ? "#1a73e8" : "#2a7a55", border: `1px solid ${form.linkedEntity.type === "company" ? "#b3d4f7" : "#b5e0ca"}` }}>
                    {form.linkedEntity.type === "company" ? "Company" : "Customer"}
                  </span>
                  <span style={{ fontSize: "14px", color: "#202223", flex: 1 }}>
                    <strong>{form.linkedEntity.name || form.linkedEntity.email}</strong>
                    {form.linkedEntity.type === "company" && form.linkedEntity.locationName && (
                      <span style={{ color: "#6d7175", fontSize: "13px" }}> — {form.linkedEntity.locationName}</span>
                    )}
                    {form.linkedEntity.type === "company" && form.linkedEntity.contactEmail && (
                      <div style={{ fontSize: "12px", color: "#6d7175" }}>Contact: {form.linkedEntity.contactName || form.linkedEntity.contactEmail}</div>
                    )}
                    {form.linkedEntity.type === "customer" && (
                      <span style={{ color: "#6d7175", marginLeft: "6px", fontSize: "13px" }}>{form.linkedEntity.email}</span>
                    )}
                  </span>
                  <button onClick={clearLinkedEntity} style={{ background: "none", border: "none", color: "#999", cursor: "pointer", fontSize: "13px" }}>Remove</button>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", gap: "0", marginBottom: "8px", border: "1px solid #8c9196", borderRadius: "4px", overflow: "hidden", width: "fit-content" }}>
                    {["customer", "company"].map((tab) => (
                      <button key={tab} onClick={() => { setLinkedTab(tab); setCustomerSearch(""); setCustomerResults([]); setCompanySearch(""); setCompanyResults([]); }}
                        style={{ padding: "5px 14px", fontSize: "13px", fontWeight: linkedTab === tab ? 600 : 400, background: linkedTab === tab ? "#f0f0f0" : "white", border: "none", borderRight: tab === "customer" ? "1px solid #8c9196" : "none", cursor: "pointer", color: "#202223" }}>
                        {tab === "customer" ? "Customer" : "Company"}
                      </button>
                    ))}
                  </div>
                  {linkedTab === "customer" ? (
                    <div>
                      <input
                        ref={linkedInputRef}
                        type="search"
                        value={customerSearch}
                        onChange={(e) => handleCustomerSearch(e.target.value)}
                        placeholder="Search by name or email..."
                        style={{ padding: "6px 12px", border: "1px solid #8c9196", borderRadius: "4px", fontSize: "14px", width: "100%", boxSizing: "border-box" }}
                      />
                      {customerResults.length > 0 && (
                        <div style={{ position: "fixed", top: linkedDropdownPos.top, left: linkedDropdownPos.left, width: linkedDropdownPos.width, zIndex: 99999, background: "white", border: "1px solid #ddd", borderRadius: "4px", boxShadow: "0 4px 12px rgba(0,0,0,.15)", maxHeight: "220px", overflowY: "auto" }}>
                          {customerResults.map((c) => (
                            <div key={c.id} onClick={() => selectCustomer(c)}
                              style={{ padding: "10px 12px", cursor: "pointer", borderBottom: "1px solid #f1f1f1", fontSize: "14px" }}
                              onMouseEnter={(e) => e.currentTarget.style.background = "#f6f6f7"}
                              onMouseLeave={(e) => e.currentTarget.style.background = "white"}>
                              <strong>{c.name || "(no name)"}</strong>
                              {c.company && <span style={{ color: "#6d7175" }}> — {c.company}</span>}
                              <div style={{ fontSize: "12px", color: "#6d7175" }}>{c.email}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <input
                        ref={linkedInputRef}
                        type="search"
                        value={companySearch}
                        onChange={(e) => handleCompanySearch(e.target.value)}
                        placeholder="Search by company name..."
                        style={{ padding: "6px 12px", border: "1px solid #8c9196", borderRadius: "4px", fontSize: "14px", width: "100%", boxSizing: "border-box" }}
                      />
                      {companyResults.length > 0 && (
                        <div style={{ position: "fixed", top: linkedDropdownPos.top, left: linkedDropdownPos.left, width: linkedDropdownPos.width, zIndex: 99999, background: "white", border: "1px solid #ddd", borderRadius: "4px", boxShadow: "0 4px 12px rgba(0,0,0,.15)", maxHeight: "220px", overflowY: "auto" }}>
                          {companyResults.map((c) => (
                            <div key={c.id} onClick={() => selectCompany(c)}
                              style={{ padding: "10px 12px", cursor: "pointer", borderBottom: "1px solid #f1f1f1", fontSize: "14px" }}
                              onMouseEnter={(e) => e.currentTarget.style.background = "#f6f6f7"}
                              onMouseLeave={(e) => e.currentTarget.style.background = "white"}>
                              <strong>{c.name}</strong>
                              {c.locationName && <span style={{ color: "#6d7175" }}> — {c.locationName}</span>}
                              {c.contactEmail && <div style={{ fontSize: "12px", color: "#6d7175" }}>Contact: {c.contactName || c.contactEmail}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </s-stack>
        </s-section>
      )}

      {/* ── Step 1: Access Control ── */}
      {step === 1 && (
        <s-section heading="Access Control">
          <s-stack direction="block" gap="large">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base">
                  <s-badge tone="success">Always On</s-badge>
                  <s-text>Unique URL Access</s-text>
                </s-stack>
                <s-box padding="small" borderRadius="base" background="subdued">
                  <s-text>{storefrontUrl}</s-text>
                </s-box>
              </s-stack>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <Toggle
                  label="Password Protection"
                  checked={form.passwordEnabled}
                  onChange={(e) => updateForm("passwordEnabled", e.target.checked)}
                />
                {form.passwordEnabled && (
                  <s-stack direction="block" gap="small-200">
                    <Field
                      type="password"
                      label="New Password (leave blank to keep existing)"
                      value={form.password}
                      onChange={(e) => updateForm("password", e.target.value)}
                      placeholder="Enter new password or leave blank"
                    />
                    {storefront.password && !form.password && (
                      <s-banner tone="info">
                        A password is currently set. Enter a new one to change it.
                      </s-banner>
                    )}
                  </s-stack>
                )}
              </s-stack>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <Toggle
                  label="Require Customer Login"
                  checked={form.requireLogin}
                  onChange={(e) => updateForm("requireLogin", e.target.checked)}
                />
                {form.requireLogin && (
                  <s-banner tone="info">
                    Manage customers for this storefront from the{" "}
                    <a href={`/app/storefronts/${storefront.id}/customers`}>Customers page</a>.
                    {storefront.customers?.length > 0 && (
                      <> ({storefront.customers.length} customer{storefront.customers.length !== 1 ? "s" : ""} currently registered)</>
                    )}
                  </s-banner>
                )}
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>
      )}

      {/* ── Step 2: Products ── */}
      {step === 2 && (
        <s-section heading="Select Products">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text>
                {form.selectedVariants.length} variant
                {form.selectedVariants.length !== 1 ? "s" : ""} selected
              </s-text>
              <s-button onClick={selectAllVisible}>Select All Visible</s-button>
              <s-button onClick={deselectAllVisible}>Deselect All Visible</s-button>
            </s-stack>

            <Field
              type="search"
              label="Search products"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search by product name..."
            />

            {productsFetcher.state === "loading" && !productsLoaded && (
              <s-stack direction="inline" gap="base">
                <s-spinner />
                <s-text>Loading products...</s-text>
              </s-stack>
            )}

            {filteredProducts.map((product) => (
              <s-box
                key={product.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    {product.image && (
                      <img
                        src={product.image}
                        alt={product.imageAlt}
                        style={{ width: "40px", height: "40px", objectFit: "cover", borderRadius: "4px" }}
                      />
                    )}
                    <s-text>{product.title}</s-text>
                    <s-badge tone={product.status === "ACTIVE" ? "success" : "neutral"}>
                      {product.status}
                    </s-badge>
                  </s-stack>
                  {product.variants.map((variant) => {
                    const selected = isVariantSelected(variant.id);
                    const sv = form.selectedVariants.find((v) => v.variantId === variant.id);
                    return (
                      <s-stack key={variant.id} direction="inline" gap="base">
                        <Checkbox
                          label={variant.title === "Default Title" ? "Default" : variant.title}
                          checked={selected}
                          onChange={() => toggleVariant(product, variant)}
                        />
                        <s-text style={{ color: "#666", minWidth: "80px" }}>
                          ${parseFloat(variant.price).toFixed(2)}
                        </s-text>
                        {selected && (
                          <Field
                            type="number"
                            label="Custom price"
                            value={sv?.customPrice || ""}
                            onChange={(e) => setCustomPrice(variant.id, e.target.value)}
                            placeholder={`Use store price ($${parseFloat(variant.price).toFixed(2)})`}
                            min="0"
                            style={{ maxWidth: "200px" }}
                          />
                        )}
                      </s-stack>
                    );
                  })}
                </s-stack>
              </s-box>
            ))}

            {pageInfo.hasNextPage && (
              <s-button
                onClick={loadMore}
                disabled={productsFetcher.state === "loading"}
              >
                {productsFetcher.state === "loading" ? "Loading..." : "Load More Products"}
              </s-button>
            )}
          </s-stack>
        </s-section>
      )}

      {/* ── Step 3: Review & Save ── */}
      {step === 3 && (
        <s-section heading="Review & Save">
          <s-stack direction="block" gap="base">
            <s-section heading="Storefront Details">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base">
                  <s-text>Name:</s-text>
                  <s-text>{form.name}</s-text>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-text>Company:</s-text>
                  <s-text>{form.companyName}</s-text>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-text>URL:</s-text>
                  <s-text>{storefrontUrl}</s-text>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-text>Status:</s-text>
                  <s-badge tone={form.isActive ? "success" : "neutral"}>
                    {form.isActive ? "Active" : "Inactive"}
                  </s-badge>
                </s-stack>
              </s-stack>
            </s-section>
            <s-section heading="Products">
              <s-text>
                {form.selectedVariants.length} variant
                {form.selectedVariants.length !== 1 ? "s" : ""} selected
              </s-text>
            </s-section>

            {saveFetcher.data?.error && (
              <s-banner tone="critical" heading="Error">
                {saveFetcher.data.error}
              </s-banner>
            )}

            <s-button
              variant="primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? "Saving Changes..." : "Save Changes"}
            </s-button>
          </s-stack>
        </s-section>
      )}

      {/* Navigation */}
      <s-section>
        {stepError && (
          <s-banner tone="critical" style={{ marginBottom: "8px" }}>
            {stepError}
          </s-banner>
        )}
        <div style={{ display: "flex", gap: "8px" }}>
          {step > 0 && (
            <s-button onClick={() => { setStepError(""); setStep((s) => s - 1); }} disabled={isSaving}>
              Back
            </s-button>
          )}
          {step < STEPS.length - 1 && (
            <s-button variant="primary" onClick={tryNext} disabled={isSaving}>
              Next: {STEPS[step + 1]}
            </s-button>
          )}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
