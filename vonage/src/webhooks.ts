import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  MessagingConsentLedger,
  MessagingConsentScope,
} from "@absolutejs/compliance";
import type {
  MessagingConsentEvent,
  MessagingDeliveryEvent,
  MessagingDeliveryStatus,
  MessagingInboundEvent,
  MessagingTransport,
} from "@absolutejs/dispatch";
import {
  drainWebhookInbox,
  type WebhookInboxStore,
} from "@absolutejs/reliability";
import type { VonageTransport } from "./adapter";

type VonageProviderEvent = {
  provider: "vonage";
  providerData: Readonly<Record<string, unknown>>;
};
export type VonageDeliveryEvent = MessagingDeliveryEvent & VonageProviderEvent;
export type VonageInboundEvent = MessagingInboundEvent & VonageProviderEvent;
export type VonageConsentEvent = MessagingConsentEvent & VonageProviderEvent;
export type VonageWebhookEvent =
  | VonageConsentEvent
  | VonageDeliveryEvent
  | VonageInboundEvent;

export type VonageWebhookAccountConfiguration = {
  apiKey: string;
  applicationIds?: ReadonlyArray<string>;
  /** Current secret first, optionally followed by the previous rotation secret. */
  signatureSecrets: readonly [string, ...string[]];
};

export type CreateVonageWebhookProcessorOptions = {
  consentLedger?: MessagingConsentLedger;
  handler: (event: VonageWebhookEvent) => Promise<void> | void;
  inbox: WebhookInboxStore<VonageWebhookEvent>;
  now?: () => number;
  replayToleranceMs?: number;
  resolveAccount: (
    apiKey: string,
  ) =>
    | Promise<VonageWebhookAccountConfiguration | undefined>
    | VonageWebhookAccountConfiguration
    | undefined;
  resolveConsentScopes?: (
    event: VonageConsentEvent,
  ) =>
    | Promise<
        ReadonlyArray<Omit<MessagingConsentScope, "recipient" | "transport">>
      >
    | ReadonlyArray<Omit<MessagingConsentScope, "recipient" | "transport">>;
  retentionMs?: number;
};

export class VonageWebhookError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "VonageWebhookError";
    this.status = status;
  }
}

type JwtClaims = {
  api_key?: string;
  application_id?: string;
  iat?: number;
  iss?: string;
  jti?: string;
  payload_hash?: string;
};

const parsePart = <T>(part: string): T => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    throw new VonageWebhookError(401, "invalid Vonage webhook JWT");
  }
};

const verifyJwt = async (
  token: string,
  rawBody: string,
  options: CreateVonageWebhookProcessorOptions,
) => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new VonageWebhookError(401, "invalid Vonage webhook JWT");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = parsePart<{ alg?: string; typ?: string }>(encodedHeader);
  const claims = parsePart<JwtClaims>(encodedClaims);
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new VonageWebhookError(401, "unsupported Vonage webhook JWT");
  }
  if (
    claims.iss !== "Vonage" ||
    typeof claims.api_key !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0
  ) {
    throw new VonageWebhookError(401, "invalid Vonage webhook claims");
  }
  const now = options.now?.() ?? Date.now();
  if (
    !Number.isFinite(claims.iat) ||
    Math.abs(now - claims.iat * 1000) >
      (options.replayToleranceMs ?? 5 * 60_000)
  ) {
    throw new VonageWebhookError(401, "stale Vonage webhook JWT");
  }
  const account = await options.resolveAccount(claims.api_key);
  if (account === undefined || account.apiKey !== claims.api_key) {
    throw new VonageWebhookError(401, "unknown Vonage API key");
  }
  if (
    account.signatureSecrets.length === 0 ||
    account.signatureSecrets.length > 2 ||
    account.signatureSecrets.some((secret) => secret.length < 4)
  ) {
    throw new VonageWebhookError(
      500,
      "one or two signature secrets are required",
    );
  }
  if (
    account.applicationIds !== undefined &&
    (claims.application_id === undefined ||
      !account.applicationIds.includes(claims.application_id))
  ) {
    throw new VonageWebhookError(403, "unexpected Vonage application");
  }
  const received = Buffer.from(encodedSignature, "base64url");
  const signed = `${encodedHeader}.${encodedClaims}`;
  const valid = account.signatureSecrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(signed).digest();
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  });
  if (!valid)
    throw new VonageWebhookError(401, "invalid Vonage webhook signature");
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  if (
    typeof claims.payload_hash !== "string" ||
    claims.payload_hash.length !== payloadHash.length ||
    !timingSafeEqual(Buffer.from(claims.payload_hash), Buffer.from(payloadHash))
  ) {
    throw new VonageWebhookError(401, "Vonage webhook payload hash mismatch");
  }
  return { account, claims };
};

