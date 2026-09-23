"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failure, success, tenantAction, type ActionResult } from "@/lib/actions";
import { RESOLUTIONS, rescheduleCallback, resolveCallback } from "@/lib/calling/callbacks";

/**
 * Working the callback queue.
 *
 * Both actions need `callback:write`, which belongs to the Operations
 * Manager - the same person who owns the review queue, and for the same
 * reason: this is the point where a promise made on a call either gets kept or
 * is written off, and that should be one accountable role rather than anyone
 * who can see the page.
 */

const Resolve = z.object({
  tenantId: z.string().uuid(),
  callbackId: z.string().uuid(),
  resolution: z.enum(RESOLUTIONS),
  note: z.string().trim().max(500).nullable(),
});

export async function resolve(raw: unknown): Promise<ActionResult> {
  const parsed = Resolve.safeParse(raw);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid request");
  const { tenantId, callbackId, resolution, note } = parsed.data;

  return tenantAction({ tenantId, permission: "callback:write" }, async (ctx) => {
    const done = await resolveCallback(ctx.tx, {
      tenantId,
      callbackId,
      resolution,
      userId: ctx.user.id,
      userEmail: ctx.user.email,
      note: note && note.length > 0 ? note : null,
    });

    // Already resolved by someone else, or by the sweep, between the page
    // being rendered and the button being pressed.
    if (!done) return failure("This callback is no longer open. Reload the page.");

    revalidatePath("/callbacks");
    revalidatePath("/dashboard");
    return success();
  });
}

const Reschedule = z.object({
  tenantId: z.string().uuid(),
  callbackId: z.string().uuid(),
  // `datetime-local` sends wall-clock time with no zone; the browser's own
  // offset is applied here, which is the zone the operator typed it in.
  scheduledFor: z.coerce.date(),
});

export async function reschedule(
  raw: unknown,
): Promise<ActionResult<{ leadRequeued: boolean; leadStatus: string }>> {
  const parsed = Reschedule.safeParse(raw);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid date");
  const { tenantId, callbackId, scheduledFor } = parsed.data;

  if (Number.isNaN(scheduledFor.getTime())) return failure("Invalid date");
  if (scheduledFor.getTime() < Date.now()) {
    return failure("Pick a time in the future");
  }

  return tenantAction({ tenantId, permission: "callback:write" }, async (ctx) => {
    const result = await rescheduleCallback(ctx.tx, {
      tenantId,
      callbackId,
      scheduledFor,
      userId: ctx.user.id,
      userEmail: ctx.user.email,
    });

    if (!result.ok) return failure("This callback is no longer open. Reload the page.");

    revalidatePath("/callbacks");
    revalidatePath("/leads");
    return success({ leadRequeued: result.leadRequeued, leadStatus: result.leadStatus });
  });
}
