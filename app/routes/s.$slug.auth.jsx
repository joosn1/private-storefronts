import { useEffect, useState } from "react";
import { redirect, useFetcher, useParams } from "react-router";
import prisma from "../db.server";
import {
  getSessionCookie,
  buildSetCookieHeader,
  passwordCookieName,
  hashStorefrontPassword,
  SESSION_MAX_AGE,
} from "../utils/session.server";

export const loader = async ({ request, params }) => {
  const { slug } = params;
  const verified = getSessionCookie(request, passwordCookieName(slug));
  if (verified === "verified") return redirect(`/s/${slug}`);
  return { slug };
};

export const action = async ({ request, params }) => {
  const { slug } = params;

  let password;
  try {
    const formData = await request.formData();
    password = String(formData.get("password") || "");
  } catch {
    return { error: "Could not read form data. Please try again." };
  }

  if (!password) {
    return { error: "Please enter the password." };
  }

  let storefront;
  try {
    storefront = await prisma.storefront.findUnique({ where: { slug } });
  } catch {
    return { error: "Something went wrong. Please try again." };
  }

  if (!storefront?.password) return redirect(`/s/${slug}`);

  const valid = hashStorefrontPassword(password) === storefront.password;
  if (!valid) {
    return { error: "Incorrect password. Please try again." };
  }

  return redirect(`/s/${slug}`, {
    headers: {
      "Set-Cookie": buildSetCookieHeader(passwordCookieName(slug), "verified", {
        maxAge: SESSION_MAX_AGE,
      }),
    },
  });
};

export default function StorefrontAuth() {
  const { slug } = useParams();
  const fetcher = useFetcher();
  const [error, setError] = useState(null);

  // Pick up error from the action response
  useEffect(() => {
    if (fetcher.data?.error) {
      setError(fetcher.data.error);
    }
  }, [fetcher.data]);

  const isSubmitting = fetcher.state !== "idle";

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
          Password Protected
        </h2>
        <p style={{ color: "#666", margin: "0 0 24px", fontSize: 14 }}>
          Enter the password to access this storefront.
        </p>

        {/* Error banner — shown whenever error state is set */}
        {error && (
          <div
            style={{
              background: "#fee2e2",
              border: "1px solid #fca5a5",
              color: "#b91c1c",
              padding: "12px 16px",
              borderRadius: 6,
              marginBottom: 20,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            {error}
          </div>
        )}

        {/* Use fetcher.Form with an explicit action so the parent layout's
            action (which expects JSON) never intercepts this POST */}
        <fetcher.Form
          method="post"
          action={`/s/${slug}/auth`}
          onSubmit={() => setError(null)}
        >
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
            autoFocus
            required
            style={{
              width: "100%",
              padding: "10px 14px",
              border: error ? "1px solid #fca5a5" : "1px solid #ddd",
              borderRadius: 6,
              fontSize: 15,
              boxSizing: "border-box",
              marginBottom: 16,
            }}
          />
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              width: "100%",
              padding: "12px 20px",
              background: isSubmitting ? "#555" : "#000",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 15,
              fontWeight: 600,
              cursor: isSubmitting ? "not-allowed" : "pointer",
            }}
          >
            {isSubmitting ? "Checking..." : "Enter Storefront"}
          </button>
        </fetcher.Form>
      </div>
    </div>
  );
}
