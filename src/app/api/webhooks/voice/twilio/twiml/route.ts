import { type NextRequest } from "next/server";
import { withScope } from "@/db/client";
import { decryptPiiOrNull, encryptPii } from "@/lib/crypto/pii";
import { twilioConfigFromEnv, twilioSignature, twimlToken } from "@/lib/providers/voice/twilio";
import { publicRequestUrl } from "@/lib/providers/voice/public-url";
import { fill, firstName } from "@/lib/providers/voice/script-fill";

export const runtime = "nodejs";

/**
 * The conversation itself, as TwiML.
 *
 * Twilio is a carrier, not a voice agent: it dials and plays audio, and this
 * endpoint decides what to say next. One turn per request - speak a question,
 * `<Gather input="speech">` the answer, then come back for the next one. Each
 * answer is appended to the call's transcript, so by the time the status
 * callback reports `completed` there is a real conversation for qualification
 * to read.
 *
 * Deliberately simple. No barge-in, no clarification, no recovery from a
 * misheard answer. It is enough to exercise the pipeline against a phone that
 * rings, and no substitute for a production voice agent.
 */

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const callId = url.searchParams.get("callId");
  const token = url.searchParams.get("token");
  const turn = Number(url.searchParams.get("turn") ?? 0);

  const config = twilioConfigFromEnv();
  if (!config) return twiml(say("This platform is not configured for Twilio."));

  // Two independent checks. The token proves the URL was minted by createCall
  // for this specific call; the signature proves Twilio sent the request.
  if (!callId || token !== twimlToken(callId, config.webhookSecret)) {
    return twiml(say("Sorry, this call could not be verified."), 403);
  }

  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);
  const signature = request.headers.get("x-twilio-signature") ?? "";

  // Twilio signs the public URL it called, not the internal one this process
  // sees behind a tunnel or load balancer.
  if (signature !== twilioSignature(config.authToken, publicRequestUrl(request.url), params)) {
    return twiml(say("Sorry, this call could not be verified."), 403);
  }

  // Resolve the call's tenant before opening a scoped transaction: this
  // request arrives from Twilio with no session and no service token, so the
  // call id is the only thing tying it to a tenant.
  // Global scope, not withoutScope: RLS is enforced on the app role and no
  // tenant is set yet, so an unscoped read of this table returns nothing and
  // the call silently loses its script. The call id was just proved to be one
  // this platform minted, so the lookup is bounded to that single row.
  const context = await withScope(
    { tenantId: null, globalScope: true, actorId: null, actorType: "service" },
    async (tx) => {
      const r = await tx.query<{
        tenant_id: string;
        campaign_id: string | null;
        lead_id: string | null;
      }>(`select tenant_id, campaign_id, lead_id from call_attempts where id = $1`, [callId]);
      return r.rows[0] ?? null;
    },
  );

  if (!context) return twiml(say("Sorry, we could not find this call."));

  const scope = {
    tenantId: context.tenant_id,
    globalScope: false,
    actorId: null,
    actorType: "service" as const,
  };

  return withScope(scope, async (tx) => {
    const campaign = await tx.query<{
      script: string | null;
      questions: Array<{ question: string }>;
      calling_config: { voice?: string; language?: string };
    }>(
      `select c.script, c.calling_config,
              coalesce(
                (select json_agg(json_build_object('question', q.question) order by q.position)
                   from qualification_rules q where q.campaign_id = c.id),
                '[]'::json
              ) as questions
         from campaigns c where c.id = $1`,
      [context.campaign_id],
    );

    const voice = new Voice(campaign.rows[0]?.calling_config ?? {});

    // The lead's own details, so the call can name them and say back what
    // they asked for rather than reading a template aloud.
    const lead = context.lead_id
      ? (
          await tx.query<{ name_enc: Buffer | null; enquiry_enc: Buffer | null }>(
            `select name_enc, enquiry_enc from leads where id = $1`,
            [context.lead_id],
          )
        ).rows[0] ?? null
      : null;

    const fields = {
      name: firstName(decryptPiiOrNull(lead?.name_enc ?? null)),
      requirement: decryptPiiOrNull(lead?.enquiry_enc ?? null),
    };

    const script = fill(
      campaign.rows[0]?.script ?? "Hello, calling about your recent enquiry.",
      fields,
    );
    const questions = (campaign.rows[0]?.questions ?? []).map((q) => fill(q.question, fields));

    // Twilio posts the previous <Gather>'s result on the next request.
    const heard = params.get("SpeechResult");
    if (heard && turn > 0) {
      await appendTurn(tx, context.tenant_id, callId, "Lead", heard, voice.languageTag);
    }

    // turn 0 is the opening; turns 1..n ask question n-1.
    const nextQuestion = questions[turn];

    if (nextQuestion === undefined) {
      await appendTurn(tx, context.tenant_id, callId, "Agent", CLOSING, voice.languageTag);
      return twiml(`${voice.say(CLOSING)}<Hangup/>`);
    }

    const spoken = turn === 0 ? `${script} ${nextQuestion}` : nextQuestion;
    await appendTurn(tx, context.tenant_id, callId, "Agent", spoken, voice.languageTag);

    const nextUrl =
      `${config.publicUrl}/api/webhooks/voice/twilio/twiml` +
      `?callId=${encodeURIComponent(callId)}&token=${token}&turn=${turn + 1}`;

    return twiml(
      `<Gather input="speech" speechTimeout="auto" language="${escapeXml(voice.languageTag)}"` +
        ` action="${escapeXml(nextUrl)}" method="POST">` +
        voice.say(spoken) +
        `</Gather>` +
        // Reached only if the caller says nothing: move on rather than hanging
        // in silence, so an unanswered question still produces a transcript.
        `<Redirect method="POST">${escapeXml(nextUrl)}</Redirect>`,
    );
  });
}

