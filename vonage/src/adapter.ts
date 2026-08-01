import type { Vonage } from "@vonage/server-sdk";
import type {
  MessagingAction,
  MessagingAdapter,
  MessagingContent,
  MessagingDispatchResult,
  MessagingEndpoint,
  MessagingMessage,
  MessagingTransport,
} from "@absolutejs/dispatch";
import {
  fingerprintPayload,
  type IdempotentOperationStore,
} from "@absolutejs/reliability";

declare module "@absolutejs/dispatch" {
  interface MessagingTransportRegistry {
    messenger: { family: "ott" };
    viber: { family: "ott" };
  }
}

export type VonageTransport =
  | "messenger"
  | "mms"
  | "rcs"
  | "sms"
  | "viber"
  | "whatsapp";

export type VonageClientLike = {
  messages: Pick<Vonage["messages"], "send">;
};

export type VonageMessagePayload = Record<string, unknown> & {
  channel: VonageTransport;
  from: string;
  message_type: string;
  to: string;
};

export type VonageTenantConfiguration = {
  apiKey: string;
  applicationId?: string;
  client?: VonageClientLike;
  defaultFrom?: Partial<Record<VonageTransport, string>>;
  webhookUrl?: string;
};

export type CreateVonageAdapterOptions = {
  apiKey: string;
  applicationId?: string;
  capabilities?: MessagingAdapter["capabilities"];
  client: VonageClientLike;
  defaultFrom?: Partial<Record<VonageTransport, string>>;
  idempotencyLeaseMs?: number;
  idempotencyStore?: IdempotentOperationStore<MessagingDispatchResult>;
  now?: () => number;
  resolveTenant?: (
    tenant: string,
  ) => Promise<VonageTenantConfiguration> | VonageTenantConfiguration;
  /** Message lifetime in seconds. Vonage accepts 1–259200. */
  ttl?: number;
  webhookUrl: string;
};

export class VonageConfigurationError extends Error {
  override name = "VonageConfigurationError";
}
export class VonageIdempotencyConflictError extends Error {
  override name = "VonageIdempotencyConflictError";
}
export class VonageIdempotencyInFlightError extends Error {
  override name = "VonageIdempotencyInFlightError";
}
export class VonageIdempotencyIndeterminateError extends Error {
  override name = "VonageIdempotencyIndeterminateError";
}

const E164 = /^\+[1-9]\d{1,14}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VONAGE_TRANSPORTS = new Set<string>([
  "messenger",
  "mms",
  "rcs",
  "sms",
  "viber",
  "whatsapp",
]);

