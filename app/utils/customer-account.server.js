import crypto from "crypto";
import { adminGraphQL } from "./admin-api.server";

/**
 * Generate a PKCE code_verifier and code_challenge pair.
 * verifier is stored in a cookie; challenge is sent to Shopify.
 */
export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/**
 * Fetch the shop's numeric ID (e.g. "12345678") from the Admin API.
 * Cached in memory per domain for the lifetime of the process.
 */
const shopIdCache = new Map();

export async function getShopNumericId(shopDomain) {
  if (shopIdCache.has(shopDomain)) return shopIdCache.get(shopDomain);
  const { data } = await adminGraphQL(shopDomain, `{ shop { id } }`);
  const id = data?.shop?.id?.split("/").pop();
  if (!id) throw new Error(`Could not determine shop ID for ${shopDomain}`);
  shopIdCache.set(shopDomain, id);
  return id;
}

/**
 * Build the Shopify Customer Account API OAuth authorization URL.
 */
export function buildAuthUrl({ shopId, clientId, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://shopify.com/authentication/${shopId}/oauth/authorize?${params}`;
}

/**
 * Exchange an authorization code for tokens via the Customer Account API.
 * Returns the full token response JSON (includes id_token, access_token, etc.).
 */
export async function exchangeCodeForToken({
  shopId,
  clientId,
  redirectUri,
  code,
  verifier,
}) {
  const res = await fetch(
    `https://shopify.com/authentication/${shopId}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Decode a JWT payload without signature verification.
 * Safe to use after Shopify has already authenticated — we only read
 * the claims, we don't use them to make security decisions beyond
 * checking the email against our own whitelist.
 */
export function decodeJwtPayload(token) {
  const [, payload] = (token || "").split(".");
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
