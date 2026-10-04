// KingPabloBypass - Vercel Serverless Function (POST /api/bypass)
//
// "Bypass" di project ini = URL Resolver / Redirector untuk URL yang dimiliki,
// dikelola, atau secara eksplisit diizinkan oleh pemiliknya (shortlink sendiri,
// URL campaign sendiri, affiliate yang diizinkan, testing redirect, dll).
// Fungsi ini TIDAK melewati CAPTCHA, login, paywall, timer, anti-bot, atau
// proteksi pihak ketiga lainnya.

const dns = require("dns").promises;
const net = require("net");

// ====================================================================
// PENTING: GANTI daftar ini dengan domain yang benar-benar KAMU KONTROL
// atau yang punya izin eksplisit untuk diproses. Bisa juga diatur lewat
// Environment Variable Vercel: ALLOWED_DOMAINS="domainku.com,go.domainku.com"
//
// - Daftar berisi  -> hanya domain (dan subdomain-nya) di daftar yang diproses.
// - Daftar KOSONG  -> mode validasi dasar: URL hanya divalidasi lalu dikembalikan,
//                     tanpa request keluar sama sekali (tidak ada resolve/scraping).
// ====================================================================
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS
  ? process.env.ALLOWED_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
  : ["example.com", "mydomain.com"];

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 4000;

const MSG = {
  ok: "URL berhasil diproses",
  invalid: "URL tidak valid",
  missing: "URL wajib diisi",
  method: "Method tidak diizinkan. Gunakan POST.",
  unsupported: "Domain ini belum didukung atau tidak memiliki izin untuk diproses.",
  failed: "URL tidak dapat diproses",
};

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ---------- Proteksi SSRF ---------- */
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 ||                          // 0.0.0.0/8
    a === 10 ||                         // 10.0.0.0/8
    a === 127 ||                        // loopback
    (a === 169 && b === 254) ||         // link-local / metadata cloud
    (a === 172 && b >= 16 && b <= 31) ||// 172.16.0.0/12
    (a === 192 && b === 168) ||         // 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) ||// CGNAT
    a >= 224                            // multicast / reserved
  );
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true;   // fc00::/7
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true; // fe80::/10
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);     // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return false;
}

/* ---------- Validasi URL ---------- */
function parseUrl(raw) {
  if (typeof raw !== "string") throw fail(400, MSG.invalid);
  const value = raw.trim();
  if (!value) throw fail(400, MSG.missing);
  if (value.length > MAX_URL_LENGTH) throw fail(400, MSG.invalid);

  let u;
  try {
    u = new URL(value);
  } catch (e) {
    throw fail(400, MSG.invalid);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw fail(400, MSG.invalid);
  if (u.username || u.password) throw fail(400, MSG.invalid);
  if (!u.hostname || isBlockedHostname(u.hostname)) throw fail(400, MSG.invalid);
  return u;
}

function isAllowedDomain(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith("." + d));
}

// Pastikan hostname yang akan di-request tidak mengarah ke IP internal.
// (Catatan: ini pengecekan DNS dasar; tidak menutup celah DNS rebinding sepenuhnya.)
async function assertPublicHost(hostname) {
  const clean = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(clean)) {
    if (isPrivateIp(clean)) throw fail(400, MSG.invalid);
    return;
  }
  const records = await dns.lookup(clean, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) {
    throw fail(400, MSG.invalid);
  }
}

/* ---------- Resolver redirect (hanya domain yang diizinkan) ---------- */
// Mengikuti redirect HTTP (3xx) secara manual. Setiap hop yang DI-REQUEST wajib
// berada di allowlist dan bukan alamat internal. Jika redirect menuju domain di
// luar allowlist, kita TIDAK me-request domain itu; Location-nya saja yang
// dikembalikan sebagai destination URL. Dengan begitu backend bukan open proxy.
async function resolveAllowed(startUrl) {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDomain(current.hostname)) {
      if (hop === 0) throw fail(403, MSG.unsupported);
      return current; // tujuan akhir di luar allowlist: hanya dikembalikan
    }

    await assertPublicHost(current.hostname);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "User-Agent": "KingPabloBypass/1.0 (+URL resolver)" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.body && response.body.cancel) response.body.cancel().catch(() => {});

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      let next;
      try {
        next = new URL(location, current);
      } catch (e) {
        throw fail(502, MSG.failed);
      }
      if ((next.protocol !== "http:" && next.protocol !== "https:") || isBlockedHostname(next.hostname)) {
        throw fail(400, MSG.invalid);
      }
      current = next;
      continue;
    }
    return current; // bukan redirect: ini destination-nya
  }
  throw fail(508, MSG.failed); // terlalu banyak redirect
}

/* ---------- Handler ---------- */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, { success: false, message: MSG.method });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    if (!body || typeof body !== "object") return send(res, 400, { success: false, message: MSG.invalid });
    if (body.url === undefined || body.url === null || body.url === "") {
      return send(res, 400, { success: false, message: MSG.missing });
    }

    const parsed = parseUrl(body.url);

    // Allowlist kosong -> mode validasi dasar, tanpa request keluar.
    const destination = ALLOWED_DOMAINS.length === 0 ? parsed : await resolveAllowed(parsed);

    // Tidak ada penyimpanan URL: tidak ada database, file, maupun log isi URL.
    return send(res, 200, { success: true, url: destination.toString(), message: MSG.ok });
  } catch (err) {
    if (err && err.status) return send(res, err.status, { success: false, message: err.message });
    return send(res, 500, { success: false, message: MSG.failed });
  }
};
