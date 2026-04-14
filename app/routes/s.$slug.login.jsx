import crypto from "crypto";
import { redirect } from "react-router";
import { Link, useLoaderData } from "react-router";
import prisma from "../db.server";
import {
  generatePKCE,
  getShopNumericId,
  buildAuthUrl,
} from "../utils/customer-account.server";
import {
  getSessionCookie,
  buildSetCookieHeader,
  customerCookieName,
} from "../utils/session.server";

const ERROR_MESSAGES = {
  not_authorized:
    "Your Shopify account is not authorized to access this storefront. Please contact the store owner.",
  auth_failed: "Authentication failed. Please try again.",
  no_email:
    "Your Shopify account did not return an email address. Please try again.",
  state_mismatch: "Your sign-in session expired. Please try again.",
  no_client_id:
    "Storefront sign-in is not configured yet. Please contact the store owner.",
};

export const loader = async ({ request, params }) => {
  const { slug } = params;
  const url = new URL(request.url);
  const errorCode = url.searchParams.get("error");

  // Already authenticated — send to the storefront
  const customerId = getSessionCookie(request, customerCookieName(slug));
  if (customerId) return redirect(`/s/${slug}`);

  // Show error page if Shopify returned an error
  if (errorCode) {
    return {
      error: ERROR_MESSAGES[errorCode] ?? "Authentication failed. Please try again.",
      slug,
    };
  }

  // Load storefront
  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront) throw new Response("Not Found", { status: 404 });

  // The Customer Account API client ID must be set in the environment.
  // Find it in: Shopify Admin → Settings → Customer accounts
  const clientId = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
  if (!clientId) {
    console.error(
      "SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID is not set. " +
        "Get it from Shopify Admin → Settings → Customer accounts.",
    );
    return { error: ERROR_MESSAGES.no_client_id, slug };
  }

  // Build PKCE + nonce
  const { verifier, challenge } = generatePKCE();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const state = `${nonce}|${slug}`;

  // Get the shop's numeric ID for the OAuth URL
  let shopId;
  try {
    shopId = await getShopNumericId(storefront.shopDomain);
  } catch (err) {
    console.error("Failed to get shop ID:", err);
    return { error: "Unable to initiate sign-in. Please try again later.", slug };
  }

  const redirectUri = `${process.env.SHOPIFY_APP_URL}/auth/shopify-customer`;

  const authUrl = buildAuthUrl({
    shopId,
    clientId,
    redirectUri,
    challenge,
    state,
  });

  // Store the PKCE verifier + nonce in a short-lived signed cookie
  const oauthState = JSON.stringify({
    verifier,
    nonce,
    shopId,
    slug,
    redirectUri,
  });

  return redirect(authUrl, {
    headers: {
      "Set-Cookie": buildSetCookieHeader(`psf_oauth_${slug}`, oauthState, {
        maxAge: 600, // 10 minutes
      }),
    },
  });
};

// Only renders if the loader returns an error instead of redirecting
export default function StorefrontLogin() {
  const data = useLoaderData();

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
          maxWidth: 420,
          textAlign: "center",
        }}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 700 }}>
          Sign In Required
        </h2>
        <p
          style={{
            color: "#c00",
            margin: "0 0 24px",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {data?.error}
        </p>
        <Link
          to={`/s/${data?.slug}/login`}
          style={{
            display: "inline-block",
            padding: "12px 28px",
            background: "#000",
            color: "#fff",
            borderRadius: 6,
            fontSize: 15,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Try Again
        </Link>
      </div>
    </div>
  );
}
