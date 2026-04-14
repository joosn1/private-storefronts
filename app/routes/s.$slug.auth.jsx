import { redirect } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import {
  getSessionCookie,
  buildSetCookieHeader,
  passwordCookieName,
  SESSION_MAX_AGE,
} from "../utils/session.server";

export const loader = async ({ request, params }) => {
  const { slug } = params;
  const url = new URL(request.url);

  // Already verified — send straight to the storefront
  const verified = getSessionCookie(request, passwordCookieName(slug));
  if (verified === "verified") return redirect(`/s/${slug}`);

  // Error from a previous failed attempt (passed via query param)
  const errorCode = url.searchParams.get("error");
  const error =
    errorCode === "wrong"
      ? "Incorrect password. Please try again."
      : errorCode === "empty"
      ? "Please enter the password."
      : null;

  return { slug, error };
};

// The action ALWAYS returns a redirect — never an inline response.
// This ensures the browser handles every response natively, including
// the Set-Cookie header on success, without any React Router fetch
// interception that could prevent the cookie from being stored.
export const action = async ({ request, params }) => {
  const { slug } = params;

  let password = "";
  try {
    const formData = await request.formData();
    password = String(formData.get("password") || "").trim();
  } catch {
    return redirect(`/s/${slug}/auth?error=wrong`);
  }

  if (!password) {
    return redirect(`/s/${slug}/auth?error=empty`);
  }

  let storefront;
  try {
    storefront = await prisma.storefront.findUnique({ where: { slug } });
  } catch {
    return redirect(`/s/${slug}/auth?error=wrong`);
  }

  // If no password is set on this storefront, let them through
  if (!storefront?.password) {
    console.log(`[auth] ${slug}: no password set, allowing through`);
    return redirect(`/s/${slug}`);
  }

  const stored = storefront.password.trim();
  const match = password === stored;
  console.log(`[auth] ${slug}: entered="${password}" stored="${stored}" match=${match}`);

  if (!match) {
    return redirect(`/s/${slug}/auth?error=wrong`);
  }

  // Correct password — set a signed cookie and send to the storefront
  return redirect(`/s/${slug}`, {
    headers: {
      "Set-Cookie": buildSetCookieHeader(passwordCookieName(slug), "verified", {
        maxAge: SESSION_MAX_AGE,
      }),
    },
  });
};

export default function StorefrontAuth() {
  const { slug, error } = useLoaderData();

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

        {/*
          Native <form> — NOT React Router's <Form>.
          The browser handles the POST and the subsequent redirect
          entirely on its own, so Set-Cookie is always applied before
          the next request is made.
        */}
        <form method="post" action={`/s/${slug}/auth`}>
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
            Enter Storefront
          </button>
        </form>
      </div>
    </div>
  );
}
