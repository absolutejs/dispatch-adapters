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
  errorCode?: number;
  kind: "status";
  raw: Readonly<Record<string, string>>;
  status: TwilioMessageStatus;
};

export type TwilioConsentEvent = TwilioWebhookEventBase & {
  body?: string;
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
  /** Atomically marks the claimed event delivered to the consumer. */
  complete: (eventId: string, claimToken: string) => Promise<void>;
  /** Releases a claim after a consumer failure so the event can be retried. */
  release: (eventId: string, claimToken: string) => Promise<void>;
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
export const createMemoryTwilioLifecycleStore = (): TwilioLifecycleStore => {
  const events = new Map<string, { claimToken?: string; complete: boolean }>();
  const statuses = new Map<string, TwilioMessageStatus>();
  let nextClaim = 1;

  return {
    durability: "memory",
    begin: async (event) => {
      const existing = events.get(event.eventId);
      if (existing !== undefined) {
        if (existing.complete || existing.claimToken !== undefined) {
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
        return { claimToken, disposition: "duplicate" };
      }

      if (event.kind !== "status") {
        const claimToken = `memory-claim-${nextClaim++}`;
        events.set(event.eventId, { claimToken, complete: false });
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
        complete: disposition === "stale",
      });
      return {
        ...(claimToken === undefined ? {} : { claimToken }),
        disposition,
        ...(previousStatus === undefined ? {} : { previousStatus }),
      };
    },
    complete: async (eventId, claimToken) => {
      const event = events.get(eventId);
      if (event?.claimToken !== claimToken) {
        throw new Error("invalid Twilio lifecycle claim completion");
      }
      event.complete = true;
      delete event.claimToken;
    },
    release: async (eventId, claimToken) => {
      const event = events.get(eventId);
      if (event?.claimToken === claimToken) delete event.claimToken;
    },
  };
};
