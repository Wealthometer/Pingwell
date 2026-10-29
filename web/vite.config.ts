import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// In development the API runs on :4000; proxying keeps the session cookie same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
})