const transportOf = (value: unknown): VonageTransport => {
  const transport = String(value ?? "").toLowerCase();
  if (transport === "facebook" || transport === "fb") return "messenger";
  if (
    transport === "messenger" ||
    transport === "mms" ||
    transport === "rcs" ||
    transport === "sms" ||
    transport === "viber" ||
    transport === "whatsapp"
  ) {
    return transport;
  }
  throw new VonageWebhookError(400, "unsupported Vonage webhook channel");
};

const endpoint = (address: unknown, transport: MessagingTransport) => {
  if (typeof address !== "string" || address.length === 0) return undefined;
  const carrierAddress = transport === "sms" || transport === "mms";
  return {
    address:
      carrierAddress && !address.startsWith("+") ? `+${address}` : address,
    transport,
  };
};

const normalizedStatus = (value: string): MessagingDeliveryStatus => {
  const status = value.toLowerCase();
  if (status === "submitted") return "accepted";
  if (status === "rejected") return "failed";
  if (status === "undeliverable") return "undeliverable";
  if (status === "delivered" || status === "read" || status === "sent")
    return status;
  if (status === "expired") return "expired";
  return "unknown";
};

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const normalize = (
  payload: Record<string, unknown>,
  apiKey: string,
  jti: string,
): VonageWebhookEvent => {
  const transport = transportOf(payload.channel);
  const messageId = String(payload.message_uuid ?? payload.messageuuid ?? "");
  if (messageId.length === 0) {
    throw new VonageWebhookError(400, "message_uuid is required");
  }
  const occurredAt = Date.parse(String(payload.timestamp ?? ""));
  if (!Number.isFinite(occurredAt)) {
    throw new VonageWebhookError(400, "valid timestamp is required");
  }
  const from = endpoint(payload.from, transport);
  const to = endpoint(payload.to, transport);
  const base = {
    actualTransport: transport,
    eventId: jti,
    ...(from === undefined ? {} : { from }),
    messageId,
    occurredAt,
    provider: "vonage" as const,
    providerAccountId: apiKey,
    providerData: payload,
    ...(to === undefined ? {} : { to }),
  };
  if (typeof payload.status === "string") {
    const usage = recordOf(payload.usage);
    const origin = recordOf(payload.destination ?? payload.origin);
    const sms = recordOf(payload.sms);
    const error = recordOf(payload.error);
    const workflow = recordOf(payload.workflow);
    const item = Number(
      workflow.item_number ?? workflow.items_number ?? workflow.itemNumber,
    );
    return {
      ...base,
      ...(typeof usage.currency === "string" && typeof usage.price === "string"
        ? {
            economics: {
              currency: usage.currency,
              price: usage.price,
              ...(Number.isInteger(Number(sms.total_count))
                ? { segments: Number(sms.total_count) }
                : {}),
            },
          }
        : {}),
      errors:
        Object.keys(error).length === 0
          ? []
          : [
              {
                ...(error.type === undefined
                  ? {}
                  : { code: String(error.type) }),
                ...(error.detail === undefined
                  ? {}
                  : { detail: String(error.detail) }),
                ...(error.title === undefined
                  ? {}
                  : { title: String(error.title) }),
              },
            ],
      kind: "delivery",
      ...(typeof origin.network_code === "string"
        ? { networkCode: origin.network_code }
        : {}),
      providerStatus: payload.status,
      status: normalizedStatus(payload.status),
      ...(Number.isInteger(item) && item > 0
        ? {
            attempt: {
              actualTransport: transport,
              errors: [],
              providerMessageId: messageId,
              providerStatus: payload.status,
              route:
                item === 1 ? ("primary" as const) : { fallbackIndex: item - 2 },
              status: normalizedStatus(payload.status),
              transport,
            },
          }
        : {}),
    } satisfies VonageDeliveryEvent;
  }
  const text = typeof payload.text === "string" ? payload.text : undefined;
  const keyword = text?.trim().toUpperCase();
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
      ...base,
      action: ["START", "UNSTOP"].includes(keyword)
        ? "grant"
        : ["HELP", "INFO"].includes(keyword)
          ? "help"
          : "revoke",
      keyword,
      kind: "consent",
    } satisfies VonageConsentEvent;
  }
  const messageType = String(payload.message_type ?? "text");
  const media = recordOf(payload[messageType]);
  const mediaUrl =
    typeof media.url === "string"
      ? media.url
      : typeof payload.url === "string"
        ? payload.url
        : undefined;
  const interactionPayload =
    typeof payload.postback_data === "string"
      ? payload.postback_data
      : typeof recordOf(payload.reply).postback_data === "string"
        ? String(recordOf(payload.reply).postback_data)
        : undefined;
  return {
    ...base,
    content:
      mediaUrl === undefined
        ? { kind: "text", text: text ?? "" }
        : {
            kind: "media",
            mediaUrls: [mediaUrl],
            ...(text === undefined ? {} : { text }),
          },
    ...(interactionPayload === undefined
      ? {}
      : { interaction: { payload: interactionPayload } }),
    kind: "inbound",
  } satisfies VonageInboundEvent;
};

