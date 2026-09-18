import { HubSpotClient } from "@/lib/integrations/hubspot";
import { validateSlackCredential } from "@/lib/integrations/slack";

/**
 * Credential checks shared by adding an integration and replacing its secret.
 *
 * They live together because the two paths must agree. A rotation that
 * accepted a shape the original refused - or skipped deriving the portal id -
 * would leave a working integration broken in a way nothing reports until the
 * next inbound webhook is dropped.
 */

/**
 * Ask HubSpot which portal a token belongs to, returning null rather than
 * throwing. See HubSpotClient.fetchPortalId for why this is derived at all.
 */
export async function derivePortalId(credential: string): Promise<number | null> {
  try {
    const creds = JSON.parse(credential) as { accessToken: string };
    return await new HubSpotClient(creds).fetchPortalId();
  } catch {
    return null;
  }
}

export function validateCredentialShape(type: string, credential: string): string | null {
  if (type === "hubspot") {
    const shape =
      'Expected JSON like {"accessToken": "pat-na1-...", "clientSecret": "..."}';
    try {
      const parsed = JSON.parse(credential) as {
        accessToken?: unknown;
        clientSecret?: unknown;
      };
      if (typeof parsed.accessToken !== "string" || parsed.accessToken.length < 10) {
        return shape;
      }
      // Optional, because a portal that pushes leads some other way never
      // needs it. Required for private-app webhooks, which is how a free
      // HubSpot account sends leads at all - so a value that is present but
      // obviously truncated is worth refusing now rather than at 2am as an
      // invalid signature.
      if (parsed.clientSecret !== undefined) {
        if (typeof parsed.clientSecret !== "string" || parsed.clientSecret.trim().length < 16) {
          return "clientSecret looks truncated - copy the private app's full client secret";
        }
      }
    } catch {
      return shape;
    }
    return null;
  }

  // A Slack incoming webhook URL is itself the credential - anyone holding it
  // can post to the client's channel - so it is sealed like any other secret
  // and checked for shape here, while the plaintext is still in hand.
  if (type === "notification") {
    return validateSlackCredential(credential);
  }

  if (type === "google_sheets") {
    try {
      const parsed = JSON.parse(credential) as { client_email?: unknown; private_key?: unknown };
      if (typeof parsed.client_email !== "string" || !parsed.client_email.includes("@")) {
        return "Service account JSON must include a client_email";
      }
      if (
        typeof parsed.private_key !== "string" ||
        !parsed.private_key.includes("BEGIN PRIVATE KEY")
      ) {
        return "Service account JSON must include a PEM private_key";
      }
    } catch {
      return "Expected the downloaded service-account JSON";
    }
    return null;
  }

  return null;
}
