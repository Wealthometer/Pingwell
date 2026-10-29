import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import { BlockList, isIP } from "node:net"

/**
 * SSRF protection. Users submit arbitrary URLs and the worker fetches them from inside your
 * network, so a public deployment must refuse loopback, private, link-local (incl. the cloud
 * metadata endpoint 169.254.169.254), CGNAT, multicast and reserved ranges.
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4")
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const) blocked.addSubnet(net, prefix, "ipv6")

function mappedToIPv4(ip: string): string | null {
  const s = ip.toLowerCase()
  const dotted = s.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted?.[1]) return dotted[1]
  const hex = s.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return null
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return blocked.check(ip, "ipv4")
  if (family === 6) {
    // IPv4-mapped IPv6 must be judged as IPv4, in dotted (::ffff:10.0.0.1) or hex (::ffff:a00:1) form.
    const v4 = mappedToIPv4(ip)
    if (v4) return blocked.check(v4, "ipv4")
    return blocked.check(ip, "ipv6")
  }
  return true // not an IP at all: refuse
}

export class BlockedTargetError extends Error {
  constructor(host: string) {
    super(`Refusing to connect to private or reserved address (${host})`)
    this.name = "BlockedTargetError"
  }
}

/** Validates a URL before any connection is made. IP-literal hosts never hit DNS, so check them here. */
export function assertAllowedUrl(raw: string, allowPrivate: boolean): URL {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be monitored")
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed; use a header instead")
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (!allowPrivate) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new BlockedTargetError(host)
    if (isIP(host) && isPrivateAddress(host)) throw new BlockedTargetError(host)
  }
  return url
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * A dns.lookup replacement for undici's connector. It resolves the name, then rejects private
 * results. Checking at connect time (not before) defeats DNS-rebinding tricks.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean } & Record<string, unknown>, cb: LookupCb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, [])
      const list = addresses as LookupAddress[]
      const bad = !allowPrivate && list.find((a) => isPrivateAddress(a.address))
      if (bad) return cb(Object.assign(new BlockedTargetError(`${hostname} → ${bad.address}`), { code: "EBLOCKED" }), [])
      if (options.all) return cb(null, list)
      const first = list[0]
      if (!first) return cb(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), [])
      cb(null, first.address, first.family)
    })
  }
}
