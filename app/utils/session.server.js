import crypto from "crypto";

function getSecret() {
  return process.env.SESSION_SECRET || "fallback-dev-secret-change-in-prod";
}

/**
 * Sign a value using HMAC-SHA256.
 */
function signValue(value) {
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(String(value))
    .digest("base64url");
  return `${value}.${sig}`;
}

/**
 * Verify and extract the original value from a signed string.
 * Returns null if signature is invalid.
 */
function unsignValue(signed) {
  if (!signed || typeof signed !== "string") return null;
  const lastDot = signed.lastIndexOf(".");
  if (lastDot === -1) return null;
  const value = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(value)
    .digest("base64url");
  try {
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return value;
}

/**
 * Parse the Cookie header into a key-value object.
 */
export function parseCookies(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((c) => {
        const idx = c.indexOf("=");
        if (idx === -1) return null;
        const key = c.slice(0, idx).trim();
        const val = c.slice(idx + 1).trim();
        try {
          return [key, decodeURIComponent(val)];
        } catch {
          return [key, val];
        }
      })
      .filter(Boolean),
  );
}

/**
 * Read a signed session cookie value. Returns null if missing or invalid.
 */
export function getSessionCookie(request, name) {
  const cookies = parseCookies(request);
  const signed = cookies[name];
  if (!signed) return null;
  return unsignValue(signed);
}

/**
 * Build a Set-Cookie header string for a signed session cookie.
 */
export function buildSetCookieHeader(name, value, options = {}) {
  const signedValue = signValue(value);
  const parts = [`${name}=${encodeURIComponent(signedValue)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.secure || process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Build a Set-Cookie header that clears a cookie.
 */
export function buildClearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Cookie name helpers for public storefront auth.
 * Password-verified cookie: set when a visitor enters the correct storefront password.
 * Customer session cookie: set when a registered customer logs in.
 */
export function passwordCookieName(slug) {
  return `psf_pw_${slug}`;
}

export function customerCookieName(slug) {
  return `psf_cid_${slug}`;
}

/** 30-day session expiry in seconds */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

