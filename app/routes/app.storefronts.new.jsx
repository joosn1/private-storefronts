import { useCallback, useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import bcrypt from "bcryptjs";

// ─── Server ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  return { appUrl, shop: session.shop };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "Invalid request body" };
  }

  const { name, companyName, slug, primaryColor, logoUrl, isActive,
          passwordEnabled, password, requireLogin, customers, selectedVariants } = body;

  // Validate required fields
  if (!name?.trim()) return { error: "Storefront name is required" };
  if (!companyName?.trim()) return { error: "Company name is required" };
  if (!slug?.trim()) return { error: "URL slug is required" };

  // Validate slug format
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
    return { error: "Slug must be lowercase letters, numbers, and hyphens only (cannot start or end with a hyphen)" };
  }

  // Check slug uniqueness
  const existing = await prisma.storefront.findUnique({ where: { slug } });
  if (existing) {
    return { error: `The slug "${slug}" is already in use. Please choose a different one.` };
  }

  // Hash password if provided
  let hashedPassword = null;
  if (passwordEnabled && password?.trim()) {
    hashedPassword = await bcrypt.hash(password.trim(), 12);
  }

  // Create storefront
  const storefront = await prisma.storefront.create({
    data: {
      shopDomain: session.shop,
      name: name.trim(),
      slug: slug.trim(),
      companyName: companyName.trim(),
      logoUrl: logoUrl?.trim() || null,
      primaryColor: primaryColor || "#000000",
      password: hashedPassword,
      requireLogin: !!requireLogin,
      isActive: isActive !== false,
    },
  });

  // Create products
  if (selectedVariants?.length) {
    await prisma.storefrontProduct.createMany({
      data: selectedVariants.map((v, i) => ({
        storefrontId: storefront.id,
        shopifyProductId: v.productId,
        shopifyVariantId: v.variantId,
        customPrice: (v.customPrice !== "" && v.customPrice != null && !isNaN(Number(v.customPrice))) ? String(v.customPrice) : null,
        productTitle: v.productTitle || "",
        productImage: v.productImage || null,
        variantTitle: v.variantTitle || "",
        basePrice: v.basePrice || "0",
        availableForSale: v.availableForSale !== false,
        sortOrder: i,
        isVisible: true,
      })),
    });
  }

  // Create customers
  if (requireLogin && customers?.length) {
    for (const customer of customers) {
      if (!customer.email || !customer.password) continue;
      const hash = await bcrypt.hash(customer.password, 12);
      await prisma.storefrontCustomer.create({
        data: {
          storefrontId: storefront.id,
          email: customer.email.trim().toLowerCase(),
          passwordHash: hash,
          name: customer.name?.trim() || null,
          isActive: true,
        },
      });
    }
  }

  return { success: true };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const STEPS = ["Basic Info", "Access Control", "Products", "Review & Save"];

// ─── Native form field components (React synthetic events work correctly) ────

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

