import type {
  MessagingAdapter,
  MessagingContent,
  MessagingDeliveryEvent,
  MessagingDispatchResult,
  MessagingEvent,
  MessagingEventHandler,
  MessagingMessage,
  MessagingTransport,
} from "@absolutejs/dispatch";
import {
  drainWebhookInbox,
  type WebhookInboxStore,
} from "@absolutejs/reliability";

export {
  createMemoryWebhookInboxStore,
  createPostgresTransactionRunner,
  createPostgresWebhookInboxStore,
  WEBHOOK_INBOX_POSTGRES_SCHEMA,
} from "@absolutejs/reliability";

declare module "@absolutejs/dispatch" {
  interface MessagingTransportRegistry {
    "apple-messages": { family: "ott" };
    instagram: { family: "ott" };
    line: { family: "ott" };
    messenger: { family: "ott" };
    "viber-bot": { family: "ott" };
    "viber-business": { family: "ott" };
  }
}

export type InfobipFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CreateInfobipAdapterOptions = {
  adaptationMode?: boolean;
  apiKey: string;
  baseUrl: string;
  channelNames?: Partial<Record<MessagingTransport, string>>;
  defaultSenders?: Partial<Record<MessagingTransport, string>>;
  deliveryWebhookUrl?: string;
  fetch?: InfobipFetch;
  seenWebhookUrl?: string;
  validateBeforeSend?: boolean;
};

export class InfobipApiError extends Error {
  readonly body: unknown;
  readonly status: number;
  constructor(status: number, body: unknown) {
    super(`[dispatch-infobip] API request failed with HTTP ${status}`);
    this.name = "InfobipApiError";
    this.status = status;
    this.body = body;
  }
}

const CHANNELS: Partial<Record<MessagingTransport, string>> = {
  "apple-messages": "APPLE_MFB",
  instagram: "INSTAGRAM",
  line: "LINE",
  messenger: "MESSENGER",
  mms: "MMS",
  rcs: "RCS",
  sms: "SMS",
  "viber-bot": "VIBER_BOTS",
  "viber-business": "VIBER_BM",
  whatsapp: "WHATSAPP",
};

const normalizedBaseUrl = (value: string) => {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  return url.origin;
};

const buttons = (content: MessagingContent) =>
  content.kind === "rich" && content.actions?.length
    ? content.actions.map((action) => {
        if (action.kind === "reply")
          return {
            postbackData: action.payload,
            text: action.label,
            type: "REPLY",
          };
        if (action.kind === "url")
          return { text: action.label, type: "OPEN_URL", url: action.url };
        if (action.kind === "dial")
          return {
            phoneNumber: action.phoneNumber,
            text: action.label,
            type: "CALL",
          };
        return {
          latitude: action.latitude,
          longitude: action.longitude,
          text: action.label,
          type: "SHOW_LOCATION",
        };
      })
    : undefined;

const portableContent = (content: MessagingContent) => {
  if (content.kind === "text")
    return { body: { text: content.text, type: "TEXT" } };
  if (content.kind === "media") {
    if (content.mediaUrls.length !== 1)
      throw new Error(
        "[dispatch-infobip] portable media requires exactly one URL; use extensions.infobip for a validated provider-specific multi-part payload",
      );
    const url = content.mediaUrls[0];
    if (!url)
      throw new Error("[dispatch-infobip] media content requires a URL");
    return {
      body: {
        ...(content.text ? { text: content.text } : {}),
        type: "IMAGE",
        url,
      },
      ...(content.subject ? { header: { text: content.subject } } : {}),
    };
  }
  if (content.kind === "template")
    return {
      body: { type: "TEXT", ...(content.variables ?? {}) },
      template: { templateName: content.id },
    };
  return {
    body: {
      text: content.text,
      type: content.mediaUrl ? "IMAGE" : "TEXT",
      ...(content.mediaUrl ? { url: content.mediaUrl } : {}),
    },
    ...(content.title ? { header: { text: content.title } } : {}),
    ...(buttons(content) ? { buttons: buttons(content) } : {}),
  };
};

