import type { PoolClient } from "pg";
import { openSecret, type SealedSecret } from "@/lib/crypto/kms";
import { providerNames, resolveProvider } from "@/lib/providers/voice";
import { SarvamVoiceProvider } from "@/lib/providers/voice/sarvam";
import { TwilioVoiceProvider } from "@/lib/providers/voice/twilio";
import {
  sarvamConfigFrom,
  twilioConfigFrom,
  type VoiceCredential,
} from "@/lib/providers/voice/credentials";
import type { VoiceProvider } from "@/lib/providers/voice/types";

/**
 * Resolving a voice provider for one client.
 *
 * Two sources, in this order:
 *
 *   1. A `voice_provider` integration on the tenant, sealed like every other
 *      credential. This is how a client with their own Sarvam workspace - or
 *      their own Twilio account, which is the usual arrangement when the
 *      number has to belong to them - gets dialled through it.
 *
 *   2. The environment, which is the agency's own shared account and the only
 *      thing that existed before. Left as the fallback rather than removed:
 *      one account across every client is a perfectly ordinary setup, and it
 *      should not need a row per client to keep working.
 *
 * The lookup does not unseal anything to decide *which* integration to use.
 * `integrations.config->>'provider'` carries the name in the clear precisely
 * so that listing what a client can dial with - on the campaign form, on the
 * integrations page - never touches a secret.
 */

interface SealedRow {
  id: string;
  key_id: string;
  wrapped_dek: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}

const SELECT_ACTIVE = `
  select i.id, s.key_id, s.wrapped_dek, s.iv, s.ciphertext, s.auth_tag
    from integrations i
    join secrets s on s.id = i.credential_ref
   where i.type = 'voice_provider'
     and i.status = 'active'
     and i.config ->> 'provider' = $1
   order by i.created_at desc
   limit 1`;

/**
 * The provider a call should be placed through, for this tenant.
 *
 * Throws the same way `resolveProvider` does when nothing is configured: a
 * campaign naming a provider that cannot dial must fail loudly at claim time
 * rather than silently falling through to another one.
 */
export async function resolveProviderForTenant(
  tx: PoolClient,
  name: string,
): Promise<VoiceProvider> {
  const credential = await loadCredential(tx, name);
  if (credential) return buildProvider(credential);

  return resolveProvider(name);
}

/** Which providers this client could actually dial with, credential or env. */
export async function providersForTenant(tx: PoolClient): Promise<string[]> {
  const r = await tx.query<{ provider: string }>(
    `select distinct i.config ->> 'provider' as provider
       from integrations i
      where i.type = 'voice_provider'
        and i.status = 'active'
        and i.config ->> 'provider' is not null`,
  );

  const configured = r.rows.map((row) => row.provider);
  return [...new Set([...providerNames(), ...configured])].sort();
}

/**
 * Where a given provider's credential comes from for this client, for the UI
 * to say so plainly. No secret is unsealed.
 */
export async function credentialSourceFor(
  tx: PoolClient,
  name: string,
): Promise<"client" | "platform" | "none"> {
  const r = await tx.query(
    `select 1 from integrations
      where type = 'voice_provider' and status = 'active' and config ->> 'provider' = $1
      limit 1`,
    [name],
  );

  if ((r.rowCount ?? 0) > 0) return "client";
  return providerNames().includes(name) ? "platform" : "none";
}

async function loadCredential(tx: PoolClient, name: string): Promise<VoiceCredential | null> {
  const r = await tx.query<SealedRow>(SELECT_ACTIVE, [name]);
  const row = r.rows[0];
  if (!row) return null;

  const sealed: SealedSecret = {
    keyId: row.key_id,
    wrappedDek: row.wrapped_dek,
    iv: row.iv,
    ciphertext: row.ciphertext,
    authTag: row.auth_tag,
  };

  return JSON.parse(openSecret(sealed, "voice_provider")) as VoiceCredential;
}

export function buildProvider(credential: VoiceCredential): VoiceProvider {
  switch (credential.provider) {
    case "sarvam":
      return new SarvamVoiceProvider(sarvamConfigFrom(credential));
    case "twilio":
      return new TwilioVoiceProvider(twilioConfigFrom(credential));
    default:
      throw new Error(`No adapter for stored voice provider "${credential.provider}"`);
  }
}