const CLOSING = "Thank you for your time. Someone will follow up shortly. Goodbye.";

/**
 * Append one turn to the call's transcript.
 *
 * Read-modify-write on an encrypted column rather than a turns table: the
 * transcript is one row per call, turns arrive strictly in order on a
 * single call leg, and a call has a handful of them. Sensitivity keeps it
 * encrypted at the application layer either way.
 */
async function appendTurn(
  tx: Parameters<Parameters<typeof withScope>[1]>[0],
  tenantId: string,
  callId: string,
  speaker: "Agent" | "Lead",
  text: string,
  language: string,
): Promise<void> {
  const existing = await tx.query<{ id: string; transcript_enc: Buffer | null }>(
    `select id, transcript_enc from call_transcripts where call_id = $1 for update`,
    [callId],
  );

  const line = `${speaker}: ${text.trim()}`;
  const row = existing.rows[0];

  if (!row) {
    await tx.query(
      `insert into call_transcripts (tenant_id, call_id, transcript_enc, language)
       values ($1, $2, $3, $4)`,
      [tenantId, callId, encryptPii(line), language],
    );
    return;
  }

  const previous = decryptPiiOrNull(row.transcript_enc) ?? "";
  await tx.query(`update call_transcripts set transcript_enc = $2 where id = $1`, [
    row.id,
    encryptPii(previous ? `${previous}\n${line}` : line),
  ]);
}

/**
 * Which voice reads the script.
 *
 * `Polly.Aditi` was the previous hard-coded default: a standard (non-neural)
 * Polly voice, and the reason calls sound flat and clipped. Neural voices are
 * a different engine and markedly better, but the available names change as
 * providers add them, so this is configuration rather than a constant -
 * `calling_config.voice` and `calling_config.language` on the campaign.
 *
 * Twilio's naming is `<Provider>.<Voice>` — for example `Polly.Kajal-Neural`
 * (Indian English, neural) or a `Google.en-IN-*` voice. An unrecognised name
 * makes Twilio fall back rather than fail, so a wrong value degrades to a
 * worse voice, not a silent call.
 *
 * None of this makes it a conversation. One question per turn, no barge-in, no
 * recovery from a misheard answer - a genuinely natural call needs a real
 * voice agent (Sarvam, ElevenLabs), not TwiML.
 */
class Voice {
  private readonly name: string;
  private readonly language: string;

  constructor(config: { voice?: string; language?: string }) {
    this.name = config.voice?.trim() || "Polly.Kajal-Neural";
    this.language = config.language?.trim() || "en-IN";
  }

  say(text: string): string {
    return `<Say voice="${escapeXml(this.name)}" language="${escapeXml(this.language)}">${escapeXml(text)}</Say>`;
  }

  get languageTag(): string {
    return this.language;
  }
}

/** For the failure paths, which answer before any campaign is known. */
const DEFAULT_VOICE = new Voice({});

function say(text: string): string {
  return DEFAULT_VOICE.say(text);
}


function twiml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