const rawExtension = (message: MessagingMessage) => {
  const value = message.extensions?.infobip;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const makeMessage = (
  options: CreateInfobipAdapterOptions,
  message: MessagingMessage,
) => {
  const raw = rawExtension(message);
  const channel =
    (typeof raw.channel === "string" ? raw.channel : undefined) ??
    options.channelNames?.[message.to.transport] ??
    CHANNELS[message.to.transport];
  if (!channel)
    throw new Error(
      `[dispatch-infobip] unsupported transport ${message.to.transport}`,
    );
  const sender =
    message.from?.address ?? options.defaultSenders?.[message.to.transport];
  if (!sender)
    throw new Error(
      `[dispatch-infobip] sender is required for ${message.to.transport}`,
    );
  if (message.fallbacks?.length && raw.failover === undefined)
    throw new Error(
      "[dispatch-infobip] provider failover settings are required at extensions.infobip.failover; validate them against your enabled channels",
    );
  const content = portableContent(message.content);
  return {
    ...raw,
    callbackData: JSON.stringify({
      ...(message.idempotencyKey
        ? { idempotencyKey: message.idempotencyKey }
        : {}),
      ...(message.tenant ? { tenant: message.tenant } : {}),
    }),
    channel,
    ...content,
    destinations: [{ to: message.to.address }],
    options: {
      adaptationMode: options.adaptationMode ?? true,
      ...((raw.options as Record<string, unknown> | undefined) ?? {}),
    },
    ...(message.sendAt ? { sendAt: message.sendAt } : {}),
    sender,
    ...(options.deliveryWebhookUrl || options.seenWebhookUrl
      ? {
          webhooks: {
            ...(options.deliveryWebhookUrl
              ? { delivery: { url: options.deliveryWebhookUrl } }
              : {}),
            ...(options.seenWebhookUrl
              ? { seen: { url: options.seenWebhookUrl } }
              : {}),
          },
        }
      : {}),
  };
};

const jsonResponse = async (response: Response) => {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new InfobipApiError(response.status, body);
  return body as Record<string, unknown> | undefined;
};

export const createInfobipAdapter = (
  options: CreateInfobipAdapterOptions,
): MessagingAdapter => {
  if (!options.apiKey.trim())
    throw new Error("[dispatch-infobip] apiKey is required");
  const origin = normalizedBaseUrl(options.baseUrl);
  const request = options.fetch ?? fetch;
  const post = async (path: string, body: unknown) =>
    jsonResponse(
      await request(`${origin}${path}`, {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          authorization: `App ${options.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
  return {
    name: "infobip",
    send: async (message): Promise<MessagingDispatchResult> => {
      const payload = { messages: [makeMessage(options, message)] };
      if (options.validateBeforeSend)
        await post("/resource-management/1/messages/validate", payload);
      const response = await post("/messages-api/1/messages", payload);
      const responses = response?.messages;
      const first = Array.isArray(responses) ? responses[0] : undefined;
      const id =
        typeof first === "object" && first !== null && "messageId" in first
          ? String((first as Record<string, unknown>).messageId)
          : typeof response?.messageId === "string"
            ? response.messageId
            : undefined;
      return {
        at: Date.now(),
        delivery: {
          actualTransport: message.to.transport,
          attempts: [
            {
              actualTransport: message.to.transport,
              ...(id ? { providerMessageId: id } : {}),
              route: "primary",
              status: "accepted",
              transport: message.to.transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        ...(id ? { id } : {}),
        provider: "infobip",
      };
    },
  };
};

export const createInfobipOperationsClient = (options: {
  apiKey: string;
  baseUrl: string;
  fetch?: InfobipFetch;
}) => {
  const origin = normalizedBaseUrl(options.baseUrl);
  const request = options.fetch ?? fetch;
  const call = async (method: string, path: string, body?: unknown) =>
    jsonResponse(
      await request(`${origin}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept: "application/json",
          authorization: `App ${options.apiKey}`,
          "content-type": "application/json",
        },
        method,
      }),
    );
  return {
    createBrand: (input: Record<string, unknown>) =>
      call("POST", "/number-registration/1/brands", input),
    createCampaign: (input: Record<string, unknown>) =>
      call("POST", "/number-registration/1/campaigns", input),
    inspectBrand: (id: string) =>
      call("GET", `/number-registration/1/brands/${encodeURIComponent(id)}`),
    inspectCampaign: (id: string) =>
      call("GET", `/number-registration/1/campaigns/${encodeURIComponent(id)}`),
    registerCampaign: (id: string) =>
      call(
        "POST",
        `/number-registration/1/campaigns/${encodeURIComponent(id)}/registrations`,
      ),
    requestNumber: (input: Record<string, unknown>) =>
      call("POST", "/resources/1/requests", input),
  };
};

