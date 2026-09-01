import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Password hashing for agency staff accounts (PRD 4: clients never log in).
 *
 * scrypt from Node's standard library, so there is no native build step in CI
 * or on deploy. Parameters follow the memory-hard end of current guidance;
 * they are recorded in the hash string so cost can be raised later without
 * invalidating existing credentials.
 */

const N = 2 ** 16; // CPU/memory cost
const r = 8;
const p = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_BYTES, {
    N,
    r,
    p,
    maxmem: MAX_MEMORY,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");

  const actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
    maxmem: MAX_MEMORY,
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash was produced with weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < N || Number(parts[2]) < r || Number(parts[3]) < p;
}