export const createVonageWebhookProcessor = (
  options: CreateVonageWebhookProcessorOptions,
) => ({
  process: async (input: {
    authorization: string | undefined;
    rawBody: string;
  }) => {
    if (input.authorization?.startsWith("Bearer ") !== true) {
      throw new VonageWebhookError(401, "missing Vonage Bearer webhook JWT");
    }
    const { account, claims } = await verifyJwt(
      input.authorization.slice("Bearer ".length),
      input.rawBody,
      options,
    );
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw new VonageWebhookError(400, "invalid Vonage webhook JSON");
    }
    const event = normalize(payload, account.apiKey, claims.jti!);
    const now = options.now?.() ?? Date.now();
    await options.inbox.purgeCompleted(
      now - (options.retentionMs ?? 24 * 60 * 60_000),
    );
    const claim = await options.inbox.accept({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      payload: event,
      provider: "vonage",
      streamId: account.apiKey,
    });
    if (claim.token === undefined) {
      return { disposition: "duplicate" as const, event };
    }
    try {
      if (
        event.kind === "consent" &&
        event.action !== "help" &&
        options.consentLedger !== undefined
      ) {
        if (event.from === undefined) {
          throw new VonageWebhookError(400, "consent sender is required");
        }
        const scopes = await options.resolveConsentScopes?.(event);
        if (scopes === undefined || scopes.length === 0) {
          throw new VonageWebhookError(
            500,
            "consent scope resolver returned no programs",
          );
        }
        for (const scope of scopes) {
          const fullScope = {
            ...scope,
            recipient: event.from.address,
            transport: event.from.transport,
          };
          const evidence = {
            at: event.occurredAt,
            idempotencyKey: `vonage:${event.eventId}:${scope.programId}:${event.from.transport}`,
            source: "vonage-opt-out",
          };
          if (event.action === "grant") {
            await options.consentLedger.grant(fullScope, evidence);
          } else {
            await options.consentLedger.revoke(fullScope, evidence);
          }
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

export const drainVonageWebhookInbox = async (
  options: Pick<CreateVonageWebhookProcessorOptions, "handler" | "inbox">,
) =>
  drainWebhookInbox({
    handler: async ({ payload }) => options.handler(payload),
    store: options.inbox,
  });

export const createVonageWebhookHandler = (
  options: CreateVonageWebhookProcessorOptions,
) => {
  const processor = createVonageWebhookProcessor(options);
  return async (request: Request) => {
    try {
      const result = await processor.process({
        authorization: request.headers.get("authorization") ?? undefined,
        rawBody: await request.text(),
      });
      return Response.json(
        { disposition: result.disposition, eventId: result.event.eventId },
        { status: 200 },
      );
    } catch (error) {
      const status = error instanceof VonageWebhookError ? error.status : 500;
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status },
      );
    }
  };
};