const eventStatus = (value: string): MessagingDeliveryEvent["status"] => {
  const status = value.toLowerCase();
  if (status.includes("deliver")) return "delivered";
  if (status.includes("read") || status.includes("seen")) return "read";
  if (status.includes("expire")) return "expired";
  if (status.includes("reject") || status.includes("fail")) return "failed";
  if (status.includes("send")) return "sent";
  return "unknown";
};

const transportFromChannel = (value: unknown): MessagingTransport => {
  const channel = String(value ?? "sms").toUpperCase();
  const found = Object.entries(CHANNELS).find(([, name]) => name === channel);
  return (found?.[0] ?? channel.toLowerCase()) as MessagingTransport;
};

const addressOf = (value: unknown) => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const address = record.address ?? record.to ?? record.from;
  return typeof address === "string" ? address : undefined;
};

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const inboundContent = (item: Record<string, unknown>): MessagingContent => {
  const message = objectOf(item.message) ?? objectOf(item.content) ?? {};
  const body = objectOf(message.body) ?? objectOf(item.body) ?? {};
  const text = String(message.text ?? body.text ?? item.text ?? "");
  const url = message.url ?? body.url ?? item.url;
  if (typeof url === "string")
    return { kind: "media", mediaUrls: [url], ...(text ? { text } : {}) };
  return { kind: "text", text };
};

const webhookEvents = (body: string): MessagingEvent[] => {
  const payload = JSON.parse(body) as Record<string, unknown>;
  const entries = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.messages)
      ? payload.messages
      : [payload];
  return entries.flatMap<MessagingEvent>((entry, index) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    const messageId = String(item.messageId ?? item.messageID ?? "");
    if (!messageId) return [];
    const statusObject =
      typeof item.status === "object" && item.status !== null
        ? (item.status as Record<string, unknown>)
        : undefined;
    const isDelivery =
      statusObject !== undefined ||
      typeof item.status === "string" ||
      item.doneAt !== undefined ||
      item.seenAt !== undefined;
    const transport = transportFromChannel(item.channel);
    const from = addressOf(item.from);
    const to = addressOf(item.to ?? item.destination);
    const occurredAt = Date.parse(
      String(
        item.doneAt ??
          item.seenAt ??
          item.receivedAt ??
          item.receivedTimestamp ??
          new Date().toISOString(),
      ),
    );
    if (!isDelivery && from)
      return [
        {
          content: inboundContent(item),
          eventId: String(item.eventId ?? `${messageId}:inbound:${index}`),
          from: { address: from, transport },
          kind: "inbound" as const,
          messageId,
          occurredAt,
          provider: "infobip",
          ...(to ? { to: { address: to, transport } } : {}),
        },
      ];
    const providerStatus = String(
      statusObject?.name ?? item.status ?? "unknown",
    );
    return [
      {
        errors: statusObject?.description
          ? [{ detail: String(statusObject.description) }]
          : [],
        eventId: String(
          item.eventId ??
            `${messageId}:${providerStatus}:${item.doneAt ?? index}`,
        ),
        kind: "delivery" as const,
        messageId,
        occurredAt,
        provider: "infobip",
        providerStatus,
        status: eventStatus(providerStatus),
      },
    ];
  });
};

export const createInfobipWebhookHandler =
  (options: {
    inbox: WebhookInboxStore<string>;
    verify: (headers: Headers, body: string) => Promise<boolean> | boolean;
  }) =>
  async (request: Request) => {
    const body = await request.text();
    if (!(await options.verify(request.headers, body)))
      return new Response("unauthorized", { status: 401 });
    try {
      JSON.parse(body);
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ).toString("hex");
    const id = request.headers.get("x-request-id") ?? `infobip:${digest}`;
    const now = Date.now();
    const claim = await options.inbox.accept(
      {
        eventId: id,
        occurredAt: now,
        payload: body,
        provider: "infobip",
        streamId: "messages-api",
      },
      { leaseMs: 1, now },
    );
    if (claim.token) await options.inbox.release(id, claim.token);
    return new Response(null, { status: 202 });
  };

export const drainInfobipWebhookInbox = async (options: {
  inbox: WebhookInboxStore<string>;
  limit?: number;
  onEvent: MessagingEventHandler;
}) => {
  const completed = await drainWebhookInbox({
    handler: async ({ payload }) => {
      for (const event of webhookEvents(payload)) await options.onEvent(event);
    },
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    store: options.inbox,
  });
  return { claimed: completed, completed };
};
