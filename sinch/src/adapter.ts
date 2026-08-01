import type { SinchClient } from "@sinch/sdk-core";
import type {
  MessagingAction,
  MessagingAdapter,
  MessagingContent,
  MessagingDispatchResult,
  MessagingEndpoint,
  MessagingTransport,
} from "@absolutejs/dispatch";
import {
  fingerprintPayload,
  type IdempotentOperationStore,
} from "@absolutejs/reliability";

declare module "@absolutejs/dispatch" {
  interface MessagingTransportRegistry {
    instagram: { family: "ott" };
    kakao: { family: "ott" };
    line: { family: "ott" };
    messenger: { family: "ott" };
    telegram: { family: "ott" };
    viber: { family: "ott" };
    wechat: { family: "ott" };
  }
}

export type SinchTransport =
  | "instagram"
  | "kakao"
  | "line"
  | "messenger"
  | "mms"
  | "rcs"
  | "sms"
  | "telegram"
  | "viber"
  | "wechat"
  | "whatsapp";

export type SinchConversationClientLike = {
  conversation: {
    messages: Pick<SinchClient["conversation"]["messages"], "send">;
  };
};

export type SinchMessagePayload = Record<string, unknown> & {
  app_id: string;
  channel_priority_order: string[];
  message: Record<string, unknown>;
  recipient: Record<string, unknown>;
};

export type SinchRecipientIdentityResolver = (input: {
  address: string;
  tenant?: string;
  transport: SinchTransport;
}) => Promise<string> | string;

export type SinchTenantConfiguration = {
  appId: string;
  client?: SinchConversationClientLike;
  defaultFrom?: Partial<Record<SinchTransport, string>>;
  projectId: string;
  resolveRecipientIdentity?: SinchRecipientIdentityResolver;
  webhookUrl?: string;
};

export type CreateSinchAdapterOptions = {
  appId: string;
  capabilities?: MessagingAdapter["capabilities"];
  client: SinchConversationClientLike;
  defaultFrom?: Partial<Record<SinchTransport, string>>;
  idempotencyLeaseMs?: number;
  idempotencyStore?: IdempotentOperationStore<MessagingDispatchResult>;
  now?: () => number;
  projectId: string;
  resolveRecipientIdentity?: SinchRecipientIdentityResolver;
  resolveTenant?: (
    tenant: string,
  ) => Promise<SinchTenantConfiguration> | SinchTenantConfiguration;
  /** Conversation API message lifetime in seconds. */
  ttl?: number;
  webhookUrl: string;
};

export class SinchConfigurationError extends Error {
  override name = "SinchConfigurationError";
}
export class SinchIdempotencyConflictError extends Error {
  override name = "SinchIdempotencyConflictError";
}
export class SinchIdempotencyInFlightError extends Error {
  override name = "SinchIdempotencyInFlightError";
}
export class SinchIdempotencyIndeterminateError extends Error {
  override name = "SinchIdempotencyIndeterminateError";
}

