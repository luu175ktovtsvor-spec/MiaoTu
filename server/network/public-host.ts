import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'

// Preserve the public-fetch policy in one place. Node handles address parsing
// and CIDR membership, including expanded/compressed IPv6 spellings.
const blockedIPv4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blockedIPv4.addSubnet(address, prefix, 'ipv4')

const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')
const blockedIPv6 = new BlockList()
blockedIPv6.addSubnet('2001:db8::', 32, 'ipv6')

export function privateHost(hostname: string) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const family = isIP(host)
  if (family === 4) return blockedIPv4.check(host, 'ipv4')
  if (family === 6) return !globalIPv6.check(host, 'ipv6') || blockedIPv6.check(host, 'ipv6')
  // Domain names are checked again using every DNS address before connecting.
  return host.includes(':')
}

// Validate every address, then let the caller pin this exact set when opening
// the socket. Checking only the URL hostname leaves DNS rebinding possible.
export async function publicAddresses(hostname: string, { signal, lookupImpl = lookup, denied = '这个地址不允许抓取', unresolved = '这个地址无法解析，已中止抓取' }: Record<string, any> = {}) {
  const reject = message => Object.assign(new Error(message), { status: 422 })
  signal?.throwIfAborted()
  if (privateHost(hostname)) throw reject(denied)
  try {
    const addresses = await awaitWithContext<LookupAddress[]>(lookupImpl(hostname, { all: true }), signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT)
    signal?.throwIfAborted()
    if (!addresses.length || addresses.some(address => privateHost(address.address))) throw reject(denied)
    return addresses
  } catch (error) {
    signal?.throwIfAborted()
    if (error?.status) throw error
    throw reject(unresolved)
  }
}
