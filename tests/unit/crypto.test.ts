import { describe, expect, it } from "vitest";
import { openSecret, rewrapSecret, sealSecret } from "@/lib/crypto/kms";
import {
  blindIndex,
  decryptPii,
  encryptPii,
  lastFour,
  maskPhone,
} from "@/lib/crypto/pii";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/crypto/password";

describe("secrets vault", () => {
  it("round-trips a credential", () => {
    const token = "pat-na1-0000-1111-2222";
    const sealed = sealSecret(token, "hubspot");
    expect(openSecret(sealed, "hubspot")).toBe(token);
  });

  it("never stores the plaintext", () => {
    const token = "pat-na1-0000-1111-2222";
    const sealed = sealSecret(token, "hubspot");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("pat-na1");
    expect(sealed.wrappedDek.toString("utf8")).not.toContain("pat-na1");
  });

  it("gives every secret its own data key", () => {
    const a = sealSecret("same-value", "hubspot");
    const b = sealSecret("same-value", "hubspot");
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("refuses to open a credential under a different purpose", () => {
    // A HubSpot blob must not be replayable into a voice-provider slot.
    const sealed = sealSecret("pat-na1-secret", "hubspot");
    expect(() => openSecret(sealed, "voice_provider")).toThrow();
  });

  it("detects tampering with the ciphertext", () => {
    const sealed = sealSecret("pat-na1-secret", "hubspot");
    const firstByte = sealed.ciphertext[0];
    if (firstByte === undefined) throw new Error("empty ciphertext");
    sealed.ciphertext[0] = firstByte ^ 0xff;
    expect(() => openSecret(sealed, "hubspot")).toThrow();
  });

  it("re-wraps without changing the payload", () => {
    const sealed = sealSecret("pat-na1-secret", "hubspot");
    const rewrapped = rewrapSecret(sealed, "hubspot");
    expect(rewrapped.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(openSecret(rewrapped, "hubspot")).toBe("pat-na1-secret");
  });
});

describe("PII columns", () => {
  it("round-trips a phone number", () => {
    const phone = "+919876543210";
    expect(decryptPii(encryptPii(phone))).toBe(phone);
  });

  it("produces different ciphertext for the same value", () => {
    // A database dump must not reveal which leads share a phone number.
    const a = encryptPii("+919876543210");
    const b = encryptPii("+919876543210");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a tampered envelope", () => {
    const blob = encryptPii("+919876543210");
    const last = blob[blob.length - 1];
    if (last === undefined) throw new Error("empty blob");
    blob[blob.length - 1] = last ^ 0xff;
    expect(() => decryptPii(blob)).toThrow();
  });

  it("masks all but the last four digits", () => {
    expect(maskPhone("+919876543210")).toBe("******3210");
    expect(lastFour("+919876543210")).toBe("3210");
  });
});

describe("blind index", () => {
  const tenantA = "11111111-1111-1111-1111-111111111111";
  const tenantB = "22222222-2222-2222-2222-222222222222";

  it("is deterministic within a tenant, so duplicates match", () => {
    expect(blindIndex(tenantA, "+919876543210")).toBe(blindIndex(tenantA, "+919876543210"));
  });

  it("is tenant-salted, so one client cannot probe another's rows", () => {
    expect(blindIndex(tenantA, "+919876543210")).not.toBe(blindIndex(tenantB, "+919876543210"));
  });

  it("does not leak the underlying value", () => {
    expect(blindIndex(tenantA, "+919876543210")).not.toContain("9876543210");
  });

  it("distinguishes different numbers", () => {
    expect(blindIndex(tenantA, "+919876543210")).not.toBe(blindIndex(tenantA, "+919876543211"));
  });
});

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  it("salts, so identical passwords hash differently", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });

  it("flags hashes below current cost parameters", async () => {
    expect(needsRehash(await hashPassword("x"))).toBe(false);
    expect(needsRehash("scrypt$16384$8$1$AAAA$BBBB")).toBe(true);
  });
});
