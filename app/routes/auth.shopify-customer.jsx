import { redirect } from "react-router";
import prisma from "../db.server";
import {
  exchangeCodeForToken,
  decodeJwtPayload,
} from "../utils/customer-account.server";
import {
  getSessionCookie,
  buildSetCookieHeader,
  buildClearCookieHeader,
  customerCookieName,
  SESSION_MAX_AGE,
} from "../utils/session.server";

/**
 * GET /auth/shopify-customer
 *
 * OAuth callback for the Shopify Customer Account API.
 * Shopify redirects here after the customer authenticates.
 *
 * Expected query params: code, state
 * state format: "{nonce}|{slug}"
 *
 * IMPORTANT: Register this URL as an allowed redirect URI in your
 * Shopify Partner Dashboard under the Customer Account API settings.
 * Redirect URI: https://your-app.railway.app/auth/shopify-customer
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing required parameters", { status: 400 });
  }

  // Parse state → nonce + slug
  const pipeIdx = state.indexOf("|");
  if (pipeIdx === -1) return new Response("Invalid state parameter", { status: 400 });
  const nonce = state.slice(0, pipeIdx);
  const slug = state.slice(pipeIdx + 1);

  if (!slug) return new Response("Invalid state parameter", { status: 400 });

  // Read and verify the PKCE cookie set before the OAuth redirect
  const oauthCookieName = `psf_oauth_${slug}`;
  const cookieJson = getSessionCookie(request, oauthCookieName);
  if (!cookieJson) {
    // Cookie expired or was never set
    return redirect(`/s/${slug}/login?error=state_mismatch`);
  }

  let oauthData;
  try {
    oauthData = JSON.parse(cookieJson);
  } catch {
    return redirect(`/s/${slug}/login?error=state_mismatch`);
  }

  // Verify the nonce and slug haven't been tampered with
  if (oauthData.nonce !== nonce || oauthData.slug !== slug) {
    return redirect(`/s/${slug}/login?error=state_mismatch`);
  }

  // Exchange the authorization code for tokens
  let tokens;
  try {
    tokens = await exchangeCodeForToken({
      shopId: oauthData.shopId,
      clientId: process.env.SHOPIFY_API_KEY,
      redirectUri: oauthData.redirectUri,
      code,
      verifier: oauthData.verifier,
    });
  } catch (err) {
    console.error("Customer Account token exchange failed:", err);
    return redirect(`/s/${slug}/login?error=auth_failed`);
  }

  // Decode the ID token (JWT) to read the customer's identity claims
  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims?.email) {
    console.error("No email claim in Customer Account id_token:", claims);
    return redirect(`/s/${slug}/login?error=no_email`);
  }

  const email = claims.email.toLowerCase();

  // Load storefront + active customer list
  const storefront = await prisma.storefront.findUnique({
    where: { slug },
    include: {
      customers: {
        where: { isActive: true },
        select: { email: true },
      },
    },
  });

  if (!storefront) return redirect(`/s/${slug}/login?error=auth_failed`);

  // If the storefront has a customer whitelist, enforce it.
  // If no customers are configured, any authenticated Shopify customer gets access.
  if (storefront.customers.length > 0) {
    const allowed = storefront.customers.some(
      (c) => c.email.toLowerCase() === email,
    );
    if (!allowed) {
      return redirect(`/s/${slug}/login?error=not_authorized`);
    }
  }

  // Use the Shopify customer subject (stable GID) as the session identifier
  const sessionId = claims.sub || email;

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    buildSetCookieHeader(customerCookieName(slug), sessionId, {
      maxAge: SESSION_MAX_AGE,
    }),
  );
  // Clear the temporary PKCE cookie
  headers.append("Set-Cookie", buildClearCookieHeader(oauthCookieName));

  return redirect(`/s/${slug}`, { headers });
};
