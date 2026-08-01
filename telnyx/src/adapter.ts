import type {
  MessagingAction,
  MessagingAdapter,
  MessagingContent,
  MessagingDispatchResult,
  MessagingMessage,
  MessagingTransport,
} from "@absolutejs/dispatch";
import {
  fingerprintPayload,
  type IdempotentOperationStore,
} from "@absolutejs/reliability";

export type TelnyxStandardMessageParams = {
  auto_detect?: boolean;
  encoding?: "auto" | "gsm7" | "ucs2";
  from?: string;
  media_urls?: string[];
  messaging_profile_id: string;
  send_at?: string;
  subject?: string;
  text?: string;
  to: string;
  type: "MMS" | "SMS";
  use_profile_webhooks?: boolean;
  webhook_failover_url?: string;
  webhook_url: string;
};

export type TelnyxRcsAgentMessage = Record<string, unknown>;

export type TelnyxRcsMessageParams = {
  agent_id: string;
  agent_message: TelnyxRcsAgentMessage;
  messaging_profile_id: string;
  mms_fallback?: {
    from?: string;
    media_urls?: string[];
    subject?: string;
    text?: string;
  };
  sms_fallback?: { from?: string; text?: string };
  to: string;
  type: "RCS";
  webhook_url: string;
};

export type TelnyxMessageResponse = {
  data?: { id?: string; type?: string };
};

export type TelnyxClientLike = {
  messages: {
    cancelScheduled: (id: string) => Promise<unknown>;
    rcs: {
      send: (params: TelnyxRcsMessageParams) => Promise<TelnyxMessageResponse>;
    };
    retrieve: (id: string) => Promise<unknown>;
    schedule: (
      params: TelnyxStandardMessageParams,
    ) => Promise<TelnyxMessageResponse>;
    send: (
      params: TelnyxStandardMessageParams,
    ) => Promise<TelnyxMessageResponse>;
  };
  messaging: {
    rcs: {
      retrieveCapabilities: (
        phoneNumber: string,
        params: { agent_id: string },
      ) => Promise<{
        data?: {
          agent_id?: string;
          features?: string[];
          phone_number?: string;
        };
      }>;
    };
  };
};

export type TelnyxTenantConfiguration = {
  accountId: string;
  client?: TelnyxClientLike;
  from?: string;
  messagingProfileId: string;
  rcsAgentId?: string;
  webhookFailoverUrl?: string;
  webhookUrl?: string;
};

export type CreateTelnyxAdapterOptions = {
  accountId: string;
  allowNativeScheduling?: boolean;
  autoDetectLongMessages?: boolean;
  capabilities?: MessagingAdapter["capabilities"];
  client: TelnyxClientLike;
  encoding?: "auto" | "gsm7" | "ucs2";
  idempotencyLeaseMs?: number;
  idempotencyStore?: IdempotentOperationStore<MessagingDispatchResult>;
  messagingProfileId: string;
  now?: () => number;
  rcsAgentId?: string;
  resolveTenant?: (
    tenant: string,
  ) => Promise<TelnyxTenantConfiguration> | TelnyxTenantConfiguration;
  webhookFailoverUrl?: string;
  webhookUrl: string;
};

export class TelnyxConfigurationError extends Error {
  override name = "TelnyxConfigurationError";
}

export class TelnyxIdempotencyConflictError extends Error {
  override name = "TelnyxIdempotencyConflictError";
}

export class TelnyxIdempotencyInFlightError extends Error {
  override name = "TelnyxIdempotencyInFlightError";
}

export class TelnyxIdempotencyIndeterminateError extends Error {
  override name = "TelnyxIdempotencyIndeterminateError";
}

