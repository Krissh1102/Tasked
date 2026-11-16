import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Early URL validation (fast feedback in the UI, stage 03).
 * The Python engine independently re-validates every request, including each
 * redirect hop, and connects to the vetted IP — this layer is defence in depth,
 * not the only gate.
 */

const blocked = new BlockList();
const v4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, "ipv4");
const v6: [string, number][] = [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ["100::", 64], ["64:ff9b::", 96], ["2002::", 16],
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, "ipv6");

export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (!kind) return false;
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPublicIp(mapped[1]);
  }
  return !blocked.check(ip, kind === 4 ? "ipv4" : "ipv6");
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet"];

export type UrlCheck =
  | { ok: true; url: string; host: string; ips: string[] }
  | { ok: false; code: string; message: string };

export const ALLOW_PRIVATE_ENV = "TASKFORGE_UNSAFE_ALLOW_PRIVATE";
let warned = false;
function envAllowsPrivate(): boolean {
  const on = process.env[ALLOW_PRIVATE_ENV] === "1";
  if (on && !warned) {
    warned = true;
    console.warn(`[taskforge] WARNING: ${ALLOW_PRIVATE_ENV}=1 — SSRF protection is DISABLED. Use only for the local demo site / tests.`);
  }
  return on;
}

export interface UrlCheckOptions {
  /** Permit private/loopback targets. Defaults to the explicit dev switch TASKFORGE_UNSAFE_ALLOW_PRIVATE=1 (off by default). */
  allowPrivate?: boolean;
  lookup?: (host: string) => Promise<string[]>;
}

async function defaultLookup(host: string): Promise<string[]> {
  const res = await dns.lookup(host, { all: true });
  return res.map((r) => r.address);
}

const fail = (code: string, message: string): UrlCheck => ({ ok: false, code, message });

export async function validateTargetUrl(raw: string, opts: UrlCheckOptions = {}): Promise<UrlCheck> {
  const input = (raw ?? "").trim();
  if (!input) return fail("INVALID_URL", "The URL is empty.");
  if (input.length > 2048) return fail("URL_TOO_LONG", "The URL is longer than 2048 characters.");
  if (/[\s\u0000-\u001f]/.test(input)) return fail("INVALID_URL", "The URL contains spaces or control characters.");

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return fail("INVALID_URL", `"${input.slice(0, 80)}" is not a valid absolute URL (include http:// or https://).`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return fail("UNSUPPORTED_SCHEME", `Only http and https URLs are allowed (got "${u.protocol.replace(":", "")}").`);
  if (u.username || u.password) return fail("CREDENTIALS_NOT_ALLOWED", "URLs with embedded credentials are not allowed.");

  // WHATWG parsing already normalises decimal/hex/octal IPv4 forms (e.g. 2130706433 -> 127.0.0.1).
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return fail("MISSING_HOST", "The URL has no host.");

  const allowPrivate = opts.allowPrivate ?? envAllowsPrivate();
  if (!allowPrivate && (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))))
    return fail("BLOCKED_HOST", `"${host}" is an internal host name and is blocked.`);

  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = await (opts.lookup ?? defaultLookup)(host);
    } catch (e) {
      return fail("DNS_FAILURE", `Could not resolve "${host}" (${(e as NodeJS.ErrnoException).code ?? "lookup failed"}).`);
    }
    if (!ips.length) return fail("DNS_FAILURE", `"${host}" resolved to no addresses.`);
  }
  if (!allowPrivate) {
    const bad = ips.find((ip) => !isPublicIp(ip));
    if (bad) return fail("PRIVATE_ADDRESS", `"${host}" resolves to a non-public address (${bad}); request blocked.`);
  }
  u.hash = "";
  return { ok: true, url: u.toString(), host, ips };
}
