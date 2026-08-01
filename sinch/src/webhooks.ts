import { createHmac, timingSafeEqual } from "node:crypto";
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
import type { SinchTransport } from "./adapter";

type SinchProviderEvent = {
  provider: "sinch";
  providerData: Readonly<Record<string, unknown>>;
};
export type SinchDeliveryEvent = MessagingDeliveryEvent & SinchProviderEvent;
export type SinchInboundEvent = MessagingInboundEvent & SinchProviderEvent;
export type SinchConsentEvent = MessagingConsentEvent & SinchProviderEvent;
export type SinchCapabilityEvent = SinchProviderEvent & {
  eventId: string;
  features: ReadonlyArray<string>;
  identity: string;
  kind: "capability";
  occurredAt: number;
  providerAccountId: string;
  requestId: string;
  status: string;
  transport: SinchTransport;
};
export type SinchWebhookEvent =
  | SinchCapabilityEvent
  | SinchConsentEvent
  | SinchDeliveryEvent
  | SinchInboundEvent;

export type SinchWebhookAccountConfiguration = {
  appIds: ReadonlyArray<string>;
  projectId: string;
  /** Current secret first, optionally followed by the previous rotation secret. */
  signatureSecrets: readonly [string, ...string[]];
};

export type SinchWebhookHeaders = {
  algorithm: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
};

export type CreateSinchWebhookProcessorOptions = {
  consentLedger?: MessagingConsentLedger;
  handler: (event: SinchWebhookEvent) => Promise<void> | void;
  inbox: WebhookInboxStore<SinchWebhookEvent>;
  now?: () => number;
  replayToleranceMs?: number;
  resolveAccount: (
    accountKey: string,
  ) =>
    | Promise<SinchWebhookAccountConfiguration | undefined>
    | SinchWebhookAccountConfiguration
    | undefined;
  resolveConsentScopes?: (
    event: SinchConsentEvent,
  ) =>
    | Promise<
        ReadonlyArray<Omit<MessagingConsentScope, "recipient" | "transport">>
      >
    | ReadonlyArray<Omit<MessagingConsentScope, "recipient" | "transport">>;
  retentionMs?: number;
};

export class SinchWebhookError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SinchWebhookError";
    this.status = status;
  }
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const transportOf = (value: unknown): SinchTransport => {
  const channel = String(value ?? "").toUpperCase();
  const transport =
    channel === "KAKAOTALK"
      ? "kakao"
      : channel === "VIBERBM"
        ? "viber"
        : channel === "MESSENGER"
          ? "messenger"
          : channel.toLowerCase();
  if (
    [
      "instagram",
      "kakao",
      "line",
      "messenger",
      "mms",
      "rcs",
      "sms",
      "telegram",
      "viber",
      "wechat",
      "whatsapp",
    ].includes(transport)
  ) {
    return transport as SinchTransport;
  }
  throw new SinchWebhookError(400, "unsupported Sinch callback channel");
};

const endpoint = (address: unknown, transport: MessagingTransport) => {
  if (typeof address !== "string" || address.length === 0) return undefined;
  return { address, transport };
};

const normalizedStatus = (value: string): MessagingDeliveryStatus => {
  const status = value.toUpperCase();
  if (status === "QUEUED_ON_CHANNEL") return "accepted";
  if (status === "DELIVERED") return "delivered";
  if (status === "READ") return "read";
  if (status === "FAILED") return "failed";
  if (status === "SWITCHING_CHANNEL" || status === "SWITCH_ON_CHANNEL") {
    return "accepted";
  }
  return "unknown";
};

const occurredAtOf = (payload: Record<string, unknown>) => {
  const occurredAt = Date.parse(
    String(payload.event_time ?? payload.accepted_time ?? ""),
  );
  if (!Number.isFinite(occurredAt)) {
    throw new SinchWebhookError(400, "valid event_time is required");
  }
  return occurredAt;
};

