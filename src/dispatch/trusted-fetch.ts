import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import { Readable } from 'node:stream'
import { UserError } from '../shared/errors.ts'

export interface TrustedFetchOptions {
  allowHosts: readonly string[]
  fetchImpl?: typeof fetch
  maxBytes?: number
  maxRedirects?: number
}

const DEFAULT_MAX_REDIRECTS = 3

function ipv4ToNum(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let n = 0
  for (const p of parts) {
    const o = Number(p)
    if (!Number.isInteger(o) || o < 0 || o > 255) return undefined
    n = (n << 8) + o
  }
  return n >>> 0
}

function parseIpv4MappedHexLower(lower: string): number | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower)
  if (!m) return undefined
  const hi = Number.parseInt(m[1]!, 16)
  const lo = Number.parseInt(m[2]!, 16)
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return undefined
  return ((hi & 0xffff) << 16) | (lo & 0xffff)
}

function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '0.0.0.0') return true
  if (lower === '127.0.0.1' || lower === '::1' || lower === '0:0:0:0:0:0:0:1' || lower === '::') return true

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower)
  if (mapped) return isPrivateIp(mapped[1]!)
  const mappedHex = parseIpv4MappedHexLower(lower)
  if (mappedHex !== undefined) {
    const a = (mappedHex >>> 24) & 0xff
    const b = (mappedHex >>> 16) & 0xff
    const c = (mappedHex >>> 8) & 0xff
    const d = mappedHex & 0xff
    return isPrivateIp(`${a}.${b}.${c}.${d}`)
  }

  if (net.isIPv4(ip)) {
    const n = ipv4ToNum(ip)
    if (n === undefined) return false
    if (((n & 0xff000000) >>> 0) === 0x00000000) return true // 0.0.0.0/8
    if (((n & 0xff000000) >>> 0) === 0x7f000000) return true // 127.0.0.0/8
    if (((n & 0xff000000) >>> 0) === 0x0a000000) return true // 10.0.0.0/8
    if (((n & 0xfff00000) >>> 0) === 0xac100000) return true // 172.16.0.0/12
    if (((n & 0xffff0000) >>> 0) === 0xc0a80000) return true // 192.168.0.0/16
    if (((n & 0xffff0000) >>> 0) === 0xa9fe0000) return true // 169.254.0.0/16 link-local
    return false
  }

  const firstHextet = lower.split(':', 1)[0] ?? ''
  if (/^fe[89ab][0-9a-f]$/.test(firstHextet) && (Number.parseInt(firstHextet, 16) & 0xffc0) === 0xfe80) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local fc00::/7
  return false
}

/** Strip IPv6 URL brackets so allowlist entries like `::ffff:7f00:1` match `[::ffff:7f00:1]`. */
function normalizeHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1)
  return hostname
}

function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = normalizeHostname(host).toLowerCase()
  return allowHosts.some(a => normalizeHostname(a).toLowerCase() === h)
}

async function validateRequestUrl(url: URL, allowHosts: readonly string[]): Promise<{ address: string; family: number }> {
  if (url.protocol !== 'https:') throw new UserError('trusted-fetch: only https:// allowed')
  if (url.username || url.password) throw new UserError('trusted-fetch: URL credentials refused')
  const host = normalizeHostname(url.hostname)
  if (!hostAllowed(host, allowHosts)) {
    throw new UserError(`trusted-fetch: host ${url.hostname} not in allowlist`)
  }
  const family = net.isIP(host)
  const addresses = family ? [{ address: host, family }] : await dns.lookup(host, { all: true })
  const selected = addresses[0]
  if (!selected) throw new UserError('trusted-fetch: host has no resolved addresses')
  for (const address of addresses) {
    if (isPrivateIp(address.address)) {
      throw new UserError(`trusted-fetch: ${host} resolves to blocked address ${address.address}`)
    }
  }
  return selected
}

interface ResponseBody {
  getReader(): {
    read(): Promise<{ done?: boolean; value?: Uint8Array }>
    cancel(): Promise<void>
    releaseLock(): void
  }
  cancel(): Promise<void>
}

interface HopResponse {
  status: number
  body: ResponseBody | null
  location: string | null | undefined
}

function requestPinned(
  url: URL,
  { address, family }: { address: string; family: number },
  signal: AbortSignal,
): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    // Preserve the original Host header and TLS identity. Disable connection
    // reuse and let only the validated address reach the socket.
    const lookup: net.LookupFunction = (_host, opts, callback) => {
      if (opts.all) callback(null, [{ address, family }])
      else callback(null, address, family)
    }
    const request = https.get(url, {
      agent: false,
      rejectUnauthorized: true,
      signal,
      lookup,
    }, response => {
      resolve({
        status: response.statusCode ?? 0,
        body: Readable.toWeb(response),
        location: response.headers.location,
      })
    })
    request.once('error', reject)
  })
}

async function readBody(body: HopResponse['body'], maxBytes: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let remaining = maxBytes
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read()
      if (done || !value) break
      const chunk = value.subarray(0, remaining)
      chunks.push(chunk)
      remaining -= chunk.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Host-side HTTPS fetch with SSRF protections. Not exposed to sandboxed bash.
 */
export async function trustedFetch(
  rawUrl: string,
  options: TrustedFetchOptions,
): Promise<{ url: string; body: string; fetchedAt: string }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UserError('trusted-fetch: invalid URL')
  }
  if (url.protocol === 'file:') throw new UserError('trusted-fetch: file:// refused')

  const max = options.maxBytes ?? 512_000
  if (!Number.isSafeInteger(max) || max < 0) throw new UserError('trusted-fetch: invalid byte limit')
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  let current = url.toString()
  let hops = 0

  while (true) {
    const parsed = new URL(current)
    const address = await validateRequestUrl(parsed, options.allowHosts)
    const signal = AbortSignal.timeout(30_000)
    let res: HopResponse
    if (options.fetchImpl) {
      const response = await options.fetchImpl(parsed.toString(), { method: 'GET', redirect: 'manual', signal })
      res = { status: response.status, body: response.body, location: response.headers.get('location') }
    } else {
      res = await requestPinned(parsed, address, signal)
    }

    if (res.status >= 200 && res.status < 300) {
      const body = await readBody(res.body, max)
      return { url: parsed.toString(), body, fetchedAt: new Date().toISOString() }
    }

    await res.body?.cancel().catch(() => undefined)
    if (res.status < 300 || res.status >= 400) throw new UserError(`trusted-fetch: HTTP ${res.status}`)
    if (!res.location) throw new UserError('trusted-fetch: redirect without Location')
    if (hops >= maxRedirects) throw new UserError('trusted-fetch: too many redirects')
    hops += 1
    current = new URL(res.location, parsed).toString()
  }
}
