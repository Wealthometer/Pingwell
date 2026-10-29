import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createContext, useContext, type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { api, ApiError, type User } from "./api"

type AuthValue = { user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>("/api/auth/me")).user
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
  })
  const value: AuthValue = {
    user: me.data ?? null,
    loading: me.isLoading,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] })
    },
    logout: async () => {
      await api("/api/auth/logout", { method: "POST" })
      qc.clear()
      qc.setQueryData(["me"], null)
    },
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const v = useContext(AuthContext)
  if (!v) throw new Error("useAuth outside AuthProvider")
  return v
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const loc = useLocation()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  return <>{children}</>
}
