import { useCallback, useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { hashStorefrontPassword } from "../utils/session.server";

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
  const { admin, session } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "Invalid request body" };
  }

  // ── Sync prices from metafield ──────────────────────────────────────────────
  if (body._action === "sync_prices") {
    const storefront = await prisma.storefront.findFirst({
      where: { id: params.id, shopDomain: session.shop },
      include: { products: true },
    });
    if (!storefront) return { error: "Storefront not found" };

    const products = storefront.products;
    if (!products.length) return { synced: 0 };

    // Build batched GraphQL query — one alias per variant
    const aliases = products
      .map((p, i) =>
        `v${i}: productVariant(id: "${p.shopifyVariantId}") { metafield(namespace: "custom", key: "private_storefront_price") { value } }`
      )
      .join("\n");

    const response = await admin.graphql(`#graphql\nquery { ${aliases} }`);
    const { data } = await response.json();

    let synced = 0;
    const syncedPrices = {};
    for (let i = 0; i < products.length; i++) {
      const raw = data?.[`v${i}`]?.metafield?.value;
      if (raw == null) continue;

      // Parse Shopify money JSON: {"amount":"500.00","currency_code":"USD"}
      let amount;
      try {
        const parsed = JSON.parse(raw);
        amount = parsed?.amount ?? raw;
      } catch {
        amount = raw;
      }

      const num = parseFloat(amount);
      if (isNaN(num)) continue;

      await prisma.storefrontProduct.update({
        where: { id: products[i].id },
        data: { customPrice: num.toFixed(2) },
      });
      syncedPrices[products[i].shopifyVariantId] = num.toFixed(2);
      synced++;
    }

    return { synced, prices: syncedPrices };
  }

  const {
    name, companyName, slug, primaryColor, logoUrl, isActive,
    passwordEnabled, password, requireLogin, selectedVariants,
    shopifyCustomerId, shopifyCompanyId, shopifyCompanyLocationId,
    shopifyCompanyContactId, priceMetafield,
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
    hashedPassword = hashStorefrontPassword(password.trim());
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
      priceMetafield: priceMetafield?.trim() || null,
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
  const skuFetcher = useFetcher();
  const customerFetcher = useFetcher();
  const companyFetcher = useFetcher();
  const syncFetcher = useFetcher();

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
    priceMetafield: storefront.priceMetafield || "custom.private_storefront_price",
  });

  const [products, setProducts] = useState([]);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimeout = useRef(null);

  // ── Bulk SKU import ──────────────────────────────────────────────────────────
  const [skuText, setSkuText] = useState("");
  const [skuPanelOpen, setSkuPanelOpen] = useState(false);
  const [skuResults, setSkuResults] = useState(null); // { variants, notFound }

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
    if (skuFetcher.data && skuFetcher.state === "idle") {
      setSkuResults(skuFetcher.data);
    }
  }, [skuFetcher.data, skuFetcher.state]);

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

  // When sync completes, patch form state so saving preserves the synced prices
  useEffect(() => {
    const prices = syncFetcher.data?.prices;
    if (!prices) return;
    setForm((prev) => ({
      ...prev,
      selectedVariants: prev.selectedVariants.map((v) =>
        prices[v.variantId] != null
          ? { ...v, customPrice: prices[v.variantId] }
          : v,
      ),
    }));
  }, [syncFetcher.data]);

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
            customPrice: variant.storefrontPrice || "",
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
            customPrice: variant.storefrontPrice || "",
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

  function lookupSkus() {
    const skus = skuText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!skus.length) return;
    setSkuResults(null);
    skuFetcher.submit(
      { skus },
      { method: "post", action: "/app/storefronts/sku-lookup", encType: "application/json" },
    );
  }

  function addSkuMatches(variants) {
    const toAdd = [];
    for (const v of variants) {
      if (!form.selectedVariants.some((sv) => sv.variantId === v.variantId)) {
        toAdd.push({
          productId: v.productId,
          variantId: v.variantId,
          customPrice: v.storefrontPrice || "",
          productTitle: v.productTitle,
          productImage: v.productImage || null,
          variantTitle: v.variantTitle || "",
          variantSku: v.variantSku || "",
          basePrice: v.price,
          availableForSale: v.availableForSale,
        });
      }
    }
    if (toAdd.length) {
      setForm((prev) => ({ ...prev, selectedVariants: [...prev.selectedVariants, ...toAdd] }));
      shopify.toast.show(`Added ${toAdd.length} variant${toAdd.length !== 1 ? "s" : ""}`);
    } else {
      shopify.toast.show("All matched variants are already added");
    }
    setSkuText("");
    setSkuResults(null);
    setSkuPanelOpen(false);
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
            <div style={{ display: "flex", flexDirection: "column" }}>
              <label style={labelStyle}>Custom Price Metafield (optional)</label>
              <p style={{ margin: "0 0 6px", fontSize: "13px", color: "#6d7175" }}>
                Enter a metafield in <strong>namespace.key</strong> format (e.g. <code>custom.b2b_price</code>).
                At checkout, the variant's metafield value will be used as the price instead of the listed price.
              </p>
              <input
                type="text"
                value={form.priceMetafield}
                onChange={(e) => updateForm("priceMetafield", e.target.value)}
                placeholder="custom.b2b_price (optional)"
                style={inputStyle}
              />
            </div>
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

            {/* ── Sync prices from metafield ── */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", background: "#f1f8f5", border: "1px solid #b5e0ca", borderRadius: "6px" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#202223" }}>Sync prices from Shopify</div>
                <div style={{ fontSize: "13px", color: "#6d7175" }}>
                  Pulls the <code>custom.private_storefront_price</code> metafield value for every product in this storefront and saves it as the custom price.
                </div>
                {syncFetcher.data?.synced != null && (
                  <div style={{ fontSize: "13px", color: "#2a7a55", marginTop: "4px" }}>
                    ✓ Synced prices for {syncFetcher.data.synced} variant{syncFetcher.data.synced !== 1 ? "s" : ""}
                  </div>
                )}
                {syncFetcher.data?.error && (
                  <div style={{ fontSize: "13px", color: "#d72c0d", marginTop: "4px" }}>
                    Error: {syncFetcher.data.error}
                  </div>
                )}
              </div>
              <button
                onClick={() => syncFetcher.submit({ _action: "sync_prices" }, { method: "post", encType: "application/json" })}
                disabled={syncFetcher.state !== "idle"}
                style={{ padding: "8px 16px", background: "#008060", color: "white", border: "none", borderRadius: "5px", fontSize: "13px", fontWeight: 600, cursor: syncFetcher.state !== "idle" ? "not-allowed" : "pointer", opacity: syncFetcher.state !== "idle" ? 0.7 : 1, whiteSpace: "nowrap" }}
              >
                {syncFetcher.state !== "idle" ? "Syncing…" : "Sync Prices"}
              </button>
            </div>

            {/* ── Bulk SKU Import ── */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <s-text fontWeight="bold">Bulk Add by SKU</s-text>
                  <button
                    onClick={() => { setSkuPanelOpen((o) => !o); setSkuResults(null); }}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#2c6ecb", padding: 0 }}
                  >
                    {skuPanelOpen ? "Hide" : "Paste a list of SKUs to add products in bulk"}
                  </button>
                </div>

                {skuPanelOpen && (
                  <s-stack direction="block" gap="small">
                    <textarea
                      value={skuText}
                      onChange={(e) => { setSkuText(e.target.value); setSkuResults(null); }}
                      placeholder={"Paste SKUs here — one per line or comma-separated:\nBOLT-1234\nNUT-5678\nWASHER-91011"}
                      rows={6}
                      style={{ width: "100%", padding: "10px", border: "1px solid #ddd", borderRadius: "6px", fontFamily: "monospace", fontSize: "13px", resize: "vertical", boxSizing: "border-box" }}
                    />
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={lookupSkus}
                        disabled={skuFetcher.state !== "idle" || !skuText.trim()}
                        style={{ padding: "8px 18px", background: "#303030", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: 600, opacity: (skuFetcher.state !== "idle" || !skuText.trim()) ? 0.5 : 1 }}
                      >
                        {skuFetcher.state !== "idle" ? "Looking up…" : "Look Up SKUs"}
                      </button>
                    </div>

                    {/* Results */}
                    {skuResults && (
                      <s-stack direction="block" gap="small">
                        {skuResults.variants?.length > 0 && (
                          <s-banner tone="success">
                            <s-stack direction="block" gap="small-200">
                              <s-text fontWeight="bold">
                                {skuResults.variants.length} variant{skuResults.variants.length !== 1 ? "s" : ""} found
                              </s-text>
                              <div style={{ maxHeight: "200px", overflowY: "auto", fontSize: "13px" }}>
                                {skuResults.variants.map((v) => (
                                  <div key={v.variantId} style={{ padding: "3px 0", borderBottom: "1px solid rgba(0,0,0,.06)" }}>
                                    <strong>{v.sku}</strong> — {v.productTitle}{v.variantTitle ? ` · ${v.variantTitle}` : ""} · ${parseFloat(v.price).toFixed(2)}
                                  </div>
                                ))}
                              </div>
                              <button
                                onClick={() => addSkuMatches(skuResults.variants)}
                                style={{ padding: "8px 18px", background: "#008060", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: 600, alignSelf: "flex-start" }}
                              >
                                Add All {skuResults.variants.length} to Storefront
                              </button>
                            </s-stack>
                          </s-banner>
                        )}
                        {skuResults.notFound?.length > 0 && (
                          <s-banner tone="warning">
                            <s-text fontWeight="bold">SKUs not found ({skuResults.notFound.length}):</s-text>
                            <s-text>{skuResults.notFound.join(", ")}</s-text>
                          </s-banner>
                        )}
                        {skuResults.variants?.length === 0 && skuResults.notFound?.length === 0 && (
                          <s-banner tone="warning"><s-text>No SKUs entered.</s-text></s-banner>
                        )}
                      </s-stack>
                    )}
                  </s-stack>
                )}
              </s-stack>
            </s-box>

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
