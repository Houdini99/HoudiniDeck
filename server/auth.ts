// Access control. Devices pair with an access key (kept in their localStorage, never in cookies),
// so other websites can't ride on a paired browser's session. See README "Security".
import { timingSafeEqual } from 'node:crypto';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice(7) : address;
  return addr === '::1' || addr.startsWith('127.');
}

export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The PC's own browser may skip pairing. Requiring a localhost Host header as well as a loopback
 * socket keeps DNS-rebinding pages (Host: attacker.example) from getting the same pass.
 */
export function isTrustedLocal(remoteAddress: string | undefined, hostHeader: string | undefined): boolean {
  return isLoopbackAddress(remoteAddress) && LOCAL_HOSTNAMES.has(hostnameOf(hostHeader) ?? '');
}

/** Browsers always send Origin on WebSocket upgrades and cross-site POSTs; it must match Host. */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true; // non-browser clients; they still need the key
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

export function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerKey(authorization: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
}
