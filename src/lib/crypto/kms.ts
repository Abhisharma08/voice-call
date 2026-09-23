import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env, previousKmsKeys } from "@/lib/env";

/**
 * Envelope encryption for integration credentials: secrets are encrypted at
 * rest, and the database stores only a reference, never a plaintext value.
 *
 * Each secret gets its own random 256-bit data key (DEK). The DEK is wrapped
 * with the master key and stored alongside the ciphertext; the master key
 * itself never touches the database. Rotating the master key means re-wrapping
 * DEKs, not re-encrypting every payload, and KMS_PREVIOUS_KEYS lets old
 * records stay readable through the rotation window.
 *
 * This interface is deliberately shaped like a cloud KMS so Phase 3 can swap
 * the local implementation for AWS KMS / GCP KMS without touching callers.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  keyId: string;
  wrappedDek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

function masterKey(keyId: string): Buffer {
  const e = env();
  if (keyId === e.KMS_MASTER_KEY_ID) return Buffer.from(e.KMS_MASTER_KEY, "base64");
  const previous = previousKmsKeys()[keyId];
  if (previous) return previous;
  throw new Error(`Unknown KMS key id: ${keyId}`);
}

function aesEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function aesDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer, aad?: Buffer) {
  const decipher = createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function unpackWrapped(wrappedDek: Buffer) {
  return {
    iv: wrappedDek.subarray(0, IV_BYTES),
    authTag: wrappedDek.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    ciphertext: wrappedDek.subarray(IV_BYTES + TAG_BYTES),
  };
}

/**
 * `purpose` is bound into the ciphertext as additional authenticated data, so
 * a HubSpot credential blob cannot be replayed into a voice-provider slot.
 */
export function sealSecret(plaintext: string, purpose: string): SealedSecret {
  const e = env();
  const dek = randomBytes(32);
  const aad = Buffer.from(purpose, "utf8");

  const payload = aesEncrypt(dek, Buffer.from(plaintext, "utf8"), aad);
  const wrapped = aesEncrypt(masterKey(e.KMS_MASTER_KEY_ID), dek, aad);
  dek.fill(0);

  return {
    keyId: e.KMS_MASTER_KEY_ID,
    // iv || authTag || ciphertext, self-contained so the DB stores one column
    wrappedDek: Buffer.concat([wrapped.iv, wrapped.authTag, wrapped.ciphertext]),
    iv: payload.iv,
    ciphertext: payload.ciphertext,
    authTag: payload.authTag,
  };
}

export function openSecret(sealed: SealedSecret, purpose: string): string {
  const aad = Buffer.from(purpose, "utf8");
  const wrapped = unpackWrapped(sealed.wrappedDek);

  const dek = aesDecrypt(masterKey(sealed.keyId), wrapped.iv, wrapped.ciphertext, wrapped.authTag, aad);
  try {
    return aesDecrypt(dek, sealed.iv, sealed.ciphertext, sealed.authTag, aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap an existing secret under the current master key, without decrypting the payload. */
export function rewrapSecret(sealed: SealedSecret, purpose: string): SealedSecret {
  const e = env();
  const aad = Buffer.from(purpose, "utf8");
  const wrapped = unpackWrapped(sealed.wrappedDek);

  const dek = aesDecrypt(masterKey(sealed.keyId), wrapped.iv, wrapped.ciphertext, wrapped.authTag, aad);
  try {
    const rewrapped = aesEncrypt(masterKey(e.KMS_MASTER_KEY_ID), dek, aad);
    return {
      ...sealed,
      keyId: e.KMS_MASTER_KEY_ID,
      wrappedDek: Buffer.concat([rewrapped.iv, rewrapped.authTag, rewrapped.ciphertext]),
    };
  } finally {
    dek.fill(0);
  }
}
