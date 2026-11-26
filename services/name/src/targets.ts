/**
 * What a lease's `dnsTarget` may be. The target becomes a DNS record under the service's
 * zone (a CNAME for a hostname, A or AAAA for an address), so it's checked before it's
 * stored.
 *
 * The usual target is a Tailscale MagicDNS name (`alice.example.ts.net`) or a Tailscale
 * address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), which are only reachable from inside
 * the owner's tailnet. Private and carrier-grade NAT ranges are therefore allowed: a name
 * that resolves to a tailnet or LAN address is the point, and the name service never
 * connects to the target itself. What's refused is anything that can't name the owner's
 * server for anyone: loopback, unspecified, link-local, multicast and reserved addresses,
 * `localhost`, single-label names, and names inside the service's own zone (which would let
 * one lease alias another, or the service's own hosts).
 */

export type TargetCheck = { ok: true; target: string } | { ok: false; reason: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

/** Validates and normalizes a target: lowercase, no trailing dot, IPv6 in canonical form. */
export function validateDnsTarget(input: string, zone: string): TargetCheck {
  const raw = input.trim().toLowerCase();
  if (!raw) return { ok: false, reason: "dnsTarget is empty." };
  if (raw.length > 255) return { ok: false, reason: "dnsTarget is too long." };

  if (IPV4.test(raw)) return checkIpv4(raw);
  if (raw.includes(":")) return checkIpv6(raw);
  return checkHostname(raw.endsWith(".") ? raw.slice(0, -1) : raw, zone);
}

function checkIpv4(address: string): TargetCheck {
  const [a, b] = address.split(".").map(Number) as [number, number, number, number];
  if (a === 0) return { ok: false, reason: `${address} is an unspecified address.` };
  if (a === 127) return { ok: false, reason: `${address} is a loopback address.` };
  if (a === 169 && b === 254) return { ok: false, reason: `${address} is a link-local address.` };
  if (a >= 224) return { ok: false, reason: `${address} is a multicast or reserved address.` };
  return { ok: true, target: address };
}

function checkIpv6(input: string): TargetCheck {
  const address = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (!/^[0-9a-f:.]+$/.test(address)) return { ok: false, reason: "dnsTarget isn't a valid IPv6 address." };
  let canonical: string;
  try {
    // The URL parser is the portable IPv6 parser: it rejects malformed addresses and
    // compresses valid ones to one canonical spelling.
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return { ok: false, reason: "dnsTarget isn't a valid IPv6 address." };
  }
  if (canonical === "::") return { ok: false, reason: "dnsTarget is the unspecified address." };
  if (canonical === "::1") return { ok: false, reason: "dnsTarget is a loopback address." };
  if (/^fe[89ab]/.test(canonical)) return { ok: false, reason: "dnsTarget is a link-local address." };
  if (canonical.startsWith("ff")) return { ok: false, reason: "dnsTarget is a multicast address." };
  if (canonical.startsWith("::ffff:")) return { ok: false, reason: "Send an IPv4-mapped address as plain IPv4." };
  return { ok: true, target: canonical };
}

function checkHostname(host: string, zone: string): TargetCheck {
  if (host.length > 253) return { ok: false, reason: "dnsTarget is longer than 253 characters." };
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, reason: "dnsTarget must be a fully qualified hostname or an IP address." };
  for (const label of labels) {
    if (!LABEL.test(label)) return { ok: false, reason: `dnsTarget has an invalid label "${label}".` };
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) {
    return { ok: false, reason: "dnsTarget isn't a valid hostname or IP address." };
  }
  if (host.endsWith(".localhost")) return { ok: false, reason: "dnsTarget can't be localhost." };
  const ownZone = zone.trim().toLowerCase().replace(/\.$/, "");
  if (host === ownZone || host.endsWith(`.${ownZone}`)) {
    return { ok: false, reason: `dnsTarget can't point inside ${ownZone}.` };
  }
  return { ok: true, target: host };
}
