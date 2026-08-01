export const TWILIO_MESSAGE_STATUSES = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "canceled",
  "read",
] as const;

export type TwilioMessageStatus = (typeof TWILIO_MESSAGE_STATUSES)[number];
export type TwilioOptOutType = "HELP" | "START" | "STOP";

type TwilioWebhookEventBase = {
  accountSid: string;
  eventId: string;
  from?: string;
  messageSid: string;
  receivedAt: number;
  to?: string;
};

export type TwilioStatusEvent = TwilioWebhookEventBase & {
  /** Actual provider channel. RCS fallback callbacks omit the `rcs` prefix. */
  actualTransport?: "mms" | "rcs" | "sms" | "whatsapp";
  errorCode?: number;
  kind: "status";
  raw: Readonly<Record<string, string>>;
  status: TwilioMessageStatus;
};

export type TwilioConsentEvent = TwilioWebhookEventBase & {
  body?: string;
  buttonPayload?: string;
  buttonText?: string;
  kind: "consent";
  optOutType: TwilioOptOutType;
  raw: Readonly<Record<string, string>>;
};

export type TwilioInboundMedia = {
  contentType?: string;
  url: string;
};

export type TwilioInboundEvent = TwilioWebhookEventBase & {
  body?: string;
  buttonPayload?: string;
  buttonText?: string;
  kind: "inbound";
  media: ReadonlyArray<TwilioInboundMedia>;
  raw: Readonly<Record<string, string>>;
};

export type TwilioWebhookEvent =
  | TwilioConsentEvent
  | TwilioInboundEvent
  | TwilioStatusEvent;
export type TwilioLifecycleDisposition = "accepted" | "duplicate" | "stale";

export type TwilioLifecycleClaim = {
  /** Present only when this worker owns delivery to the event consumer. */
  claimToken?: string;
  disposition: TwilioLifecycleDisposition;
  previousStatus?: TwilioMessageStatus;
};

export type TwilioLifecycleWorkItem = TwilioLifecycleClaim & {
  claimToken: string;
  event: TwilioWebhookEvent;
};

/**
 * Atomic persistence boundary. Implementations must commit the event and status
 * transition before resolving `accepted`; duplicate event ids must never be
 * accepted twice across processes.
 */
export type TwilioLifecycleStore = {
  readonly durability: "durable" | "memory";
  /**
   * Atomically records/deduplicates the event and, when work remains, leases
   * consumer delivery to this worker. Durable stores must expire abandoned
   * leases so a later Twilio retry can obtain a new claim token. Reclaimed
   * status events must be checked against the latest status again so an older
   * pending callback cannot be delivered after a newer terminal state.
   */
  begin: (event: TwilioWebhookEvent) => Promise<TwilioLifecycleClaim>;
  /** Claims accepted work left behind after Twilio stops retrying or a worker crashes. */
  claimPending: (limit?: number) => Promise<TwilioLifecycleWorkItem[]>;
  /** Atomically marks the claimed event delivered to the consumer. */
  complete: (eventId: string, claimToken: string) => Promise<void>;
  /** Releases a claim after a consumer failure so the event can be retried. */
  release: (eventId: string, claimToken: string) => Promise<void>;
  /** Exports the bounded, redacted stored lifecycle for one provider message. */
  exportMessage: (messageSid: string) => Promise<TwilioWebhookEvent[]>;
  /** Deletes stored webhook payloads after their configured retention deadline. */
  purgeExpired: (at?: number) => Promise<number>;
};

export type TwilioLifecycleRetentionOptions = {
  /** Retain normalized message bodies, buttons, and media URLs for recovery. */
  retainContent?: boolean;
  /** Retain normalized From/To addresses for recovery. */
  retainAddresses?: boolean;
  /** Raw form fields are discarded by default. */
  retainRaw?: boolean;
  /** Bounded payload retention. Defaults to seven days. */
  retentionMs?: number;
  /** Worker claim lease. Defaults to 60 seconds. */
  claimTtlMs?: number;
  now?: () => number;
};

export const redactTwilioWebhookEvent = (
  event: TwilioWebhookEvent,
  options: Pick<
    TwilioLifecycleRetentionOptions,
    "retainAddresses" | "retainContent" | "retainRaw"
  >,
): TwilioWebhookEvent => {
  const copy = structuredClone(event) as TwilioWebhookEvent;
  if (options.retainRaw !== true) copy.raw = Object.freeze({});
  if (options.retainAddresses === false) {
    delete copy.from;
    delete copy.to;
  }
  if (options.retainContent === false) {
    if (copy.kind === "inbound" || copy.kind === "consent") {
      delete copy.body;
      delete copy.buttonPayload;
      delete copy.buttonText;
    }
    if (copy.kind === "inbound") copy.media = [];
  }
  return copy;
};

const STATUS_ORDER: Record<TwilioMessageStatus, number> = {
  accepted: 0,
  scheduled: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
  canceled: 4,
  read: 5,
};

const TERMINAL = new Set<TwilioMessageStatus>([
  "canceled",
  "delivered",
  "failed",
  "read",
  "undelivered",
]);

