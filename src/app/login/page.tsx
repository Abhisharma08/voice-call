"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      router.replace(params.get("next") ?? "/dashboard");
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Sign-in failed");
    setBusy(false);
  }

  return (
    <form className="card login-card stack" onSubmit={onSubmit}>
      <div>
        <h1 className="page-title">Sign in</h1>
        <p className="page-sub">Agency staff only. Clients do not have platform access.</p>
      </div>

      <div>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <button type="submit" disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="login-wrap">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
