"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, success, tenantAction, type ActionResult } from "@/lib/actions";
import { replaySync } from "@/lib/integrations/outbox";

/**
 * Manual replay of a dead-lettered sync.
 *
 * `replaySync` has existed since Phase 1; what did not exist was any way to
 * call it. A row that exhausted its retries was therefore visible only to
 * someone willing to write SQL against production - which in practice means a
 * qualified hot lead that never reached the client's CRM sat there
 * indefinitely, with the audit log dutifully recording that it had been
 * abandoned.
 *
 * Replay is deliberately an explicit operator action rather than an automatic
 * one. A row reaches dead-letter either by failing eight times on the backoff
 * ladder or by failing in a way classified as permanent - a revoked token, a
 * spreadsheet nobody shared. Re-queueing those on a timer would just walk the
 * same ladder again and dead-letter again. Something has to have been fixed
 * first, and only a person knows whether it has.
 */

const Replay = z.object({
  tenantId: z.string().uuid(),
  id: z.string().uuid(),
});

export async function replayDeadLetter(formData: FormData): Promise<ActionResult> {
  const parsed = Replay.safeParse({
    tenantId: formData.get("tenantId"),
    id: formData.get("id"),
  });
  if (!parsed.success) return failure("Invalid request");

  /**
   * Gated on `integration:write` rather than a new permission of its own.
   * Replaying is retrying a delivery to a configured destination, and the
   * reason a replay is worth attempting is almost always that the credential
   * or destination behind it was just fixed - which is the same permission and
   * usually the same person, in the same sitting.
   */
  return tenantAction(
    { tenantId: parsed.data.tenantId, permission: "integration:write" },
    async (ctx) => {
      const replayed = await replaySync(ctx.tx, parsed.data.id);

      // RLS scopes the update to this tenant, so a row belonging to another
      // client is indistinguishable from one that does not exist -
      // and a row that has already been replayed is no longer dead-lettered,
      // which lands here too rather than being queued twice.
      if (!replayed) {
        return failure("That delivery is no longer dead-lettered - it may already be queued");
      }

      await ctx.audit({
        action: "sync.replayed",
        entityType: "sync_outbox",
        entityId: parsed.data.id,
      });

      revalidatePath("/integrations");
      return success();
    },
  );
}

const ReplayAll = z.object({
  tenantId: z.string().uuid(),
  target: z.enum(["hubspot", "google_sheets", "notification"]),
});

/**
 * Replay every dead letter for one destination.
 *
 * Scoped to a single target rather than offering a blanket "replay
 * everything", because dead letters arrive in exactly that shape: an expired
 * HubSpot token strands every CRM sync for a client and nothing else. Making
 * the operator pick the destination they just fixed keeps the button from
 * being a way to re-queue a hundred rows that are still going to fail, which
 * is a slow rate-limit burn rather than a recovery.
 */
export async function replayAllForTarget(formData: FormData): Promise<ActionResult<{ replayed: number }>> {
  const parsed = ReplayAll.safeParse({
    tenantId: formData.get("tenantId"),
    target: formData.get("target"),
  });
  if (!parsed.success) return failure("Invalid request");

  return tenantAction(
    { tenantId: parsed.data.tenantId, permission: "integration:write" },
    async (ctx) => {
      const r = await ctx.tx.query<{ id: string }>(
        `update sync_outbox
            set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
          where target = $1 and status = 'dead_letter'
          returning id`,
        [parsed.data.target],
      );

      const ids = r.rows.map((row) => row.id);

      if (ids.length > 0) {
        await ctx.audit({
          action: "sync.replayed_bulk",
          entityType: "sync_outbox",
          entityId: parsed.data.target,
          metadata: { count: ids.length, ids: ids.slice(0, 50) },
        });
      }

      revalidatePath("/integrations");
      return success({ replayed: ids.length });
    },
  );
}