const normalize = (
  payload: Record<string, unknown>,
  nonce: string,
  accountProjectId: string,
): SinchWebhookEvent => {
  const projectId = accountProjectId;
  const appId = String(payload.app_id ?? "");
  const occurredAt = occurredAtOf(payload);
  const capability = recordOf(payload.capability_notification);
  if (Object.keys(capability).length > 0) {
    const transport = transportOf(capability.channel);
    const requestId = String(capability.request_id ?? "");
    const identity = String(capability.identity ?? "");
    const status = String(capability.capability_status ?? "");
    if (
      requestId.length === 0 ||
      identity.length === 0 ||
      status.length === 0
    ) {
      throw new SinchWebhookError(
        400,
        "capability request, identity, and status are required",
      );
    }
    return {
      eventId: nonce,
      features: Array.isArray(capability.channel_capabilities)
        ? capability.channel_capabilities.map(String)
        : [],
      identity,
      kind: "capability",
      occurredAt,
      provider: "sinch",
      providerAccountId: projectId,
      providerData: payload,
      requestId,
      status,
      transport,
    } satisfies SinchCapabilityEvent;
  }
  const delivery = recordOf(payload.message_delivery_report);
  if (Object.keys(delivery).length > 0) {
    const identity = recordOf(delivery.channel_identity);
    const transport = transportOf(identity.channel);
    const messageId = String(delivery.message_id ?? "");
    const providerStatus = String(delivery.status ?? "");
    if (messageId.length === 0 || providerStatus.length === 0) {
      throw new SinchWebhookError(
        400,
        "delivery message_id and status are required",
      );
    }
    const reason = recordOf(delivery.reason);
    const to = endpoint(identity.identity, transport);
    return {
      actualTransport: transport,
      errors:
        Object.keys(reason).length === 0
          ? []
          : [
              {
                ...(reason.code === undefined
                  ? {}
                  : { code: String(reason.code) }),
                ...(reason.description === undefined
                  ? {}
                  : { detail: String(reason.description) }),
                ...(reason.sub_code === undefined
                  ? {}
                  : { title: String(reason.sub_code) }),
              },
            ],
      eventId: nonce,
      kind: "delivery",
      messageId,
      occurredAt,
      provider: "sinch",
      providerAccountId: projectId,
      providerData: payload,
      providerStatus,
      status: normalizedStatus(providerStatus),
      ...(to === undefined ? {} : { to }),
    } satisfies SinchDeliveryEvent;
  }

  const explicitOptIn = recordOf(payload.opt_in_notification);
  const explicitOptOut = recordOf(payload.opt_out_notification);
  if (
    Object.keys(explicitOptIn).length > 0 ||
    Object.keys(explicitOptOut).length > 0
  ) {
    const notification =
      Object.keys(explicitOptIn).length > 0 ? explicitOptIn : explicitOptOut;
    const transport = transportOf(notification.channel);
    const from = endpoint(notification.identity, transport);
    if (from === undefined) {
      throw new SinchWebhookError(400, "consent identity is required");
    }
    return {
      action: notification === explicitOptIn ? "grant" : "revoke",
      actualTransport: transport,
      eventId: nonce,
      from,
      keyword: notification === explicitOptIn ? "OPT_IN" : "OPT_OUT",
      kind: "consent",
      messageId: String(notification.request_id ?? nonce),
      occurredAt,
      provider: "sinch",
      providerAccountId: projectId,
      providerData: payload,
    } satisfies SinchConsentEvent;
  }

  const inboundEvent = recordOf(payload.event);
  const contactEvent = recordOf(inboundEvent.contact_event);
  const channelSpecific = recordOf(contactEvent.channel_specific_event);
  const preference = recordOf(channelSpecific.whatsapp_user_preferences_event);
  if (preference.preference === "stop" || preference.preference === "resume") {
    const identity = recordOf(inboundEvent.channel_identity);
    const transport = transportOf(identity.channel);
    const from = endpoint(identity.identity, transport);
    if (from === undefined)
      throw new SinchWebhookError(400, "event identity is required");
    return {
      action: preference.preference === "resume" ? "grant" : "revoke",
      actualTransport: transport,
      eventId: nonce,
      from,
      keyword: String(preference.preference).toUpperCase(),
      kind: "consent",
      messageId: String(inboundEvent.id ?? nonce),
      occurredAt,
      provider: "sinch",
      providerAccountId: projectId,
      providerData: payload,
    } satisfies SinchConsentEvent;
  }

  if (Object.keys(inboundEvent).length > 0) {
    const identity = recordOf(inboundEvent.channel_identity);
    const transport = transportOf(identity.channel);
    const from = endpoint(identity.identity, transport);
    return {
      actualTransport: transport,
      content: { kind: "text", text: "" },
      eventId: nonce,
      ...(from === undefined ? {} : { from }),
      interaction: { payload: JSON.stringify(contactEvent) },
      kind: "inbound",
      messageId: String(inboundEvent.id ?? nonce),
      occurredAt,
      provider: "sinch",
      providerAccountId: projectId,
      providerData: payload,
    } satisfies SinchInboundEvent;
  }

  const message = recordOf(payload.message);
  const identity = recordOf(message.channel_identity);
  const transport = transportOf(identity.channel);
  const contactMessage = recordOf(message.contact_message);
  const textMessage = recordOf(contactMessage.text_message);
  const mediaMessage = recordOf(contactMessage.media_message);
  const mediaCard = recordOf(contactMessage.media_card_message);
  const choice = recordOf(contactMessage.choice_response_message);
  const text =
    typeof textMessage.text === "string"
      ? textMessage.text
      : typeof mediaCard.caption === "string"
        ? mediaCard.caption
        : undefined;
  const keyword = text?.trim().toUpperCase();
  const from = endpoint(identity.identity, transport);
  const to = endpoint(message.sender_id, transport);
  const base = {
    actualTransport: transport,
    eventId: nonce,
    ...(from === undefined ? {} : { from }),
    messageId: String(message.id ?? nonce),
    occurredAt,
    provider: "sinch" as const,
    providerAccountId: projectId,
    providerData: payload,
    ...(to === undefined ? {} : { to }),
  };
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
    } satisfies SinchConsentEvent;
  }
  const mediaUrl =
    typeof mediaMessage.url === "string"
      ? mediaMessage.url
      : typeof mediaCard.url === "string"
        ? mediaCard.url
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
    ...(typeof choice.postback_data === "string"
      ? { interaction: { payload: choice.postback_data } }
      : {}),
    kind: "inbound",
  } satisfies SinchInboundEvent;
};

