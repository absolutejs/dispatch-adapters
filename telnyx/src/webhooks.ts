import { verify } from "node:crypto";
import type {
  MessagingConsentLedger,
  MessagingConsentScope,
} from "@absolutejs/compliance";
import {
  drainWebhookInbox,
  type WebhookInboxStore,
} from "@absolutejs/reliability";
import type { MessagingTransport } from "@absolutejs/dispatch";

export type TelnyxDeliveryEvent = {
  actualTransport: MessagingTransport;
  errors: ReadonlyArray<{ code?: string; detail?: string; title?: string }>;
  eventId: string;
  kind: "delivery";
  messageId: string;
  occurredAt: number;
  status: string;
  to?: string;
};

export type TelnyxInboundEvent = {
  actualTransport: MessagingTransport;
  body?: string;
  eventId: string;
  from?: string;
  interactivePayload?: string;
  kind: "inbound";
  media: ReadonlyArray<{ contentType?: string; url: string }>;
  messageId: string;
  occurredAt: number;
  to?: string;
};

export type TelnyxConsentEvent = {
  action: "grant" | "help" | "revoke";
  eventId: string;
  from: string;
  keyword: string;
  kind: "consent";
  messageId: string;
  occurredAt: number;
  transport: MessagingTransport;
};

export type TelnyxWebhookEvent =
  | TelnyxConsentEvent
  | TelnyxDeliveryEvent
  | TelnyxInboundEvent;

export type TelnyxWebhookEnvelope = {
  data?: {
    event_type?: string;
    id?: string;
    occurred_at?: string;
    payload?: Record<string, unknown>;
  };
};

export type TelnyxWebhookAccountConfiguration = {
  accountId: string;
  messagingProfileIds?: ReadonlyArray<string>;
  publicKeys: ReadonlyArray<string>;
};

export type CreateTelnyxWebhookProcessorOptions = {
  consentLedger?: MessagingConsentLedger;
  handler: (event: TelnyxWebhookEvent) => Promise<void> | void;
  inbox: WebhookInboxStore<TelnyxWebhookEvent>;
  now?: () => number;
  replayToleranceMs?: number;
  resolveAccount: (
    organizationId: string,
  ) =>
    | Promise<TelnyxWebhookAccountConfiguration | undefined>
    | TelnyxWebhookAccountConfiguration
    | undefined;
  resolveConsentScopes?: (
    event: TelnyxConsentEvent,
  ) =>
    | Promise<
        ReadonlyArray<Omit<MessagingConsentScope, "recipient" | "transport">>
      >
    | ReadonlyArray<Omit<MessagingConsentScope, "recipient" | "transport">>;
  retentionMs?: number;
};

export class TelnyxWebhookError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TelnyxWebhookError";
    this.status = status;
  }
}

const E164 = /^\+[1-9]\d{1,14}$/;
const transportOf = (value: unknown): MessagingTransport => {
  const normalized = String(value ?? "SMS").toLowerCase();
  if (normalized === "mms" || normalized === "rcs" || normalized === "whatsapp")
    return normalized;
  return "sms";
};
const addressOf = (value: unknown) => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return typeof row.phone_number === "string" ? row.phone_number : undefined;
  }
  return undefined;
};

