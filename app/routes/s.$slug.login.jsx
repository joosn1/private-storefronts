import { redirect } from "react-router";
import { useActionData, Form, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticateCustomer } from "../utils/storefront-api.server";
import {
  getSessionCookie,
  buildSetCookieHeader,
  customerCookieName,
  SESSION_MAX_AGE,
} from "../utils/session.server";

export const loader = async ({ request, params }) => {
  const { slug } = params;
  // Already logged in?
  const customerId = getSessionCookie(request, customerCookieName(slug));
  if (customerId) return redirect(`/s/${slug}`);

  // Load storefront to get the shop domain (for the "forgot password" link)
  const storefront = await prisma.storefront.findUnique({
    where: { slug },
    select: { shopDomain: true, name: true },
  });
  if (!storefront) throw new Response("Not Found", { status: 404 });

  return { shopDomain: storefront.shopDomain, storefrontName: storefront.name };
};

export const action = async ({ request, params }) => {
  const { slug } = params;
  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const storefront = await prisma.storefront.findUnique({
    where: { slug },
    include: {
      customers: {
        where: { isActive: true },
        select: { email: true },
      },
    },
  });
  if (!storefront) throw new Response("Not Found", { status: 404 });

  // Authenticate against Shopify's customer accounts
  const result = await authenticateCustomer(storefront.shopDomain, email, password);
  if (result.error) {
    return { error: result.error };
  }

  // If the storefront has a customer whitelist, enforce it
  if (storefront.customers.length > 0) {
    const allowed = storefront.customers.some(
      (c) => c.email.toLowerCase() === email,
    );
    if (!allowed) {
      return {
        error:
          "Your account is not authorized to access this storefront. Please contact the store owner.",
      };
    }
  }

  return redirect(`/s/${slug}`, {
    headers: {
      "Set-Cookie": buildSetCookieHeader(
        customerCookieName(slug),
        result.customerId,
        { maxAge: SESSION_MAX_AGE },
      ),
    },
  });
};

export default function StorefrontLogin() {
  const actionData = useActionData();
  const { shopDomain } = useLoaderData();

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "calc(100vh - 72px)",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "40px 48px",
          borderRadius: 10,
          boxShadow: "0 2px 16px rgba(0,0,0,.1)",
          width: "100%",
          maxWidth: 400,
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 700 }}>
          Sign In
        </h2>
        <p style={{ color: "#666", margin: "0 0 24px", fontSize: 14 }}>
          Sign in with your Shopify account to access this storefront.
        </p>

        <Form method="post">
          {actionData?.error && (
            <div
              style={{
                background: "#fee",
                color: "#c00",
                padding: "10px 14px",
                borderRadius: 6,
                marginBottom: 16,
                fontSize: 14,
              }}
            >
              {actionData.error}
            </div>
          )}

          <label
            style={{
              display: "block",
              marginBottom: 6,
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Email
          </label>
          <input
            type="email"
            name="email"
            autoFocus
            required
            style={{
              width: "100%",
              padding: "10px 14px",
              border: "1px solid #ddd",
              borderRadius: 6,
              fontSize: 15,
              boxSizing: "border-box",
              marginBottom: 16,
            }}
          />

          <label
            style={{
              display: "block",
              marginBottom: 6,
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Password
          </label>
          <input
            type="password"
            name="password"
            required
            style={{
              width: "100%",
              padding: "10px 14px",
              border: "1px solid #ddd",
              borderRadius: 6,
              fontSize: 15,
              boxSizing: "border-box",
              marginBottom: 8,
            }}
          />

          <div style={{ textAlign: "right", marginBottom: 20 }}>
            <a
              href={`https://${shopDomain}/account/recover`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: "#555", textDecoration: "none" }}
            >
              Forgot password / No account yet?
            </a>
          </div>

          <button
            type="submit"
            style={{
              width: "100%",
              padding: "12px 20px",
              background: "#000",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sign In
          </button>
        </Form>
      </div>
    </div>
  );
}
