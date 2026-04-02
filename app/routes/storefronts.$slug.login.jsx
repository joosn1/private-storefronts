import prisma from "../db.server";
import bcrypt from "bcryptjs";
import {
  getSessionCookie,
  buildSetCookieHeader,
  customerCookieName,
  SESSION_MAX_AGE,
} from "../utils/session.server";

// ─── Resource route — raw HTML, no React hydration ───────────────────────────

export const loader = async ({ request, params }) => {
  const { slug } = params;
  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront || !storefront.isActive) {
    return new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || storefront.shopDomain;
  const proxyBase = `https://${shop}/apps/storefronts/${slug}`;

  if (!storefront.requireLogin) {
    return new Response(null, { status: 302, headers: { Location: proxyBase } });
  }

  const customerId = getSessionCookie(request, customerCookieName(slug));
  if (customerId) {
    const customer = await prisma.storefrontCustomer.findFirst({
      where: { id: customerId, storefrontId: storefront.id, isActive: true },
    });
    if (customer) {
      return new Response(null, { status: 302, headers: { Location: proxyBase } });
    }
  }

  return new Response(buildLoginHtml(storefront, proxyBase, null), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

export const action = async ({ request, params }) => {
  const { slug } = params;
  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront || !storefront.isActive || !storefront.requireLogin) {
    return new Response("Invalid request", { status: 400 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || storefront.shopDomain;
  const proxyBase = `https://${shop}/apps/storefronts/${slug}`;

  const formData = await request.formData();
  const email = formData.get("email")?.trim().toLowerCase();
  const password = formData.get("password");

  if (!email || !password) {
    return new Response(buildLoginHtml(storefront, proxyBase, "Email and password are required."), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const customer = await prisma.storefrontCustomer.findFirst({
    where: { storefrontId: storefront.id, email, isActive: true },
  });

  if (!customer || !(await bcrypt.compare(password, customer.passwordHash))) {
    return new Response(buildLoginHtml(storefront, proxyBase, "Invalid email or password."), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const cookieHeader = buildSetCookieHeader(customerCookieName(slug), customer.id, {
    maxAge: SESSION_MAX_AGE,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: proxyBase, "Set-Cookie": cookieHeader },
  });
};

// ─── HTML ─────────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getContrastColor(hex) {
  try {
    const h = (hex || "#000000").replace("#", "");
    const lum = (0.299 * parseInt(h.slice(0,2),16) + 0.587 * parseInt(h.slice(2,4),16) + 0.114 * parseInt(h.slice(4,6),16)) / 255;
    return lum > 0.5 ? "#000000" : "#ffffff";
  } catch { return "#ffffff"; }
}

function buildLoginHtml(storefront, proxyBase, error) {
  const accent = storefront.primaryColor || "#000000";
  const contrast = getContrastColor(accent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(storefront.name)} — Sign In</title>
  <style>*,*::before,*::after{box-sizing:border-box;}body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#f5f5f5;}input{outline:none;}</style>
</head>
<body>
  <header style="background:${accent};color:${contrast};padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;">
    ${storefront.logoUrl ? `<img src="${esc(storefront.logoUrl)}" alt="${esc(storefront.name)}" style="height:40px;object-fit:contain;">` : ""}
    <div>
      <div style="font-weight:700;font-size:1.25rem;">${esc(storefront.name)}</div>
      <div style="font-size:.875rem;opacity:.85;">${esc(storefront.companyName)}</div>
    </div>
  </header>
  <main style="max-width:480px;margin:3rem auto;padding:0 1rem;">
    <div style="background:white;border-radius:10px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <h2 style="margin:0 0 .5rem;font-size:1.375rem;font-weight:700;">Sign In</h2>
      <p style="margin:0 0 1.5rem;color:#555;font-size:.9rem;">Sign in to access this private storefront.</p>
      ${error ? `<div style="background:#fff0f0;border:1px solid #ffcccc;border-radius:6px;padding:.75rem 1rem;margin-bottom:1rem;color:#cc0000;font-size:.9rem;">${esc(error)}</div>` : ""}
      <form method="post" action="${esc(proxyBase)}/login">
        <div style="margin-bottom:1rem;">
          <label for="email" style="display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem;">Email Address</label>
          <input id="email" name="email" type="email" required autofocus autocomplete="email"
            style="width:100%;padding:.75rem;border:1px solid #ddd;border-radius:6px;font-size:1rem;"
            onfocus="this.style.borderColor='${accent}'" onblur="this.style.borderColor='#ddd'">
        </div>
        <div style="margin-bottom:1.5rem;">
          <label for="password" style="display:block;font-weight:600;margin-bottom:.4rem;font-size:.9rem;">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password"
            style="width:100%;padding:.75rem;border:1px solid #ddd;border-radius:6px;font-size:1rem;"
            onfocus="this.style.borderColor='${accent}'" onblur="this.style.borderColor='#ddd'">
        </div>
        <button type="submit" style="width:100%;padding:.875rem;background:${accent};color:${contrast};border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer;">
          Sign In
        </button>
      </form>
    </div>
  </main>
</body>
</html>`;
}
