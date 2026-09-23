import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { closePools, withScope, type TenantScope } from "@/db/client";
import { sealSecret } from "@/lib/crypto/kms";
import {
  credentialSourceFor,
  providersForTenant,
  resolveProviderForTenant,
} from "@/lib/providers/voice/tenant";
import { SarvamVoiceProvider } from "@/lib/providers/voice/sarvam";
import { MockVoiceProvider } from "@/lib/providers/voice/mock";

/**
 * Where a call's credential comes from.
 *
 * The claim being tested is narrow and load-bearing: a client with their own
 * voice account is dialled through it, and one without falls back to the
 * agency's. Getting this wrong means calls billed to the wrong account, or
 * placed from the wrong number - neither of which is visible from the UI.
 */

const TENANT = "b8b8b8b8-0000-4000-8000-000000000008";
const OTHER = "c9c9c9c9-0000-4000-8000-000000000009";

let owner: Client;

const scope: TenantScope = {
  tenantId: TENANT,
  globalScope: false,
  actorId: null,
  actorType: "service",
};

const otherScope: TenantScope = { ...scope, tenantId: OTHER };

const SARVAM_CREDENTIAL = {
  provider: "sarvam",
  apiKey: "sk_tenant_key",
  orgId: "org_tenant",
  workspaceId: "ws_tenant",
  appId: "app_tenant",
  connectionId: "conn_tenant",
  agentPhoneNumber: "+919812345678",
};

async function asGlobal<T>(fn: () => Promise<T>): Promise<T> {
  await owner.query("begin");
  await owner.query(`select set_config('app.global_scope', 'on', true)`);
  try {
    const out = await fn();
    await owner.query("commit");
    return out;
  } catch (err) {
    await owner.query("rollback").catch(() => {});
    throw err;
  }
}

/** Seal a voice credential onto a tenant, the way the UI action does. */
async function addVoiceCredential(
  tenantId: string,
  credential: Record<string, string>,
  status: "active" | "disabled" = "active",
): Promise<void> {
  const sealed = sealSecret(JSON.stringify(credential), "voice_provider");

  await asGlobal(async () => {
    const secret = await owner.query<{ id: string }>(
      `insert into secrets (tenant_id, purpose, key_id, wrapped_dek, iv, ciphertext, auth_tag)
       values ($1, 'voice_provider', $2, $3, $4, $5, $6) returning id`,
      [tenantId, sealed.keyId, sealed.wrappedDek, sealed.iv, sealed.ciphertext, sealed.authTag],
    );

    await owner.query(
      `insert into integrations (tenant_id, type, name, credential_ref, status, config)
       values ($1, 'voice_provider', $2, $3, $4, $5::jsonb)`,
      [
        tenantId,
        `${credential.provider} account`,
        secret.rows[0]!.id,
        status,
        JSON.stringify({ provider: credential.provider }),
      ],
    );
  });
}

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();

  await asGlobal(async () => {
    await owner.query(
      `insert into tenants (id, name, slug, timezone) values
         ($1, 'Voice Cred Co', 'voice-cred-co', 'Asia/Kolkata'),
         ($2, 'No Voice Co', 'no-voice-co', 'Asia/Kolkata')
       on conflict (id) do nothing`,
      [TENANT, OTHER],
    );
  });
});

beforeEach(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from integrations where tenant_id = any($1::uuid[])`, [[TENANT, OTHER]]);
    await owner.query(`delete from secrets where tenant_id = any($1::uuid[])`, [[TENANT, OTHER]]);
  });
});

afterAll(async () => {
  await asGlobal(async () => {
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [[TENANT, OTHER]]);
  });
  await owner.end();
  await closePools();
});

describe("resolving a voice provider for one client", () => {
  it("dials through the client's own credential when they have one", async () => {
    await addVoiceCredential(TENANT, SARVAM_CREDENTIAL);

    const provider = await withScope(scope, (tx) => resolveProviderForTenant(tx, "sarvam"));

    expect(provider).toBeInstanceOf(SarvamVoiceProvider);
    expect(provider.metadata().name).toBe("sarvam");
  });

  it("makes sarvam selectable for that client even though the environment has none", async () => {
    // The whole point: this process cannot register sarvam from env here, so
    // anything selectable came from the credential.
    const before = await withScope(scope, (tx) => providersForTenant(tx));
    expect(before).not.toContain("sarvam");

    await addVoiceCredential(TENANT, SARVAM_CREDENTIAL);

    const after = await withScope(scope, (tx) => providersForTenant(tx));
    expect(after).toContain("sarvam");
    // The agency's own providers do not disappear.
    expect(after).toContain("mock");
  });

  it("does not leak one client's provider to another", async () => {
    await addVoiceCredential(TENANT, SARVAM_CREDENTIAL);

    const theirs = await withScope(otherScope, (tx) => providersForTenant(tx));
    expect(theirs).not.toContain("sarvam");

    await expect(
      withScope(otherScope, (tx) => resolveProviderForTenant(tx, "sarvam")),
    ).rejects.toThrow(/Unknown voice provider/);
  });

  it("falls back to the agency's account when the client has no credential", async () => {
    const provider = await withScope(scope, (tx) => resolveProviderForTenant(tx, "mock"));
    expect(provider).toBeInstanceOf(MockVoiceProvider);
  });

  it("ignores a disabled credential rather than dialling through it", async () => {
    await addVoiceCredential(TENANT, SARVAM_CREDENTIAL, "disabled");

    expect(await withScope(scope, (tx) => providersForTenant(tx))).not.toContain("sarvam");
    await expect(withScope(scope, (tx) => resolveProviderForTenant(tx, "sarvam"))).rejects.toThrow(
      /Unknown voice provider/,
    );
  });

  it("says where each provider's credential comes from, without unsealing it", async () => {
    await addVoiceCredential(TENANT, SARVAM_CREDENTIAL);

    const sources = await withScope(scope, async (tx) => ({
      sarvam: await credentialSourceFor(tx, "sarvam"),
      mock: await credentialSourceFor(tx, "mock"),
      vonage: await credentialSourceFor(tx, "vonage"),
    }));

    expect(sources).toEqual({ sarvam: "client", mock: "platform", vonage: "none" });
  });

  it("prefers the client's credential over the agency's for the same provider", async () => {
    await addVoiceCredential(TENANT, {
      provider: "twilio",
      accountSid: "AC_tenant_specific",
      authToken: "tok_tenant",
      fromNumber: "+12025550111",
    });

    const source = await withScope(scope, (tx) => credentialSourceFor(tx, "twilio"));
    expect(source).toBe("client");
  });
});