const normalize = (envelope: TelnyxWebhookEnvelope): TelnyxWebhookEvent => {
  const data = envelope.data;
  const eventId = data?.id;
  const payload = data?.payload;
  const messageId = typeof payload?.id === "string" ? payload.id : undefined;
  if (
    data === undefined ||
    payload === undefined ||
    eventId === undefined ||
    messageId === undefined ||
    data.event_type === undefined
  ) {
    throw new TelnyxWebhookError(400, "invalid Telnyx webhook envelope");
  }
  const occurredAt = Date.parse(data.occurred_at ?? "");
  if (!Number.isFinite(occurredAt))
    throw new TelnyxWebhookError(400, "invalid occurred_at");
  const actualTransport = transportOf(payload.type);
  const firstTo = Array.isArray(payload.to) ? payload.to[0] : payload.to;
  const from = addressOf(payload.from);
  const to = addressOf(firstTo);
  if (
    data.event_type === "message.sent" ||
    data.event_type === "message.finalized"
  ) {
    const errors = Array.isArray(payload.errors)
      ? payload.errors.map((error) => {
          const row = error as Record<string, unknown>;
          return {
            ...(row.code === undefined ? {} : { code: String(row.code) }),
            ...(row.detail === undefined ? {} : { detail: String(row.detail) }),
            ...(row.title === undefined ? {} : { title: String(row.title) }),
          };
        })
      : [];
    return {
      actualTransport,
      errors,
      eventId,
      kind: "delivery",
      messageId,
      occurredAt,
      status:
        typeof (firstTo as Record<string, unknown> | undefined)?.status ===
        "string"
          ? String((firstTo as Record<string, unknown>).status)
          : data.event_type === "message.sent"
            ? "sent"
            : "unknown",
      ...(to === undefined ? {} : { to }),
    };
  }
  if (data.event_type !== "message.received") {
    throw new TelnyxWebhookError(
      400,
      `unsupported Telnyx event ${data.event_type}`,
    );
  }
  const body = typeof payload.text === "string" ? payload.text : undefined;
  const keyword = body?.trim().toUpperCase();
  if (
    from !== undefined &&
    keyword !== undefined &&
    [
      "STOP",
      "UNSUBSCRIBE",
      "CANCEL",
      "END",
      "QUIT",
      "START",
      "UNSTOP",
      "HELP",
      "INFO",
    ].includes(keyword)
  ) {
    return {
      action: ["START", "UNSTOP"].includes(keyword)
        ? "grant"
        : ["HELP", "INFO"].includes(keyword)
          ? "help"
          : "revoke",
      eventId,
      from,
      keyword,
      kind: "consent",
      messageId,
      occurredAt,
      transport: actualTransport,
    };
  }
  const media = Array.isArray(payload.media)
    ? payload.media.flatMap((item) => {
        const row = item as Record<string, unknown>;
        return typeof row.url !== "string"
          ? []
          : [
              {
                ...(row.content_type === undefined
                  ? {}
                  : { contentType: String(row.content_type) }),
                url: row.url,
              },
            ];
      })
    : [];
  return {
    actualTransport,
    ...(body === undefined ? {} : { body }),
    eventId,
    ...(from === undefined ? {} : { from }),
    ...(typeof payload.postback_data === "string"
      ? { interactivePayload: payload.postback_data }
      : {}),
    kind: "inbound",
    media,
    messageId,
    occurredAt,
    ...(to === undefined ? {} : { to }),
  };
};

const organizationOf = (envelope: TelnyxWebhookEnvelope) => {
  const value = envelope.data?.payload?.organization_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new TelnyxWebhookError(400, "organization_id is required");
  }
  return value;
};

const verifySignature = (
  rawBody: string,
  timestamp: string,
  signature: string,
  keys: ReadonlyArray<string>,
) => {
  if (keys.length === 0 || keys.length > 2) {
    throw new TelnyxWebhookError(
      500,
      "one or two active Telnyx public keys are required",
    );
  }
  const signed = Buffer.from(`${timestamp}|${rawBody}`);
  const signatureBytes = Buffer.from(signature, "base64");
  return keys.some((key) => {
    try {
      return verify(null, signed, key, signatureBytes);
    } catch {
      return false;
    }
  });
};