export default function NewStorefront() {
  const { shop } = useLoaderData();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const saveFetcher = useFetcher();
  const productsFetcher = useFetcher();

  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState("");
  const [form, setForm] = useState({
    name: "",
    companyName: "",
    slug: "",
    primaryColor: "#000000",
    logoUrl: "",
    isActive: true,
    passwordEnabled: false,
    password: "",
    requireLogin: false,
    customers: [],
    selectedVariants: [],
  });

  // Product loading state
  const [products, setProducts] = useState([]);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimeout = useRef(null);

  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Customer form
  const [newCustomer, setNewCustomer] = useState({ email: "", name: "", password: "" });

  const isSaving = saveFetcher.state !== "idle";

  // ── Sync products fetcher results ────────────────────────────────────────
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

  // ── Load products when entering step 2 ────────────────────────────────────
  useEffect(() => {
    if (step === 2 && !productsLoaded) {
      productsFetcher.load("/app/storefronts/products?first=50");
    }
  }, [step]);

  // ── Toast on save error / navigate on success ─────────────────────────────
  useEffect(() => {
    if (saveFetcher.data?.success) {
      navigate("/app");
    }
    if (saveFetcher.data?.error) {
      shopify.toast.show(saveFetcher.data.error, { isError: true });
    }
  }, [saveFetcher.data, shopify]);

  // ── Form helpers ─────────────────────────────────────────────────────────
  const updateForm = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  function handleCompanyChange(value) {
    setForm((prev) => ({
      ...prev,
      companyName: value,
      slug: slugManuallyEdited ? prev.slug : slugify(value),
    }));
  }

  // ── Product selection helpers ─────────────────────────────────────────────
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

  // ── Search ────────────────────────────────────────────────────────────────
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

  // Filter products client-side (instant feedback while typing)
  const filteredProducts = searchQuery
    ? products.filter((p) =>
        p.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : products;

  // ── Customer helpers ──────────────────────────────────────────────────────
  function addCustomer() {
    if (!newCustomer.email || !newCustomer.password) return;
    setForm((prev) => ({
      ...prev,
      customers: [...prev.customers, { ...newCustomer }],
    }));
    setNewCustomer({ email: "", name: "", password: "" });
  }

  function removeCustomer(email) {
    setForm((prev) => ({
      ...prev,
      customers: prev.customers.filter((c) => c.email !== email),
    }));
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  function handleSave() {
    saveFetcher.submit(form, {
      method: "post",
      encType: "application/json",
    });
  }

  // ── Validation per step ───────────────────────────────────────────────────
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

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <s-page heading="Create Private Storefront">
      <s-button
        slot="primary-action"
        onClick={() => navigate("/app")}
        variant="secondary"
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
              placeholder="e.g. Acme Corp Wholesale"
              required
            />
            <Field
              label="Company Name"
              value={form.companyName}
              onChange={(e) => handleCompanyChange(e.target.value)}
              placeholder="e.g. Acme Corporation"
              required
            />
            <s-stack direction="block" gap="small-200">
              <Field
                label="URL Slug"
                value={form.slug}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  updateForm("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
                placeholder="e.g. acme-corp"
                required
              />
              {form.slug && (
                <s-box padding="small" borderRadius="base" background="subdued">
                  <s-text>
                    Storefront URL:{" "}
                    <strong>{storefrontUrl}</strong>
                  </s-text>
                </s-box>
              )}
            </s-stack>
            <s-stack direction="inline" gap="base">
              <Field
                label="Primary Color (hex)"
                value={form.primaryColor}
                onChange={(e) => updateForm("primaryColor", e.target.value)}
                placeholder="#000000"
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
          </s-stack>
        </s-section>
      )}

      {/* ── Step 1: Access Control ── */}
      {step === 1 && (
        <s-section heading="Access Control">
          <s-stack direction="block" gap="large">
            {/* Unique URL (always on) */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base">
                  <s-badge tone="success">Always On</s-badge>
                  <s-text>Unique URL Access</s-text>
                </s-stack>
                <s-paragraph>
                  Customers can access this storefront via its unique URL.
                </s-paragraph>
                {form.slug && (
                  <s-box padding="small" borderRadius="base" background="subdued">
                    <s-text>{storefrontUrl}</s-text>
                  </s-box>
                )}
              </s-stack>
            </s-box>

            {/* Password Protection */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <Toggle
                  label="Password Protection"
                  checked={form.passwordEnabled}
                  onChange={(e) => updateForm("passwordEnabled", e.target.checked)}
                />
                <s-paragraph>
                  Require visitors to enter a password before viewing the storefront.
                </s-paragraph>
                {form.passwordEnabled && (
                  <Field
                    type="password"
                    label="Storefront Password"
                    value={form.password}
                    onChange={(e) => updateForm("password", e.target.value)}
                    placeholder="Enter a password for this storefront"
                  />
                )}
              </s-stack>
            </s-box>

            {/* Require Customer Login */}
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <Toggle
                  label="Require Customer Login"
                  checked={form.requireLogin}
                  onChange={(e) => updateForm("requireLogin", e.target.checked)}
                />
                <s-paragraph>
                  Only registered customers in this storefront&apos;s customer list can
                  access it after logging in.
                </s-paragraph>

                {form.requireLogin && (
                  <s-stack direction="block" gap="base">
                    <s-heading>Add Customers</s-heading>
                    <s-stack direction="inline" gap="base">
                      <Field
                        label="Email"
                        value={newCustomer.email}
                        onChange={(e) => setNewCustomer((p) => ({ ...p, email: e.target.value }))}
                        placeholder="customer@example.com"
                        style={{ flex: 1 }}
                      />
                      <Field
                        label="Name (optional)"
                        value={newCustomer.name}
                        onChange={(e) => setNewCustomer((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Full name"
                        style={{ flex: 1 }}
                      />
                      <Field
                        type="password"
                        label="Password"
                        value={newCustomer.password}
                        onChange={(e) => setNewCustomer((p) => ({ ...p, password: e.target.value }))}
                        placeholder="Customer password"
                        style={{ flex: 1 }}
                      />
                      <s-button variant="primary" onClick={addCustomer} style={{ alignSelf: "flex-end" }}>
                        Add
                      </s-button>
                    </s-stack>

                    {form.customers.length > 0 && (
                      <s-table>
                        <s-table-header>
                          <s-table-header-row>
                            <s-table-cell>Email</s-table-cell>
                            <s-table-cell>Name</s-table-cell>
                            <s-table-cell>Action</s-table-cell>
                          </s-table-header-row>
                        </s-table-header>
                        <s-table-body>
                          {form.customers.map((c) => (
                            <s-table-row key={c.email}>
                              <s-table-cell>{c.email}</s-table-cell>
                              <s-table-cell>{c.name || "—"}</s-table-cell>
                              <s-table-cell>
                                <s-button
                                  tone="critical"
                                  onClick={() => removeCustomer(c.email)}
                                >
                                  Remove
                                </s-button>
                              </s-table-cell>
                            </s-table-row>
                          ))}
                        </s-table-body>
                      </s-table>
                    )}
                  </s-stack>
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

            {productsLoaded && filteredProducts.length === 0 && (
              <s-paragraph>No products found.</s-paragraph>
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
                  <s-text>Primary Color:</s-text>
                  <s-stack direction="inline" gap="small-200">
                    <div
                      style={{
                        backgroundColor: form.primaryColor,
                        width: "16px",
                        height: "16px",
                        borderRadius: "2px",
                        display: "inline-block",
                        border: "1px solid #ddd",
                      }}
                    />
                    <s-text>{form.primaryColor}</s-text>
                  </s-stack>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-text>Status:</s-text>
                  <s-badge tone={form.isActive ? "success" : "neutral"}>
                    {form.isActive ? "Active" : "Inactive"}
                  </s-badge>
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="Access Control">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base">
                  <s-text>Password Protection:</s-text>
                  <s-badge tone={form.passwordEnabled ? "success" : "neutral"}>
                    {form.passwordEnabled ? "Enabled" : "Disabled"}
                  </s-badge>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-text>Require Customer Login:</s-text>
                  <s-badge tone={form.requireLogin ? "success" : "neutral"}>
                    {form.requireLogin ? "Enabled" : "Disabled"}
                  </s-badge>
                </s-stack>
                {form.requireLogin && (
                  <s-stack direction="inline" gap="base">
                    <s-text>Customers:</s-text>
                    <s-text>{form.customers.length} added</s-text>
                  </s-stack>
                )}
              </s-stack>
            </s-section>

            <s-section heading="Products">
              <s-stack direction="inline" gap="base">
                <s-text>Selected Variants:</s-text>
                <s-text>{form.selectedVariants.length}</s-text>
              </s-stack>
              {form.selectedVariants.filter((v) => v.customPrice).length > 0 && (
                <s-stack direction="inline" gap="base">
                  <s-text>With Custom Pricing:</s-text>
                  <s-text>
                    {form.selectedVariants.filter((v) => v.customPrice).length}
                  </s-text>
                </s-stack>
              )}
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
              loading={isSaving}
            >
              {isSaving ? "Creating Storefront..." : "Create Storefront"}
            </s-button>
          </s-stack>
        </s-section>
      )}

      {/* Navigation buttons */}
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