export const classifyTwilioStatusTransition = (
  previous: TwilioMessageStatus | undefined,
  next: TwilioMessageStatus,
): Exclude<TwilioLifecycleDisposition, "duplicate"> => {
  if (previous === undefined) return "accepted";
  if (previous === "delivered" && next === "read") return "accepted";
  if (TERMINAL.has(previous)) return "stale";
  return STATUS_ORDER[next] >= STATUS_ORDER[previous] ? "accepted" : "stale";
};

/** Development/test store. Production readiness intentionally rejects it. */
export const createMemoryTwilioLifecycleStore = (
  options: TwilioLifecycleRetentionOptions = {},
): TwilioLifecycleStore => {
  const now = options.now ?? Date.now;
  const claimTtlMs = options.claimTtlMs ?? 60_000;
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs < 1_000) {
    throw new TypeError("claimTtlMs must be an integer of at least 1000");
  }
  if (!Number.isInteger(retentionMs) || retentionMs < 1_000) {
    throw new TypeError("retentionMs must be an integer of at least 1000");
  }
  const events = new Map<
    string,
    {
      claimToken?: string;
      claimedUntil?: number;
      complete: boolean;
      event: TwilioWebhookEvent;
      expiresAt: number;
      disposition: "accepted" | "duplicate";
    }
  >();
  const statuses = new Map<string, TwilioMessageStatus>();
  let nextClaim = 1;

  return {
    durability: "memory",
    begin: async (event) => {
      const existing = events.get(event.eventId);
      if (existing !== undefined) {
        if (
          existing.complete ||
          (existing.claimToken !== undefined &&
            (existing.claimedUntil ?? 0) > now())
        ) {
          return { disposition: "duplicate" };
        }
        if (event.kind === "status") {
          const previousStatus = statuses.get(event.messageSid);
          if (
            previousStatus !== event.status &&
            classifyTwilioStatusTransition(previousStatus, event.status) ===
              "stale"
          ) {
            existing.complete = true;
            return {
              disposition: "stale",
              ...(previousStatus === undefined ? {} : { previousStatus }),
            };
          }
        }
        const claimToken = `memory-claim-${nextClaim++}`;
        existing.claimToken = claimToken;
        existing.claimedUntil = now() + claimTtlMs;
        return { claimToken, disposition: "duplicate" };
      }

      if (event.kind !== "status") {
        const claimToken = `memory-claim-${nextClaim++}`;
        events.set(event.eventId, {
          claimToken,
          claimedUntil: now() + claimTtlMs,
          complete: false,
          disposition: "accepted",
          event: redactTwilioWebhookEvent(event, options),
          expiresAt: event.receivedAt + retentionMs,
        });
        return { claimToken, disposition: "accepted" };
      }

      const previousStatus = statuses.get(event.messageSid);
      const disposition = classifyTwilioStatusTransition(
        previousStatus,
        event.status,
      );
      if (disposition === "accepted") {
        statuses.set(event.messageSid, event.status);
      }
      const claimToken =
        disposition === "accepted" ? `memory-claim-${nextClaim++}` : undefined;
      events.set(event.eventId, {
        ...(claimToken === undefined ? {} : { claimToken }),
        ...(claimToken === undefined
          ? {}
          : { claimedUntil: now() + claimTtlMs }),
        complete: disposition === "stale",
        disposition: "accepted",
        event: redactTwilioWebhookEvent(event, options),
        expiresAt: event.receivedAt + retentionMs,
      });
      return {
        ...(claimToken === undefined ? {} : { claimToken }),
        disposition,
        ...(previousStatus === undefined ? {} : { previousStatus }),
      };
    },
    claimPending: async (limit = 100) => {
      const work: TwilioLifecycleWorkItem[] = [];
      for (const entry of [...events.values()].sort(
        (left, right) => left.event.receivedAt - right.event.receivedAt,
      )) {
        if (work.length >= limit) break;
        if (
          entry.complete ||
          (entry.claimToken !== undefined && (entry.claimedUntil ?? 0) > now())
        )
          continue;
        const claimToken = `memory-claim-${nextClaim++}`;
        entry.claimToken = claimToken;
        entry.claimedUntil = now() + claimTtlMs;
        work.push({
          claimToken,
          disposition: "duplicate",
          event: structuredClone(entry.event),
        });
      }
      return work;
    },
    complete: async (eventId, claimToken) => {
      const event = events.get(eventId);
      if (event?.claimToken !== claimToken) {
        throw new Error("invalid Twilio lifecycle claim completion");
      }
      event.complete = true;
      delete event.claimToken;
      delete event.claimedUntil;
    },
    release: async (eventId, claimToken) => {
      const event = events.get(eventId);
      if (event?.claimToken === claimToken) {
        delete event.claimToken;
        delete event.claimedUntil;
      }
    },
    exportMessage: async (messageSid) =>
      [...events.values()]
        .filter(({ event }) => event.messageSid === messageSid)
        .sort((left, right) => left.event.receivedAt - right.event.receivedAt)
        .map(({ event }) => structuredClone(event)),
    purgeExpired: async (at = now()) => {
      let purged = 0;
      for (const [eventId, entry] of events) {
        if (entry.expiresAt <= at) {
          events.delete(eventId);
          purged += 1;
        }
      }
      return purged;
    },
  };
};
