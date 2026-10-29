import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/600.css"
import "./styles.css"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Link, Route, Routes } from "react-router-dom"
import { ApiError } from "./api"
import { AuthProvider, RequireAuth } from "./auth"
import { Layout } from "./components/layout"
import { Empty } from "./components/ui"
import { Login, Register } from "./pages/auth"
import { Channels } from "./pages/channels"
import { IncidentDetail, Incidents } from "./pages/incidents"
import { MonitorDetail } from "./pages/monitor-detail"
import { MonitorForm } from "./pages/monitor-form"
import { Monitors } from "./pages/monitors"
import { PublicStatusPage } from "./pages/public-status"
import { StatusPageEditor, StatusPages } from "./pages/status-pages"
import { System } from "./pages/system"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
})

const NotFound = () => <Empty title="Page not found" action={<Link className="btn" to="/">Go to monitors</Link>}>The page you're looking for doesn't exist.</Empty>

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/s/:slug" element={<PublicStatusPage />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<Monitors />} />
              <Route path="monitors/new" element={<MonitorForm />} />
              <Route path="monitors/:id" element={<MonitorDetail />} />
              <Route path="monitors/:id/edit" element={<MonitorForm />} />
              <Route path="incidents" element={<Incidents />} />
              <Route path="incidents/:id" element={<IncidentDetail />} />
              <Route path="channels" element={<Channels />} />
              <Route path="status-pages" element={<StatusPages />} />
              <Route path="status-pages/new" element={<StatusPageEditor />} />
              <Route path="status-pages/:id" element={<StatusPageEditor />} />
              <Route path="system" element={<System />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