const E164 = /^\+[1-9]\d{1,14}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertHttps = (value: string, name: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TelnyxConfigurationError(`${name} must be an absolute URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TelnyxConfigurationError(`${name} must use HTTPS`);
  }
};

const assertConfiguration = (options: {
  accountId: string;
  messagingProfileId: string;
  webhookFailoverUrl?: string;
  webhookUrl: string;
}) => {
  if (options.accountId.trim().length === 0) {
    throw new TelnyxConfigurationError(
      "accountId is required for idempotency isolation",
    );
  }
  if (!UUID.test(options.messagingProfileId)) {
    throw new TelnyxConfigurationError("messagingProfileId must be a UUID");
  }
  assertHttps(options.webhookUrl, "webhookUrl");
  if (options.webhookFailoverUrl !== undefined) {
    assertHttps(options.webhookFailoverUrl, "webhookFailoverUrl");
  }
};

const textOf = (content: MessagingContent): string | undefined => {
  if (content.kind === "text" || content.kind === "rich") return content.text;
  if (content.kind === "media") return content.text;
  return undefined;
};

const suggestions = (actions: ReadonlyArray<MessagingAction> | undefined) =>
  actions?.map((action) => {
    if (action.kind === "reply") {
      return { reply: { postback_data: action.payload, text: action.label } };
    }
    if (action.kind === "dial") {
      return {
        action: {
          dial_action: { phone_number: action.phoneNumber },
          postback_data: action.phoneNumber,
          text: action.label,
        },
      };
    }
    if (action.kind === "url") {
      return {
        action: {
          open_url_action: {
            application: "BROWSER",
            url: action.url,
            webview_view_mode: "FULL",
          },
          postback_data: action.url,
          text: action.label,
        },
      };
    }
    return {
      action: {
        postback_data: `${action.latitude},${action.longitude}`,
        text: action.label,
        view_location_action: {
          lat_long: { latitude: action.latitude, longitude: action.longitude },
        },
      },
    };
  });

const toRcsAgentMessage = (
  content: MessagingContent,
): TelnyxRcsAgentMessage => {
  if (content.kind === "template") {
    throw new TelnyxConfigurationError(
      "Telnyx does not use portable template ids; use rich content or extensions.telnyx.agentMessage",
    );
  }
  if (content.kind === "text") {
    return { content_message: { text: content.text } };
  }
  if (content.kind === "media") {
    if (content.mediaUrls.length !== 1) {
      throw new TelnyxConfigurationError(
        "RCS media content requires exactly one media URL",
      );
    }
    return {
      content_message: {
        content_info: { file_url: content.mediaUrls[0] },
        ...(content.text === undefined ? {} : { text: content.text }),
      },
    };
  }
  const extension = content.extensions?.telnyx as
    | { agentMessage?: TelnyxRcsAgentMessage }
    | undefined;
  if (extension?.agentMessage !== undefined) return extension.agentMessage;
  const actionList = suggestions(content.actions);
  if (content.title === undefined && content.mediaUrl === undefined) {
    return {
      content_message: {
        text: content.text,
        ...(actionList === undefined ? {} : { suggestions: actionList }),
      },
    };
  }
  return {
    content_message: {
      rich_card: {
        standalone_card: {
          card_content: {
            description: content.text,
            ...(content.mediaUrl === undefined
              ? {}
              : {
                  media: {
                    content_info: { file_url: content.mediaUrl },
                    height: "MEDIUM",
                  },
                }),
            ...(actionList === undefined ? {} : { suggestions: actionList }),
            ...(content.title === undefined ? {} : { title: content.title }),
          },
          card_orientation: "VERTICAL",
          thumbnail_image_alignment: "LEFT",
        },
      },
    },
  };
};

const assertMessage = (
  message: MessagingMessage,
  now: number,
  allowNativeScheduling: boolean,
) => {
  if (!E164.test(message.to.address)) {
    throw new TelnyxConfigurationError("recipient address must be E.164");
  }
  if (message.to.transport === "whatsapp") {
    throw new TelnyxConfigurationError(
      "Telnyx adapter does not implement WhatsApp",
    );
  }
  if (message.from !== undefined) {
    if (
      message.from.transport !== message.to.transport ||
      !E164.test(message.from.address)
    ) {
      throw new TelnyxConfigurationError(
        "sender must be E.164 and match the primary transport",
      );
    }
  }
  if (
    (message.fallbacks?.length ?? 0) > 1 ||
    (message.fallbacks !== undefined && message.to.transport !== "rcs")
  ) {
    throw new TelnyxConfigurationError(
      "fallback is limited to one SMS or MMS route from RCS",
    );
  }
  const fallback = message.fallbacks?.[0];
  if (
    fallback !== undefined &&
    !(["sms", "mms"] as const).includes(fallback.transport as "sms" | "mms")
  ) {
    throw new TelnyxConfigurationError("RCS fallback must use SMS or MMS");
  }
  if (
    fallback?.from !== undefined &&
    (fallback.from.transport !== fallback.transport ||
      !E164.test(fallback.from.address))
  ) {
    throw new TelnyxConfigurationError(
      "fallback sender must match its transport and be E.164",
    );
  }
  if (
    message.content.kind === "text" &&
    message.content.text.trim().length === 0
  ) {
    throw new TelnyxConfigurationError("message text must not be empty");
  }
  const urls =
    message.content.kind === "media"
      ? message.content.mediaUrls
      : message.content.kind === "rich" && message.content.mediaUrl
        ? [message.content.mediaUrl]
        : [];
  for (const value of urls) assertHttps(value, "media URL");
  if (
    message.to.transport !== "rcs" &&
    (message.content.kind === "rich" || message.content.kind === "template")
  ) {
    throw new TelnyxConfigurationError(
      "rich and template content cannot be sent over SMS/MMS",
    );
  }
  if (message.privacy !== undefined) {
    throw new TelnyxConfigurationError(
      "Telnyx has no equivalent per-message address/content retention flags; enforce retention in the local inbox policy",
    );
  }
  if (message.sendAt !== undefined) {
    if (!allowNativeScheduling)
      throw new TelnyxConfigurationError("native scheduling is disabled");
    if (message.consent !== undefined)
      throw new TelnyxConfigurationError(
        "consent-scoped sends must be queued and re-evaluated at delivery time",
      );
    if (message.to.transport === "rcs")
      throw new TelnyxConfigurationError(
        "Telnyx native scheduling supports SMS and MMS only",
      );
    const at = new Date(message.sendAt).valueOf();
    if (
      !Number.isFinite(at) ||
      at < now + 5 * 60_000 ||
      at > now + 5 * 24 * 60 * 60_000
    ) {
      throw new TelnyxConfigurationError(
        "sendAt must be between 5 minutes and 5 days in the future",
      );
    }
  }
};

const standardParams = (
  message: MessagingMessage,
  config: TelnyxTenantConfiguration,
  options: CreateTelnyxAdapterOptions,
): TelnyxStandardMessageParams => {
  const content = message.content;
  if (content.kind === "template" || content.kind === "rich") {
    throw new TelnyxConfigurationError(
      "SMS/MMS requires text or media content",
    );
  }
  return {
    ...(options.autoDetectLongMessages === undefined
      ? {}
      : { auto_detect: options.autoDetectLongMessages }),
    ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
    ...((message.from?.address ?? config.from)
      ? { from: message.from?.address ?? config.from }
      : {}),
    ...(content.kind === "media"
      ? {
          media_urls: [...content.mediaUrls],
          ...(content.subject === undefined
            ? {}
            : { subject: content.subject }),
        }
      : {}),
    messaging_profile_id: config.messagingProfileId,
    ...(message.sendAt === undefined ? {} : { send_at: message.sendAt }),
    ...(textOf(content) === undefined ? {} : { text: textOf(content) }),
    to: message.to.address,
    type: message.to.transport === "mms" ? "MMS" : "SMS",
    use_profile_webhooks: true,
    ...(config.webhookFailoverUrl === undefined
      ? {}
      : { webhook_failover_url: config.webhookFailoverUrl }),
    webhook_url: config.webhookUrl!,
  };
};

export const createTelnyxAdapter = (
  options: CreateTelnyxAdapterOptions,
): MessagingAdapter => {
  assertConfiguration(options);
  return {
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    name: "telnyx",
    send: async (message) => {
      const now = options.now?.() ?? Date.now();
      assertMessage(message, now, options.allowNativeScheduling === true);
      const resolved =
        message.tenant === undefined
          ? undefined
          : await options.resolveTenant?.(message.tenant);
      const config: TelnyxTenantConfiguration = {
        accountId: resolved?.accountId ?? options.accountId,
        client: resolved?.client ?? options.client,
        from: resolved?.from,
        messagingProfileId:
          resolved?.messagingProfileId ?? options.messagingProfileId,
        rcsAgentId: resolved?.rcsAgentId ?? options.rcsAgentId,
        webhookFailoverUrl:
          resolved?.webhookFailoverUrl ?? options.webhookFailoverUrl,
        webhookUrl: resolved?.webhookUrl ?? options.webhookUrl,
      };
      assertConfiguration(
        config as Required<
          Pick<
            TelnyxTenantConfiguration,
            "accountId" | "messagingProfileId" | "webhookUrl"
          >
        > &
          TelnyxTenantConfiguration,
      );
      const client = config.client!;
      const params: TelnyxStandardMessageParams | TelnyxRcsMessageParams =
        message.to.transport === "rcs"
          ? (() => {
              if (config.rcsAgentId === undefined)
                throw new TelnyxConfigurationError(
                  "rcsAgentId is required for RCS",
                );
              const fallback = message.fallbacks?.[0];
              const fallbackContent = fallback?.content ?? message.content;
              const fallbackText =
                textOf(fallbackContent) ?? textOf(message.content);
              return {
                agent_id: config.rcsAgentId,
                agent_message: toRcsAgentMessage(message.content),
                messaging_profile_id: config.messagingProfileId,
                ...(fallback?.transport === "sms"
                  ? {
                      sms_fallback: {
                        ...(fallback.from === undefined
                          ? {}
                          : { from: fallback.from.address }),
                        ...(fallbackText === undefined
                          ? {}
                          : { text: fallbackText }),
                      },
                    }
                  : {}),
                ...(fallback?.transport === "mms"
                  ? {
                      mms_fallback: {
                        ...(fallback.from === undefined
                          ? {}
                          : { from: fallback.from.address }),
                        ...(fallbackContent.kind === "media"
                          ? {
                              media_urls: [...fallbackContent.mediaUrls],
                              ...(fallbackContent.subject === undefined
                                ? {}
                                : { subject: fallbackContent.subject }),
                            }
                          : {}),
                        ...(fallbackText === undefined
                          ? {}
                          : { text: fallbackText }),
                      },
                    }
                  : {}),
                to: message.to.address,
                type: "RCS" as const,
                webhook_url: config.webhookUrl!,
              };
            })()
          : standardParams(message, config, options);
      const store = options.idempotencyStore;
      const claim =
        message.idempotencyKey === undefined
          ? undefined
          : await store?.begin({
              fingerprint: await fingerprintPayload(params),
              leaseMs: options.idempotencyLeaseMs ?? 60_000,
              now,
              scope: {
                account: config.accountId,
                key: message.idempotencyKey,
                namespace: "dispatch.send",
                provider: "telnyx",
                ...(message.tenant === undefined
                  ? {}
                  : { tenant: message.tenant }),
              },
            });
      if (message.idempotencyKey !== undefined && claim === undefined)
        throw new TelnyxConfigurationError(
          "idempotencyStore is required when idempotencyKey is set",
        );
      if (claim?.disposition === "completed") return claim.result;
      if (claim?.disposition === "conflict")
        throw new TelnyxIdempotencyConflictError(
          "idempotency key was used with a different payload",
        );
      if (claim?.disposition === "in-flight")
        throw new TelnyxIdempotencyInFlightError("send is already in flight");
      if (claim?.disposition === "indeterminate")
        throw new TelnyxIdempotencyIndeterminateError(
          claim.reason ??
            "Telnyx may have accepted this send; reconcile before retrying",
        );
      if (claim?.disposition === "claimed")
        await store!.markExecuting(claim.operationId, claim.token, now);
      let response: TelnyxMessageResponse;
      try {
        response =
          message.to.transport === "rcs"
            ? await client.messages.rcs.send(params as TelnyxRcsMessageParams)
            : message.sendAt === undefined
              ? await client.messages.send(
                  params as TelnyxStandardMessageParams,
                )
              : await client.messages.schedule(
                  params as TelnyxStandardMessageParams,
                );
      } catch (error) {
        if (claim?.disposition === "claimed") {
          await store!
            .markIndeterminate(
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
              ...(response.data?.id === undefined
                ? {}
                : { providerMessageId: response.data.id }),
              route: "primary",
              status: "accepted",
              transport: message.to.transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        ...(response.data?.id === undefined ? {} : { id: response.data.id }),
        provider: "telnyx",
      };
      if (claim?.disposition === "claimed")
        await store!.complete(claim.operationId, claim.token, result, now);
      return result;
    },
  };
};

export const checkTelnyxRcsCapabilities = async (input: {
  agentId: string;
  client: TelnyxClientLike;
  phoneNumber: string;
}) => {
  if (!E164.test(input.phoneNumber))
    throw new TelnyxConfigurationError("phoneNumber must be E.164");
  const response = await input.client.messaging.rcs.retrieveCapabilities(
    input.phoneNumber,
    { agent_id: input.agentId },
  );
  return {
    capable: (response.data?.features?.length ?? 0) > 0,
    features: [...(response.data?.features ?? [])],
    phoneNumber: response.data?.phone_number ?? input.phoneNumber,
  };
};
