/**
 * Calling windows (FR-021: "Respect configurable campaign calling windows and
 * timezone. Calls outside window are delayed.").
 *
 * The window is expressed in the campaign's own IANA timezone, not the
 * server's. An agency in one country calling leads in another gets this wrong
 * the moment anyone deploys to a differently-configured host, so the
 * conversion is done explicitly against the campaign timezone every time.
 */

export interface CallingWindow {
  /** "HH:MM" in the campaign timezone. */
  windowStart: string;
  windowEnd: string;
  timezone: string;
  /** 0 = Sunday. Defaults to every day when unset. */
  days?: number[];
}

export interface WindowDecision {
  allowed: boolean;
  /** When not allowed, the next instant the window opens. */
  nextOpenAt: Date;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(value: string): { hour: number; minute: number } {
  const m = HHMM.exec(value);
  if (!m) throw new Error(`Invalid time-of-day: ${value} (expected HH:MM)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Local wall-clock fields for `instant` in `timezone`. Intl is the only
 * dependency-free way to do this correctly across DST.
 */
export function zonedParts(instant: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // "24" appears at midnight under hour12:false in some runtimes.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: Math.max(0, weekdays.indexOf(parts.weekday ?? "Sun")),
  };
}

/** UTC instant for a wall-clock time in `timezone`, correct across DST. */
export function zonedTimeToUtc(
  timezone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  // Guess, measure the zone's offset at that guess, then correct. Two passes
  // settle the DST-boundary cases the single-pass version gets wrong.
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const target = Date.UTC(y, mo - 1, d, h, mi);
    const drift = target - actual;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

export function isWithinWindow(now: Date, window: CallingWindow): WindowDecision {
  const start = parseHHMM(window.windowStart);
  const end = parseHHMM(window.windowEnd);
  const allowedDays = window.days ?? [0, 1, 2, 3, 4, 5, 6];

  const local = zonedParts(now, window.timezone);
  const minutesNow = local.hour * 60 + local.minute;
  const minutesStart = start.hour * 60 + start.minute;
  const minutesEnd = end.hour * 60 + end.minute;

  if (minutesEnd <= minutesStart) {
    throw new Error(
      `Calling window end (${window.windowEnd}) must be after start (${window.windowStart})`,
    );
  }

  const dayAllowed = allowedDays.includes(local.weekday);
  if (dayAllowed && minutesNow >= minutesStart && minutesNow < minutesEnd) {
    return { allowed: true, nextOpenAt: now };
  }

  // Walk forward to the next permitted day whose window has not already closed.
  for (let offset = 0; offset <= 7; offset += 1) {
    const probe = new Date(now.getTime() + offset * 86_400_000);
    const probeLocal = zonedParts(probe, window.timezone);
    if (!allowedDays.includes(probeLocal.weekday)) continue;

    const opensAt = zonedTimeToUtc(
      window.timezone,
      probeLocal.year,
      probeLocal.month,
      probeLocal.day,
      start.hour,
      start.minute,
    );
    if (opensAt.getTime() > now.getTime()) return { allowed: false, nextOpenAt: opensAt };
  }

  throw new Error("Calling window configuration never opens");
}

export function windowFromConfig(
  callingConfig: Record<string, unknown>,
  campaignTimezone: string,
): CallingWindow {
  return {
    windowStart: (callingConfig.window_start as string) ?? "09:30",
    windowEnd: (callingConfig.window_end as string) ?? "18:30",
    timezone: (callingConfig.timezone as string) ?? campaignTimezone,
    days: callingConfig.days as number[] | undefined,
  };
}
