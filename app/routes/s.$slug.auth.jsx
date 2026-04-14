import { redirect } from "react-router";
import { useActionData, Form } from "react-router";
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
  return {};
};

export const action = async ({ request, params }) => {
  const { slug } = params;
  const formData = await request.formData();
  const password = String(formData.get("password") || "");

  const storefront = await prisma.storefront.findUnique({ where: { slug } });
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
  const actionData = useActionData();

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
              border: "1px solid #ddd",
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
        </Form>
      </div>
    </div>
  );
}