const verify = (
  rawBody: string,
  headers: SinchWebhookHeaders,
  account: SinchWebhookAccountConfiguration,
  now: number,
  replayToleranceMs: number,
) => {
  if (headers.algorithm !== "HmacSHA256") {
    throw new SinchWebhookError(401, "unsupported Sinch webhook algorithm");
  }
  if (
    headers.nonce === undefined ||
    headers.nonce.length === 0 ||
    headers.signature === undefined ||
    headers.timestamp === undefined
  ) {
    throw new SinchWebhookError(401, "missing Sinch webhook signature headers");
  }
  const timestamp = Number(headers.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp * 1000) > replayToleranceMs
  ) {
    throw new SinchWebhookError(401, "stale Sinch webhook signature");
  }
  if (
    account.signatureSecrets.length === 0 ||
    account.signatureSecrets.length > 2 ||
    account.signatureSecrets.some((secret) => secret.length < 8)
  ) {
    throw new SinchWebhookError(
      500,
      "one or two valid signature secrets are required",
    );
  }
  const received = Buffer.from(headers.signature, "base64");
  const signed = `${rawBody}.${headers.nonce}.${headers.timestamp}`;
  const valid = account.signatureSecrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(signed).digest();
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  });
  if (!valid)
    throw new SinchWebhookError(401, "invalid Sinch webhook signature");
  return headers.nonce;
};

export const createSinchWebhookProcessor = (
  options: CreateSinchWebhookProcessorOptions,
) => ({
  process: async (input: {
    accountKey: string;
    headers: SinchWebhookHeaders;
    rawBody: string;
  }) => {
    const account = await options.resolveAccount(input.accountKey);
    if (account === undefined) {
      throw new SinchWebhookError(401, "unknown Sinch webhook account");
    }
    const now = options.now?.() ?? Date.now();
    const nonce = verify(
      input.rawBody,
      input.headers,
      account,
      now,
      options.replayToleranceMs ?? 5 * 60_000,
    );
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw new SinchWebhookError(400, "invalid Sinch webhook JSON");
    }
    if (
      (String(payload.project_id ?? "").length > 0 &&
        payload.project_id !== account.projectId) ||
      !account.appIds.includes(String(payload.app_id ?? ""))
    ) {
      throw new SinchWebhookError(403, "unexpected Sinch project or app");
    }
    const event = normalize(payload, nonce, account.projectId);
    await options.inbox.purgeCompleted(
      now - (options.retentionMs ?? 24 * 60 * 60_000),
    );
    const claim = await options.inbox.accept({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      payload: event,
      provider: "sinch",
      streamId: `${account.projectId}:${payload.app_id}`,
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
          throw new SinchWebhookError(400, "consent sender is required");
        }
        const scopes = await options.resolveConsentScopes?.(event);
        if (scopes === undefined || scopes.length === 0) {
          throw new SinchWebhookError(
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
            idempotencyKey: `sinch:${event.eventId}:${scope.programId}:${event.from.transport}`,
            source: "sinch-opt-out",
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

export const drainSinchWebhookInbox = async (
  options: Pick<CreateSinchWebhookProcessorOptions, "handler" | "inbox">,
) =>
  drainWebhookInbox({
    handler: async ({ payload }) => options.handler(payload),
    store: options.inbox,
  });

export const createSinchWebhookHandler = (
  options: CreateSinchWebhookProcessorOptions & {
    resolveAccountKey: (
      request: Pick<Request, "headers" | "url">,
    ) => Promise<string> | string;
  },
) => {
  const processor = createSinchWebhookProcessor(options);
  return async (request: Request) => {
    try {
      const result = await processor.process({
        accountKey: await options.resolveAccountKey({
          headers: request.headers,
          url: request.url,
        }),
        headers: {
          algorithm:
            request.headers.get("x-sinch-webhook-signature-algorithm") ??
            undefined,
          nonce:
            request.headers.get("x-sinch-webhook-signature-nonce") ?? undefined,
          signature:
            request.headers.get("x-sinch-webhook-signature") ?? undefined,
          timestamp:
            request.headers.get("x-sinch-webhook-signature-timestamp") ??
            undefined,
        },
        rawBody: await request.text(),
      });
      return Response.json(
        { disposition: result.disposition, eventId: result.event.eventId },
        { status: 200 },
      );
    } catch (error) {
      const status = error instanceof SinchWebhookError ? error.status : 500;
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status },
      );
    }
  };
};
