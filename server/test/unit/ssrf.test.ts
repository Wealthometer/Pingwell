import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { signPayload } from "../../src/alerts/senders.js"
import { assertAllowedUrl, isPrivateAddress } from "../../src/monitoring/ssrf.js"

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:a00:1", "::ffff:7f00:1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true))

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  )

  it("treats non-IP strings as unsafe", () => expect(isPrivateAddress("example.com")).toBe(true))
})

describe("assertAllowedUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(assertAllowedUrl("https://example.com/health", false).hostname).toBe("example.com")
  })
  it.each([
    ["http://127.0.0.1/", /private or reserved/],
    ["http://[::1]:8080/", /private or reserved/],
    ["http://localhost:3000", /private or reserved/],
    ["http://metadata.google.internal/", /private or reserved/],
    ["http://169.254.169.254/latest/meta-data", /private or reserved/],
    ["ftp://example.com", /Only http and https/],
    ["file:///etc/passwd", /Only http and https/],
    ["https://user:pass@example.com", /embedded credentials/],
  ])("rejects %s", (url, msg) => expect(() => assertAllowedUrl(url, false)).toThrow(msg))

  it("allows private targets only when explicitly enabled", () => {
    expect(() => assertAllowedUrl("http://127.0.0.1:5000", true)).not.toThrow()
  })
})

describe("webhook signatures", () => {
  it("signs timestamp.body with HMAC-SHA256 so receivers can verify and reject replays", () => {
    const body = JSON.stringify({ event: "incident.opened" })
    const sig = signPayload("s3cret", body, 1_700_000_000)
    const expected = createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex")
    expect(sig).toBe(`t=1700000000,v1=${expected}`)
    expect(signPayload("other", body, 1_700_000_000)).not.toBe(sig)
  })
})
