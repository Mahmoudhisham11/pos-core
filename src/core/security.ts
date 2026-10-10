import bcrypt from "bcryptjs";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { settings } from "./config";

// Portable (Node + browser worker): no node:crypto / Buffer.
const enc = new TextEncoder();
const dec = new TextDecoder();
function toB64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const sign = (data: string): Uint8Array => hmac(sha256, enc.encode(settings.SECRET_KEY), enc.encode(data));
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// bcrypt only looks at the first 72 bytes; make that explicit instead of failing on long input.
const BCRYPT_MAX_BYTES = 72;

export function isBcryptHash(value: unknown): boolean {
  return typeof value === "string" && value.length === 60 && /^\$2[aby]\$/.test(value);
}

// bcryptjs hashes JS strings as UTF-8 itself; for the truncated case feed it a string whose UTF-8 form is the same bytes.
function bcryptInput(password: string): string {
  const buf = enc.encode(password);
  if (buf.length <= BCRYPT_MAX_BYTES) return password;
  return dec.decode(buf.subarray(0, BCRYPT_MAX_BYTES));
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(bcryptInput(password), 10);
}

/** Plaintext stored values never match. */
export function verifyPassword(plain: string, hashed: string | null | undefined): boolean {
  if (!isBcryptHash(hashed)) return false;
  try {
    return bcrypt.compareSync(bcryptInput(plain), hashed as string);
  } catch {
    return false;
  }
}

const b64u = (b: string) => toB64u(enc.encode(b));

export interface TokenPayload { sub: string; exp: number; iat: number; jti: string; [k: string]: any }

export function createAccessToken(subject: string, extraClaims: Record<string, unknown> = {}, expiresMinutes?: number): string {
  const nowS = Math.floor(Date.now() / 1000);
  const payload = {
    exp: nowS + (expiresMinutes ?? settings.ACCESS_TOKEN_EXPIRE_MINUTES) * 60,
    sub: String(subject),
    iat: nowS,
    jti: crypto.randomUUID(),
    ...extraClaims,
  };
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = toB64u(sign(`${head}.${body}`));
  return `${head}.${body}.${sig}`;
}

/** Verified payload, or null for a bad signature / expired / malformed token. */
export function decodeToken(token: string): TokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    const header = JSON.parse(dec.decode(fromB64u(head)));
    if (header.alg !== settings.ALGORITHM) return null;
    if (!constantTimeEqual(fromB64u(sig), sign(`${head}.${body}`))) return null;
    const payload = JSON.parse(dec.decode(fromB64u(body)));
    if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) return null;
    return payload as TokenPayload;
  } catch {
    return null;
  }
}
