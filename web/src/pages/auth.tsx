import { useState, type FormEvent } from "react"
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { Field, Logo } from "../components/ui"

function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { user, refresh } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [form, setForm] = useState({ name: "", email: "", password: "" })
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  if (user) return <Navigate to={(loc.state as { from?: string })?.from ?? "/"} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(`/api/auth/${mode}`, { method: "POST", body: mode === "login" ? { email: form.email, password: form.password } : form })
      await refresh()
      nav((loc.state as { from?: string })?.from ?? "/", { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Something went wrong"))
    } finally {
      setBusy(false)
    }
  }
  const f = error?.fields ?? {}
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand"><Logo size={28} /> Pingwell</div>
        <div className="card">
          <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
          <p className="muted small" style={{ marginBottom: 20 }}>
            {mode === "login" ? "Welcome back." : "Start monitoring your sites in under a minute."}
          </p>
          <form className="form" onSubmit={submit} noValidate>
            {error && !Object.keys(f).length && <div className="alert" role="alert">{error.message}</div>}
            {mode === "register" && (
              <Field label="Name" htmlFor="name" error={f.name}>
                <input id="name" className="input" autoComplete="name" value={form.name} onChange={set("name")} aria-invalid={!!f.name} required />
              </Field>
            )}
            <Field label="Email" htmlFor="email" error={f.email}>
              <input id="email" type="email" className="input" autoComplete="email" value={form.email} onChange={set("email")} aria-invalid={!!f.email} required />
            </Field>
            <Field label="Password" htmlFor="password" error={f.password} hint={mode === "register" ? "At least 10 characters" : undefined}>
              <input id="password" type="password" className="input" autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={set("password")} aria-invalid={!!f.password} required />
            </Field>
            <button className="btn btn-primary" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
          </form>
        </div>
        <p className="auth-foot">
          {mode === "login" ? <>New to Pingwell? <Link to="/register">Create an account</Link></> : <>Already have an account? <Link to="/login">Sign in</Link></>}
        </p>
      </div>
    </div>
  )
}

export const Login = () => <AuthForm mode="login" />
export const Register = () => <AuthForm mode="register" />
