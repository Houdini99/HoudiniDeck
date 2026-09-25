import { spawn } from 'node:child_process';
import os from 'node:os';

// Container/VM bridges aren't reachable from phones on the LAN. Linux names, then Windows' adapter
// names (Hyper-V and WSL add "vEthernet (…)" adapters; VirtualBox and VMware add their own).
const VIRTUAL_IFACE = /^(lo|docker|br-|virbr|veth|podman|cni|vmnet|vboxnet)/;
const VIRTUAL_IFACE_WINDOWS = /^vEthernet\b|VirtualBox|VMware|Hyper-V|Loopback/i;
// Ethernet and Wi-Fi: en*/eth*/wl* on Linux; "Ethernet 2", "Wi-Fi" or (German) "WLAN" on Windows.
const PHYSICAL_IFACE = /^(en|eth|wl)/;
const PHYSICAL_IFACE_WINDOWS = /^(Ethernet|Wi-?Fi|WLAN)\b/i;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** IPv4 addresses other devices can use, physical interfaces (ethernet/wifi) first. */
export function lanAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || VIRTUAL_IFACE.test(name) || VIRTUAL_IFACE_WINDOWS.test(name)) continue;
    const rank = PHYSICAL_IFACE.test(name) || PHYSICAL_IFACE_WINDOWS.test(name) ? 0 : 1;
    for (const a of addrs) {
      // 169.254.x.x: a link-local address from a cable or adapter that didn't get one from the router.
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push({ address: a.address, rank });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map((x) => x.address);
}

/** avahi (Linux) and Windows 10/11 both answer for <hostname>.local on the LAN. */
export function mdnsHost(): string {
  return `${os.hostname().toLowerCase()}.local`;
}

export function reachableUrls(port: number): string[] {
  return [`http://${mdnsHost()}:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
}

/** Pairing link with the key in the URL fragment, which browsers never send to the server. */
export function pairingUrl(port: number, key: string): string {
  const host = lanAddresses()[0] ?? 'localhost';
  return `http://${host}:${port}/#k=${key}`;
}

/** Open a URL in the default browser, without waiting for it. */
export function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => {}) // no browser to open: the address is printed anyway
    .unref();
}

/** Whether a deck (this program) answers on the port, e.g. a copy started at login. */
export async function deckRunningOn(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}