const E164 = /^\+[1-9]\d{1,14}$/;
const transports = new Set<string>([
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
]);
const phoneTransports = new Set<SinchTransport>([
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
    throw new SinchConfigurationError(`${name} must be an absolute URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new SinchConfigurationError(`${name} must use HTTPS`);
  }
};

const transportOf = (transport: MessagingTransport): SinchTransport => {
  if (!transports.has(transport)) {
    throw new SinchConfigurationError(
      `Sinch Conversation does not support the ${transport} transport`,
    );
  }
  return transport as SinchTransport;
};

const channelOf = (transport: SinchTransport) =>
  transport === "kakao"
    ? "KAKAOTALK"
    : transport === "viber"
      ? "VIBERBM"
      : transport === "messenger"
        ? "MESSENGER"
        : transport.toUpperCase();

const identityOf = (endpoint: MessagingEndpoint) => {
  const transport = transportOf(endpoint.transport);
  if (phoneTransports.has(transport) && !E164.test(endpoint.address)) {
    throw new SinchConfigurationError(
      `${transport} endpoints must use E.164 addresses`,
    );
  }
  if (endpoint.address.trim().length === 0) {
    throw new SinchConfigurationError("messaging endpoint must not be empty");
  }
  return {
    channel: channelOf(transport),
    identity: endpoint.address,
    transport,
  };
};

const choicesOf = (actions: ReadonlyArray<MessagingAction> | undefined) =>
  actions?.map((action) => {
    if (action.kind === "reply") {
      return {
        postback_data: action.payload,
        text_message: { text: action.label },
      };
    }
    if (action.kind === "url") {
      return { url_message: { title: action.label, url: action.url } };
    }
    if (action.kind === "dial") {
      return {
        call_message: {
          phone_number: action.phoneNumber,
          title: action.label,
        },
      };
    }
    return {
      location_message: {
        coordinates: {
          latitude: action.latitude,
          longitude: action.longitude,
        },
        label: action.label,
        title: action.label,
      },
    };
  });

const contentOf = (content: MessagingContent): Record<string, unknown> => {
  if (content.kind === "text") {
    if (content.text.trim().length === 0) {
      throw new SinchConfigurationError("message text must not be empty");
    }
    return { text_message: { text: content.text } };
  }
  if (content.kind === "media") {
    if (content.mediaUrls.length !== 1) {
      throw new SinchConfigurationError(
        "Sinch portable media requires exactly one URL; use extensions.sinch for channel-specific content",
      );
    }
    assertHttps(content.mediaUrls[0]!, "media URL");
    return {
      media_message: {
        ...(content.text === undefined ? {} : { caption: content.text }),
        url: content.mediaUrls[0],
      },
    };
  }
  if (content.kind === "template") {
    return {
      template_message: {
        omni_template: {
          parameters: content.variables ?? {},
          template_id: content.id,
          version: "latest",
        },
      },
    };
  }
  const extension = content.extensions?.sinch;
  if (extension !== undefined) {
    if (
      extension === null ||
      typeof extension !== "object" ||
      Array.isArray(extension)
    ) {
      throw new SinchConfigurationError("extensions.sinch must be an object");
    }
    for (const reserved of [
      "app_id",
      "recipient",
      "channel_priority_order",
    ] as const) {
      if (reserved in extension) {
        throw new SinchConfigurationError(
          `extensions.sinch cannot override ${reserved}`,
        );
      }
    }
    return { ...(extension as Readonly<Record<string, unknown>>) };
  }
  if (content.mediaUrl !== undefined)
    assertHttps(content.mediaUrl, "rich media URL");
  return {
    card_message: {
      ...(content.actions === undefined
        ? {}
        : { choices: choicesOf(content.actions) }),
      description: content.text,
      ...(content.mediaUrl === undefined
        ? {}
        : { media_message: { url: content.mediaUrl } }),
      ...(content.title === undefined ? {} : { title: content.title }),
    },
  };
};

const senderProperties = (
  routes: ReadonlyArray<{
    from?: MessagingEndpoint;
    transport: SinchTransport;
  }>,
  defaults: Partial<Record<SinchTransport, string>>,
) => {
  const properties: Record<string, string> = {};
  for (const route of routes) {
    if (route.from !== undefined && route.from.transport !== route.transport) {
      throw new SinchConfigurationError(
        "sender transport must match its route",
      );
    }
    const sender = route.from?.address ?? defaults[route.transport];
    if (sender === undefined) continue;
    if (route.transport === "sms") properties.SMS_SENDER = sender;
    else if (route.transport === "mms") properties.MMS_SENDER = sender;
    else if (route.transport === "viber") properties.VIBER_SENDER_NAME = sender;
    else if (route.from !== undefined) {
      throw new SinchConfigurationError(
        `${route.transport} sender identity is configured on the Sinch app, not per message`,
      );
    }
  }
  return properties;
};

const assertConfiguration = (options: CreateSinchAdapterOptions) => {
  if (options.projectId.trim().length === 0) {
    throw new SinchConfigurationError("projectId is required for isolation");
  }
  if (options.appId.trim().length === 0) {
    throw new SinchConfigurationError("appId is required");
  }
  assertHttps(options.webhookUrl, "webhookUrl");
  if (
    options.ttl !== undefined &&
    (!Number.isInteger(options.ttl) || options.ttl < 3)
  ) {
    throw new SinchConfigurationError(
      "ttl must be an integer of at least 3 seconds",
    );
  }
};

export const createSinchAdapter = (
  options: CreateSinchAdapterOptions,
): MessagingAdapter => {
  assertConfiguration(options);
  return {
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    name: "sinch",
    send: async (message) => {
      if (message.sendAt !== undefined) {
        throw new SinchConfigurationError(
          "Sinch Conversation does not provide portable native scheduling; enqueue the dispatch operation",
        );
      }
      const tenant =
        message.tenant === undefined
          ? undefined
          : await options.resolveTenant?.(message.tenant);
      const config = {
        appId: tenant?.appId ?? options.appId,
        client: tenant?.client ?? options.client,
        defaultFrom: { ...options.defaultFrom, ...tenant?.defaultFrom },
        projectId: tenant?.projectId ?? options.projectId,
        resolveRecipientIdentity:
          tenant?.resolveRecipientIdentity ?? options.resolveRecipientIdentity,
        webhookUrl: tenant?.webhookUrl ?? options.webhookUrl,
      };
      if (
        config.projectId.trim().length === 0 ||
        config.appId.trim().length === 0
      ) {
        throw new SinchConfigurationError(
          "resolved tenant projectId and appId are required",
        );
      }
      assertHttps(config.webhookUrl, "resolved webhookUrl");
      const identityFor = async (transport: MessagingTransport) => {
        const sinchTransport = transportOf(transport);
        const address =
          (await config.resolveRecipientIdentity?.({
            address: message.to.address,
            ...(message.tenant === undefined ? {} : { tenant: message.tenant }),
            transport: sinchTransport,
          })) ?? message.to.address;
        return identityOf({ address, transport: sinchTransport });
      };
      const primary = await identityFor(message.to.transport);
      const fallbackRoutes = await Promise.all(
        (message.fallbacks ?? []).map(async (fallback) => ({
          from: fallback.from,
          identity: await identityFor(fallback.transport),
          transport: transportOf(fallback.transport),
        })),
      );
      const routes = [
        { from: message.from, transport: primary.transport },
        ...fallbackRoutes.map(({ from, transport }) => ({ from, transport })),
      ];
      const identities = [
        primary,
        ...fallbackRoutes.map(({ identity }) => identity),
      ];
      const channelPriority = identities.map(({ channel }) => channel);
      if (new Set(channelPriority).size !== channelPriority.length) {
        throw new SinchConfigurationError("fallback transports must be unique");
      }
      if (
        message.idempotencyKey !== undefined &&
        message.idempotencyKey.length > 128
      ) {
        throw new SinchConfigurationError(
          "idempotencyKey must not exceed Sinch's 128 character correlation_id limit",
        );
      }
      if (
        fallbackRoutes.some(
          (_, index) => message.fallbacks?.[index]?.content !== undefined,
        )
      ) {
        throw new SinchConfigurationError(
          "Sinch channel-priority fallback transcodes one message; route-specific fallback content is unsupported",
        );
      }
      const channelProperties = senderProperties(routes, config.defaultFrom);
      const payload: SinchMessagePayload = {
        app_id: config.appId,
        callback_url: config.webhookUrl,
        channel_priority_order: channelPriority,
        ...(Object.keys(channelProperties).length === 0
          ? {}
          : { channel_properties: channelProperties }),
        ...(message.idempotencyKey === undefined
          ? {}
          : { correlation_id: message.idempotencyKey }),
        message: contentOf(message.content),
        ...(message.privacy?.contentRetention === "discard"
          ? { processing_strategy: "DISPATCH" }
          : {}),
        recipient: {
          identified_by: {
            channel_identities: identities.map(({ channel, identity }) => ({
              channel,
              identity,
              ...(new Set(["MESSENGER", "INSTAGRAM", "LINE", "WECHAT"]).has(
                channel,
              )
                ? { app_id: config.appId }
                : {}),
            })),
          },
        },
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
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
                account: config.projectId,
                key: message.idempotencyKey,
                namespace: "dispatch.send",
                provider: "sinch",
                ...(message.tenant === undefined
                  ? {}
                  : { tenant: message.tenant }),
              },
            });
      if (message.idempotencyKey !== undefined && claim === undefined) {
        throw new SinchConfigurationError(
          "idempotencyStore is required when idempotencyKey is set",
        );
      }
      if (claim?.disposition === "completed") return claim.result;
      if (claim?.disposition === "conflict") {
        throw new SinchIdempotencyConflictError(
          "idempotency key was used with a different payload",
        );
      }
      if (claim?.disposition === "in-flight") {
        throw new SinchIdempotencyInFlightError("send is already in flight");
      }
      if (claim?.disposition === "indeterminate") {
        throw new SinchIdempotencyIndeterminateError(
          claim.reason ??
            "Sinch may have accepted this send; reconcile before retrying",
        );
      }
      if (claim?.disposition === "claimed") {
        await options.idempotencyStore!.markExecuting(
          claim.operationId,
          claim.token,
          now,
        );
      }
      let response: { accepted_time?: Date; message_id?: string };
      try {
        response = await config.client.conversation.messages.send({
          sendMessageRequestBody: payload,
        } as unknown as Parameters<
          SinchConversationClientLike["conversation"]["messages"]["send"]
        >[0]);
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
      if (response.message_id === undefined) {
        if (claim?.disposition === "claimed") {
          await options.idempotencyStore!.markIndeterminate(
            claim.operationId,
            claim.token,
            "Sinch accepted the request without a message_id",
            now,
          );
        }
        throw new SinchIdempotencyIndeterminateError(
          "Sinch accepted the request without a message_id; reconcile before retrying",
        );
      }
      const result: MessagingDispatchResult = {
        at: response.accepted_time?.getTime() ?? now,
        delivery: {
          actualTransport: primary.transport,
          attempts: [
            {
              actualTransport: primary.transport,
              providerMessageId: response.message_id,
              route: "primary",
              status: "accepted",
              transport: primary.transport,
            },
          ],
          requestedTransport: primary.transport,
        },
        id: response.message_id,
        provider: "sinch",
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
