import { useActionData, useLoaderData } from "react-router";
import prisma from "../db.server";
import bcrypt from "bcryptjs";
import {
  getSessionCookie,
  buildSetCookieHeader,
  passwordCookieName,
  SESSION_MAX_AGE,
} from "../utils/session.server";

// ─── Server ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { slug } = params;

  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront || !storefront.isActive) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || storefront.shopDomain;
  const proxyBase = `https://${shop}/apps/storefronts/${slug}`;

  if (!storefront.password) {
    throw new Response(null, {
      status: 302,
      headers: { Location: proxyBase },
    });
  }

  const verified = getSessionCookie(request, passwordCookieName(slug));
  if (verified) {
    throw new Response(null, {
      status: 302,
      headers: { Location: proxyBase },
    });
  }

  return {
    storefront: {
      name: storefront.name,
      companyName: storefront.companyName,
      logoUrl: storefront.logoUrl,
      primaryColor: storefront.primaryColor,
    },
    proxyBase,
  };
};

export const action = async ({ request, params }) => {
  const { slug } = params;

  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront || !storefront.isActive || !storefront.password) {
    return { error: "Invalid request" };
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || storefront.shopDomain;
  const proxyBase = `https://${shop}/apps/storefronts/${slug}`;

  const formData = await request.formData();
  const password = formData.get("password");

  if (!password) {
    return { error: "Please enter the password.", proxyBase };
  }

  const isValid = await bcrypt.compare(password, storefront.password);

  if (!isValid) {
    return { error: "Incorrect password. Please try again.", proxyBase };
  }

  const cookieName = passwordCookieName(slug);
  const cookieHeader = buildSetCookieHeader(cookieName, "1", {
    maxAge: SESSION_MAX_AGE,
  });

  throw new Response(null, {
    status: 302,
    headers: {
      Location: proxyBase,
      "Set-Cookie": cookieHeader,
    },
  });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProxyStorefrontAuth() {
  const { storefront } = useLoaderData();
  const actionData = useActionData();
  const accentColor = storefront.primaryColor;

  return (
    <div
      style={{
        background: "white",
        borderRadius: "10px",
        padding: "2rem",
        boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
      }}
    >
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.375rem", fontWeight: 700 }}>
        Enter Password
      </h2>
      <p style={{ margin: "0 0 1.5rem", color: "#555", fontSize: "0.9rem" }}>
        This storefront is password-protected. Please enter the password to
        continue.
      </p>

      {actionData?.error && (
        <div
          style={{
            background: "#fff0f0",
            border: "1px solid #ffcccc",
            borderRadius: "6px",
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
            color: "#cc0000",
            fontSize: "0.9rem",
          }}
        >
          {actionData.error}
        </div>
      )}

      <form method="post">
        <div style={{ marginBottom: "1rem" }}>
          <label
            htmlFor="password"
            style={{ display: "block", fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.9rem" }}
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
            style={{
              width: "100%",
              padding: "0.75rem",
              border: "1px solid #ddd",
              borderRadius: "6px",
              fontSize: "1rem",
              outline: "none",
            }}
            onFocus={(e) => (e.target.style.borderColor = accentColor)}
            onBlur={(e) => (e.target.style.borderColor = "#ddd")}
          />
        </div>

        <button
          type="submit"
          style={{
            width: "100%",
            padding: "0.875rem",
            background: accentColor,
            color: getContrastColor(accentColor),
            border: "none",
            borderRadius: "6px",
            fontSize: "1rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Access Storefront
        </button>
      </form>
    </div>
  );
}

function getContrastColor(hex) {
  try {
    const h = (hex || "#000000").replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? "#000000" : "#ffffff";
  } catch {
    return "#ffffff";
  }
}
