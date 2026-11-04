/**
 * The network an address belongs to, for per-IP limits and referral anti-abuse. One IPv6 host
 * usually holds a whole /64 and can pick a new address from it at will, so IPv6 is keyed by
 * its /64 prefix; an IPv4 address is its own network.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4(value: string): string | undefined {
  const match = IPV4.exec(value);
  if (!match) return undefined;
  return match.slice(1).every((octet) => Number(octet) <= 255) ? value : undefined;
}

/** An IPv6 address as eight 16-bit groups, or undefined when it isn't one. Takes `::` and a dotted IPv4 tail. */
function ipv6Groups(value: string): number[] | undefined {
  if (!value.includes(":")) return undefined;
  let text = value;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4(text.slice(lastColon + 1));
    if (!v4) return undefined;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    // Keep the `::` before an IPv4 tail (`::ffff:1.2.3.4`, `::1.2.3.4`).
    text = text.slice(0, lastColon + 1);
    text = text.endsWith("::") ? text : text.slice(0, -1);
  }
  if (!/^[0-9a-f:]*$/.test(text)) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":");
    if (groups.some((group) => group.length === 0 || group.length > 4)) return undefined;
    return groups.map((group) => parseInt(group, 16));
  };
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  if (!left || !right) return undefined;
  const given = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (given > 7) return undefined;
    return [...left, ...Array<number>(8 - given).fill(0), ...right, ...tail];
  }
  return given === 8 ? [...left, ...tail] : undefined;
}

/**
 * An IPv4 address itself; an IPv6 address's /64 (`2001:db8:1:2::/64`); an IPv4-mapped IPv6
 * address (`::ffff:1.2.3.4`, `::ffff:102:304`) as its IPv4 address. Undefined when `ip` isn't
 * an address. Case, leading zeros, `::` and `[brackets]` don't matter.
 */
export function networkOf(ip: string): string | undefined {
  let value = ip.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (IPV4.test(value)) return ipv4(value);
  const groups = ipv6Groups(value);
  if (!groups) return undefined;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * The part of a client address that per-IP rate limits key on: `networkOf`, or the raw value
 * when it isn't an address (e.g. "unknown"), so IPv4 keys are exactly what they always were.
 */
export function rateLimitNetwork(ip: string): string {
  return networkOf(ip) ?? ip;
}
