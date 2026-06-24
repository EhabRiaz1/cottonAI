import { useState } from "react";
import { supabase } from "./lib/supabase";

type Mode = "signin" | "signup";

function AuthView() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) {
          setError(err.message);
        }
      } else {
        const { error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (err) {
          setError(err.message);
        } else {
          setError("Check your email to confirm, then sign in.");
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">
          Cotton <em>AI</em>
        </h1>
        <p className="auth-sub">
          {mode === "signin" ? "Sign in to continue" : "Create an account"}
        </p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pass">Password</label>
          <div style={{ position: "relative" }}>
            <input
              id="pass"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
              style={{ width: "100%", paddingRight: 56, boxSizing: "border-box" }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              style={{
                position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", fontSize: 12,
                color: "var(--gold-bright, #dbbd84)", padding: 4,
              }}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="auth-actions">
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading
              ? "Please wait…"
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setMode((m) => (m === "signin" ? "signup" : "signin"));
              setError(null);
            }}
          >
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default AuthView;
