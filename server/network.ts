import os from 'node:os';

// Container/VM bridges aren't reachable from phones on the LAN.
const VIRTUAL_IFACE = /^(lo|docker|br-|virbr|veth|podman|cni|vmnet|vboxnet)/;
const PHYSICAL_IFACE = /^(en|eth|wl)/;

/** IPv4 addresses other devices can use, physical interfaces (ethernet/wifi) first. */
export function lanAddresses(): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs || VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) found.push({ address: a.address, rank: PHYSICAL_IFACE.test(name) ? 0 : 1 });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map((x) => x.address);
}

/** avahi announces the hostname as <hostname>.local. */
export function mdnsHost(): string {
  return `${os.hostname()}.local`;
}

export function reachableUrls(port: number): string[] {
  return [`http://${mdnsHost()}:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
}

/** Pairing link with the key in the URL fragment, which browsers never send to the server. */
export function pairingUrl(port: number, key: string): string {
  const host = lanAddresses()[0] ?? 'localhost';
  return `http://${host}:${port}/#k=${key}`;
}