const assertHttps = (value: string, name: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VonageConfigurationError(`${name} must be an absolute URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new VonageConfigurationError(`${name} must use HTTPS`);
  }
};

const transportOf = (transport: MessagingTransport): VonageTransport => {
  if (!VONAGE_TRANSPORTS.has(transport)) {
    throw new VonageConfigurationError(
      `Vonage does not support the ${transport} transport`,
    );
  }
  return transport as VonageTransport;
};

const addressOf = (endpoint: MessagingEndpoint) => {
  const transport = transportOf(endpoint.transport);
  if (
    (transport === "sms" || transport === "mms") &&
    !E164.test(endpoint.address)
  ) {
    throw new VonageConfigurationError(
      `${transport} endpoints must use E.164 addresses`,
    );
  }
  if (endpoint.address.trim().length === 0) {
    throw new VonageConfigurationError("messaging endpoint must not be empty");
  }
  return endpoint.address.replace(/^\+/u, "");
};

const suggestionsOf = (actions: ReadonlyArray<MessagingAction> | undefined) =>
  actions?.map((action) => {
    if (action.kind === "reply") {
      return {
        postback_data: action.payload,
        text: action.label,
        type: "reply",
      };
    }
    if (action.kind === "url") {
      return { text: action.label, type: "open_url", url: action.url };
    }
    if (action.kind === "dial") {
      return {
        phone_number: action.phoneNumber,
        text: action.label,
        type: "dial_phone",
      };
    }
    return {
      latitude: action.latitude,
      longitude: action.longitude,
      text: action.label,
      type: "view_location",
    };
  });

const extensionOf = (content: MessagingContent) => {
  if (content.kind !== "rich") return undefined;
  const extension = content.extensions?.vonage;
  if (extension === undefined) return undefined;
  if (
    extension === null ||
    typeof extension !== "object" ||
    Array.isArray(extension)
  ) {
    throw new VonageConfigurationError("extensions.vonage must be an object");
  }
  return extension as Readonly<Record<string, unknown>>;
};

const contentOf = (
  content: MessagingContent,
  transport: VonageTransport,
): Record<string, unknown> => {
  if (content.kind === "text") {
    if (content.text.trim().length === 0) {
      throw new VonageConfigurationError("message text must not be empty");
    }
    return { message_type: "text", text: content.text };
  }
  if (content.kind === "media") {
    if (content.mediaUrls.length !== 1) {
      throw new VonageConfigurationError(
        "Vonage portable media requires exactly one URL; use extensions.vonage for channel-specific media",
      );
    }
    assertHttps(content.mediaUrls[0]!, "media URL");
    return {
      image: {
        ...(content.text === undefined ? {} : { caption: content.text }),
        url: content.mediaUrls[0],
      },
      message_type: "image",
    };
  }
  if (content.kind === "template") {
    if (transport !== "whatsapp") {
      throw new VonageConfigurationError(
        "portable Vonage templates are supported only for WhatsApp",
      );
    }
    return {
      message_type: "template",
      template: {
        name: content.id,
        parameters: Object.entries(content.variables ?? {}).map(
          ([name, value]) => ({ name, value }),
        ),
      },
      whatsapp: { policy: "deterministic" },
    };
  }
  const extension = extensionOf(content);
  if (extension !== undefined) {
    for (const reserved of ["channel", "from", "to", "failover"]) {
      if (reserved in extension) {
        throw new VonageConfigurationError(
          `extensions.vonage cannot override ${reserved}`,
        );
      }
    }
    return { ...extension };
  }
  if (transport !== "rcs") {
    throw new VonageConfigurationError(
      "portable rich content is supported only for RCS; use a template or extensions.vonage",
    );
  }
  if (content.title === undefined || content.mediaUrl === undefined) {
    return {
      message_type: "text",
      rcs: { suggestions: suggestionsOf(content.actions) },
      text: content.text,
    };
  }
  assertHttps(content.mediaUrl, "rich media URL");
  return {
    card: {
      media_url: content.mediaUrl,
      suggestions: suggestionsOf(content.actions),
      text: content.text,
      title: content.title,
    },
    message_type: "card",
  };
};

const routeOf = (input: {
  content: MessagingContent;
  from: MessagingEndpoint | undefined;
  fallbackFrom: string | undefined;
  to: MessagingEndpoint;
  transport: MessagingTransport;
}): VonageMessagePayload => {
  const transport = transportOf(input.transport);
  const from = input.from?.address ?? input.fallbackFrom;
  if (from === undefined || from.trim().length === 0) {
    throw new VonageConfigurationError(
      `a sender is required for the ${transport} transport`,
    );
  }
  if (input.from !== undefined && input.from.transport !== input.transport) {
    throw new VonageConfigurationError("sender transport must match its route");
  }
  return {
    channel: transport,
    ...contentOf(input.content, transport),
    from: from.replace(/^\+/u, ""),
    to: addressOf(input.to),
  } as VonageMessagePayload;
};

const assertConfiguration = (options: CreateVonageAdapterOptions) => {
  if (options.apiKey.trim().length === 0) {
    throw new VonageConfigurationError(
      "apiKey is required for account isolation",
    );
  }
  if (
    options.applicationId !== undefined &&
    !UUID.test(options.applicationId)
  ) {
    throw new VonageConfigurationError("applicationId must be a UUID");
  }
  assertHttps(options.webhookUrl, "webhookUrl");
  if (
    options.ttl !== undefined &&
    (!Number.isInteger(options.ttl) || options.ttl < 1 || options.ttl > 259_200)
  ) {
    throw new VonageConfigurationError(
      "ttl must be between 1 and 259200 seconds",
    );
  }
};

export const createVonageAdapter = (
  options: CreateVonageAdapterOptions,
): MessagingAdapter => {
  assertConfiguration(options);
  return {
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    name: "vonage",
    send: async (message) => {
      if (message.sendAt !== undefined) {
        throw new VonageConfigurationError(
          "Vonage Messages does not provide native scheduling; enqueue the dispatch operation",
        );
      }
      if (message.privacy !== undefined) {
        throw new VonageConfigurationError(
          "Vonage has no portable per-message retention control; apply retention to the durable inbox",
        );
      }
      const tenant =
        message.tenant === undefined
          ? undefined
          : await options.resolveTenant?.(message.tenant);
      const config = {
        apiKey: tenant?.apiKey ?? options.apiKey,
        applicationId: tenant?.applicationId ?? options.applicationId,
        client: tenant?.client ?? options.client,
        defaultFrom: { ...options.defaultFrom, ...tenant?.defaultFrom },
        webhookUrl: tenant?.webhookUrl ?? options.webhookUrl,
      };
      if (config.apiKey.trim().length === 0) {
        throw new VonageConfigurationError(
          "resolved tenant apiKey is required",
        );
      }
      assertHttps(config.webhookUrl, "resolved webhookUrl");
      const primary = routeOf({
        content: message.content,
        fallbackFrom: config.defaultFrom[transportOf(message.to.transport)],
        from: message.from,
        to: message.to,
        transport: message.to.transport,
      });
      const failover = (message.fallbacks ?? []).map((fallback) =>
        routeOf({
          content: fallback.content ?? message.content,
          fallbackFrom: config.defaultFrom[transportOf(fallback.transport)],
          from: fallback.from,
          to: { address: message.to.address, transport: fallback.transport },
          transport: fallback.transport,
        }),
      );
      const payload = {
        ...primary,
        ...(message.idempotencyKey === undefined
          ? {}
          : { client_ref: message.idempotencyKey }),
        ...(failover.length === 0 ? {} : { failover }),
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
        webhook_url: config.webhookUrl,
        webhook_version: "v1",
      };
      const now = options.now?.() ?? Date.now();
      const claim =
        message.idempotencyKey === undefined
          ? undefined
          : await options.idempotencyStore?.begin({
              fingerprint: await fingerprintPayload(payload),
              leaseMs: options.idempotencyLeaseMs ?? 60_000,
              now,
              scope: {
                account: config.apiKey,
                key: message.idempotencyKey,
                namespace: "dispatch.send",
                provider: "vonage",
                ...(message.tenant === undefined
                  ? {}
                  : { tenant: message.tenant }),
              },
            });
      if (message.idempotencyKey !== undefined && claim === undefined) {
        throw new VonageConfigurationError(
          "idempotencyStore is required when idempotencyKey is set",
        );
      }
      if (claim?.disposition === "completed") return claim.result;
      if (claim?.disposition === "conflict") {
        throw new VonageIdempotencyConflictError(
          "idempotency key was used with a different payload",
        );
      }
      if (claim?.disposition === "in-flight") {
        throw new VonageIdempotencyInFlightError("send is already in flight");
      }
      if (claim?.disposition === "indeterminate") {
        throw new VonageIdempotencyIndeterminateError(
          claim.reason ??
            "Vonage may have accepted this send; reconcile before retrying",
        );
      }
      if (claim?.disposition === "claimed") {
        await options.idempotencyStore!.markExecuting(
          claim.operationId,
          claim.token,
          now,
        );
      }
      let response: Awaited<ReturnType<VonageClientLike["messages"]["send"]>>;
      try {
        response = await config.client.messages.send(
          payload as Parameters<VonageClientLike["messages"]["send"]>[0],
        );
      } catch (error) {
        if (claim?.disposition === "claimed") {
          await options
            .idempotencyStore!.markIndeterminate(
              claim.operationId,
              claim.token,
              error instanceof Error ? error.message : String(error),
              now,
            )
            .catch(() => undefined);
        }
        throw error;
      }
      const result: MessagingDispatchResult = {
        at: now,
        delivery: {
          actualTransport: message.to.transport,
          attempts: [
            {
              actualTransport: message.to.transport,
              providerMessageId: response.messageUUID,
              route: "primary",
              status: "accepted",
              transport: message.to.transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        id: response.messageUUID,
        provider: "vonage",
      };
      if (claim?.disposition === "claimed") {
        await options.idempotencyStore!.complete(
          claim.operationId,
          claim.token,
          result,
          now,
        );
      }
      return result;
    },
  };
};
