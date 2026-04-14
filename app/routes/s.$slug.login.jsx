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
  auth_failed:
    "Authentication failed. Please try again.",
  no_email:
    "Your Shopify account did not provide an email address. Please try again.",
  state_mismatch:
    "Your sign-in session expired. Please try again.",
};

export const loader = async ({ request, params }) => {
  const { slug } = params;
  const url = new URL(request.url);
  const errorCode = url.searchParams.get("error");

  // Already authenticated — send straight to the storefront
  const customerId = getSessionCookie(request, customerCookieName(slug));
  if (customerId) return redirect(`/s/${slug}`);

  // Return error data so the component can display it
  if (errorCode) {
    return {
      error: ERROR_MESSAGES[errorCode] ?? "Authentication failed. Please try again.",
      slug,
    };
  }

  // Load storefront to get the shop domain
  const storefront = await prisma.storefront.findUnique({ where: { slug } });
  if (!storefront) throw new Response("Not Found", { status: 404 });

  // Build PKCE + nonce
  const { verifier, challenge } = generatePKCE();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const state = `${nonce}|${slug}`;

  // Fetch the shop's numeric ID (needed for the Customer Account API URL)
  let shopId;
  try {
    shopId = await getShopNumericId(storefront.shopDomain);
  } catch (err) {
    console.error("Failed to get shop ID for Customer Account OAuth:", err);
    return {
      error: "Unable to initiate sign-in right now. Please try again later.",
      slug,
    };
  }

  const redirectUri = `${process.env.SHOPIFY_APP_URL}/auth/shopify-customer`;

  const authUrl = buildAuthUrl({
    shopId,
    clientId: process.env.SHOPIFY_API_KEY,
    redirectUri,
    challenge,
    state,
  });

  // Persist the verifier + nonce in a short-lived signed cookie so the
  // callback route can verify the round-trip.
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

// The component only renders when the loader returns an error (not a redirect).
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