export const createTelnyxWebhookProcessor = (
  options: CreateTelnyxWebhookProcessorOptions,
) => ({
  process: async (input: {
    rawBody: string;
    signature: string | undefined;
    timestamp: string | undefined;
  }) => {
    if (input.signature === undefined || input.timestamp === undefined) {
      throw new TelnyxWebhookError(401, "missing Telnyx signature headers");
    }
    let envelope: TelnyxWebhookEnvelope;
    try {
      envelope = JSON.parse(input.rawBody) as TelnyxWebhookEnvelope;
    } catch {
      throw new TelnyxWebhookError(400, "invalid JSON body");
    }
    const organizationId = organizationOf(envelope);
    const account = await options.resolveAccount(organizationId);
    if (account === undefined || account.accountId !== organizationId) {
      throw new TelnyxWebhookError(401, "unknown Telnyx organization");
    }
    const timestampMs = Number(input.timestamp) * 1000;
    const now = options.now?.() ?? Date.now();
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(now - timestampMs) > (options.replayToleranceMs ?? 5 * 60_000)
    ) {
      throw new TelnyxWebhookError(401, "stale Telnyx webhook timestamp");
    }
    if (
      !verifySignature(
        input.rawBody,
        input.timestamp,
        input.signature,
        account.publicKeys,
      )
    ) {
      throw new TelnyxWebhookError(401, "invalid Telnyx webhook signature");
    }
    const profile = envelope.data?.payload?.messaging_profile_id;
    if (
      account.messagingProfileIds !== undefined &&
      (typeof profile !== "string" ||
        !account.messagingProfileIds.includes(profile))
    ) {
      throw new TelnyxWebhookError(
        403,
        "messaging profile is not bound to this endpoint",
      );
    }
    const event = normalize(envelope);
    await options.inbox.purgeCompleted(
      now - (options.retentionMs ?? 24 * 60 * 60_000),
    );
    const claim = await options.inbox.accept({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      payload: event,
      provider: "telnyx",
      streamId: organizationId,
    });
    if (claim.token === undefined)
      return { disposition: "duplicate" as const, event };
    try {
      if (
        event.kind === "consent" &&
        event.action !== "help" &&
        options.consentLedger !== undefined
      ) {
        if (!E164.test(event.from))
          throw new TelnyxWebhookError(400, "consent sender must be E.164");
        const scopes = await options.resolveConsentScopes?.(event);
        if (scopes === undefined || scopes.length === 0)
          throw new TelnyxWebhookError(
            500,
            "consent scope resolver returned no programs",
          );
        for (const scope of scopes) {
          const evidence = {
            at: event.occurredAt,
            idempotencyKey: `telnyx:${event.eventId}:${scope.programId}:${event.transport}`,
            source: "telnyx-opt-out",
          };
          const fullScope = {
            ...scope,
            recipient: event.from,
            transport: event.transport,
          };
          if (event.action === "grant")
            await options.consentLedger.grant(fullScope, evidence);
          else await options.consentLedger.revoke(fullScope, evidence);
        }
      }
      await options.handler(event);
      await options.inbox.complete(event.eventId, claim.token, now);
      return { disposition: "processed" as const, event };
    } catch (error) {
      await options.inbox
        .release(event.eventId, claim.token)
        .catch(() => undefined);
      throw error;
    }
  },
});

export const drainTelnyxWebhookInbox = async (
  options: Pick<CreateTelnyxWebhookProcessorOptions, "handler" | "inbox">,
) =>
  drainWebhookInbox({
    handler: async ({ payload }) => options.handler(payload),
    store: options.inbox,
  });

export const createTelnyxWebhookHandler = (
  options: CreateTelnyxWebhookProcessorOptions,
) => {
  const processor = createTelnyxWebhookProcessor(options);
  return async (request: Request) => {
    try {
      const result = await processor.process({
        rawBody: await request.text(),
        signature: request.headers.get("telnyx-signature-ed25519") ?? undefined,
        timestamp: request.headers.get("telnyx-timestamp") ?? undefined,
      });
      return new Response(JSON.stringify({ disposition: result.disposition }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    } catch (error) {
      const status = error instanceof TelnyxWebhookError ? error.status : 500;
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        {
          headers: { "content-type": "application/json" },
          status,
        },
      );
    }
  };
};
