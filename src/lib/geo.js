import { hashString } from "./utils.js";

const cache = new Map();
const inflight = new Map();

// Built-in provider chain. Each entry describes how to build the request URL
// and how to extract coordinates from the response JSON. Providers are tried
// in order; the first successful result wins.
const GEO_PROVIDERS = [
  {
    // https://free.freeipapi.com — HTTPS, no API key, browser-friendly
    url: (ip) => `https://free.freeipapi.com/api/json/${ip}`,
    extract: (p) => ({
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      cityName: p.cityName || "unknown city",
      countryName: p.countryName || "unknown country",
    }),
    ok: () => true,
  },
];

function fallbackPosition(peer) {
  const hash = hashString(peer);
  return {
    latitude: ((hash % 14000) / 100) - 70,
    longitude: (((Math.floor(hash / 14000) % 36000) / 100) - 180),
    cityName: "derived",
    countryName: "fallback",
    source: "fallback"
  };
}

// Resolve a hostname to its first IPv4 address via Cloudflare DNS-over-HTTPS.
// Returns null if resolution fails or the input is already an IP.
async function resolveToIP(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname; // already IPv4
  if (hostname.includes(":")) return hostname; // already IPv6
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.Answer?.find((a) => a.type === 1)?.data ?? null;
  } catch {
    return null;
  }
}

function normalizePeer(peer) {
  // IPv6 with port: [2001:db8::1]:3001 → 2001:db8::1
  const ipv6Match = peer.match(/^\[([^\]]+)\]/);
  if (ipv6Match) return ipv6Match[1];
  // IPv4 with port: 1.2.3.4:3001 → 1.2.3.4
  return peer.split(":")[0];
}

// Try each provider in sequence; return the first valid result.
// If `customEndpoint` is provided (from config hash param), use it exclusively
// with the same field normalization as the built-in provider.
async function fetchGeo(ip, customEndpoint) {
  const providers = customEndpoint
    ? [{ url: () => `${customEndpoint}/${ip}`, extract: GEO_PROVIDERS[0].extract, ok: GEO_PROVIDERS[0].ok }]
    : GEO_PROVIDERS;

  for (const provider of providers) {
    try {
      const response = await fetch(provider.url(ip), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const payload = await response.json();
      if (!provider.ok(payload)) continue;
      const result = { ...provider.extract(payload), source: "live" };
      if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) continue;
      return result;
    } catch {
      // network error or timeout — try next provider
    }
  }
  return null;
}

export async function geolocatePeer(peer, config) {
  if (!peer) {
    return fallbackPosition("unknown");
  }

  if (cache.has(peer)) {
    return cache.get(peer);
  }

  if (inflight.has(peer)) {
    return inflight.get(peer);
  }

  const ip = normalizePeer(peer);

  // Only pass the custom endpoint when the user explicitly set one via hash param
  const customEndpoint = config.geoEndpoint !== "built-in" ? config.geoEndpoint : null;

  const request = (async () => {
    try {
      // Resolve hostname to IP if needed (geo providers don't accept hostnames)
      const resolvedIP = await resolveToIP(ip);
      const lookupTarget = resolvedIP ?? ip;
      const result = await fetchGeo(lookupTarget, customEndpoint);
      const final = result ?? fallbackPosition(peer);
      cache.set(peer, final);
      return final;
    } finally {
      inflight.delete(peer);
    }
  })();

  inflight.set(peer, request);
  return request;
}