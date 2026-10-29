import { useQuery } from "@tanstack/react-query"
import { NavLink, Outlet, Link } from "react-router-dom"
import { api, type Incident, type SystemStatus } from "../api"
import { useAuth } from "../auth"
import { Dot, Logo } from "./ui"

export function Layout() {
  const { user, logout } = useAuth()
  const open = useQuery({
    queryKey: ["incidents", "open"],
    queryFn: () => api<{ incidents: Incident[] }>("/api/incidents?status=open"),
    refetchInterval: 15_000,
  })
  const system = useQuery({ queryKey: ["system"], queryFn: () => api<SystemStatus>("/api/system"), refetchInterval: 20_000 })
  const openCount = open.data?.incidents.length ?? 0
  const verdict = system.data?.verdict

  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" className="brand"><Logo /> Pingwell</Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>Monitors</NavLink>
          <NavLink to="/incidents">
            Incidents {openCount > 0 && <span className="count" aria-label={`${openCount} open`}>{openCount}</span>}
          </NavLink>
          <NavLink to="/status-pages">Status pages</NavLink>
          <NavLink to="/channels">Alert channels</NavLink>
        </nav>
        <div className="side-foot">
          <Link to="/system" className="sys-pill" title="Health of Pingwell itself">
            <Dot tone={verdict === "healthy" ? "up" : verdict === "degraded" ? "slow" : verdict === "down" ? "down" : "idle"} label={verdict ?? "unknown"} />
            {verdict === "healthy" ? "Checks running" : verdict === "degraded" ? "Checks degraded" : verdict === "down" ? "Checks stopped" : "System"}
          </Link>
          <div className="side-user">
            <span className="truncate">{user?.name}</span>
            <button onClick={() => void logout()}>Sign out</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
