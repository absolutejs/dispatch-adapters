import type {
  MessagingAdapter,
  MessagingDispatchResult,
  MessagingMessage,
} from "@absolutejs/dispatch";
import {
  fingerprintTwilioPayload,
  TwilioIdempotencyIndeterminateError,
  type TwilioIdempotencyScope,
  type TwilioIdempotencyStore,
} from "./idempotency";

export type TwilioMessageCreateParams = {
  addressRetention?: "obfuscate" | "retain";
  body?: string;
  contentRetention?: "discard" | "retain";
  contentSid?: string;
  contentVariables?: string;
  from?: string;
  fallbackFrom?: string;
  mediaUrl?: string[];
  messagingServiceSid: string;
  scheduleType?: "fixed";
  sendAt?: Date;
  smartEncoded?: boolean;
  statusCallback: string;
  to: string;
  validityPeriod?: number;
};

export type TwilioClientLike = {
  messages: {
    create: (params: TwilioMessageCreateParams) => Promise<{
      errorCode?: number | null;
      errorMessage?: string | null;
      sid?: string;
      status?: string;
    }>;
  };
};

export type CreateTwilioAdapterOptions = {
  /** Explicit opt-in to provider-side scheduling. Consent-scoped sends remain prohibited. */
  allowNativeScheduling?: boolean;
  /** Twilio account owning the default client and Messaging Service. */
  accountSid: string;
  /** Optional normalized operational capabilities exposed through the adapter. */
  capabilities?: MessagingAdapter["capabilities"];
  client: TwilioClientLike;
  idempotencyStore?: TwilioIdempotencyStore;
  /** Twilio Messaging Service used for every message. */
  messagingServiceSid: string;
  /** Override service/callback/sender for an isolated tenant account or service. */
  resolveTenant?: (
    tenant: string,
  ) => Promise<TwilioTenantConfiguration> | TwilioTenantConfiguration;
  /** Public callback receiving signed delivery lifecycle events. */
  statusCallbackUrl: string;
  /** Ask Twilio to replace Unicode lookalikes with GSM-7 characters. */
  smartEncoded?: boolean;
  /** Seconds Twilio may keep trying to send. Twilio accepts 1–36,000. */
  validityPeriod?: number;
  /** Injectable clock for scheduling validation and deterministic tests. */
  now?: () => number;
};

export type TwilioTenantConfiguration = {
  accountSid: string;
  client?: TwilioClientLike;
  from?: string;
  messagingServiceSid: string;
  statusCallbackUrl?: string;
};

export class TwilioConfigurationError extends Error {
  override name = "TwilioConfigurationError";
}

export class TwilioSendError extends Error {
  readonly code: number;

  constructor(code: number, message?: string | null) {
    super(`Twilio error ${code}: ${message ?? "(no message)"}`);
    this.name = "TwilioSendError";
    this.code = code;
  }
}

export class TwilioIdempotencyInFlightError extends Error {
  override name = "TwilioIdempotencyInFlightError";
}

const E164 = /^\+[1-9]\d{1,14}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CONTENT_SID = /^HX[0-9a-fA-F]{32}$/;

const assertConfiguration = (options: CreateTwilioAdapterOptions) => {
  if (!ACCOUNT_SID.test(options.accountSid)) {
    throw new TwilioConfigurationError(
      "accountSid must be a Twilio Account SID (AC followed by 32 hexadecimal characters)",
    );
  }
  if (!MESSAGING_SERVICE_SID.test(options.messagingServiceSid)) {
    throw new TwilioConfigurationError(
      "messagingServiceSid must be a Twilio Messaging Service SID (MG followed by 32 hexadecimal characters)",
    );
  }

  let callback: URL;
  try {
    callback = new URL(options.statusCallbackUrl);
  } catch {
    throw new TwilioConfigurationError(
      "statusCallbackUrl must be an absolute URL",
    );
  }
  const local =
    callback.hostname === "localhost" || callback.hostname === "127.0.0.1";
  if (
    callback.protocol !== "https:" &&
    !(local && callback.protocol === "http:")
  ) {
    throw new TwilioConfigurationError(
      "statusCallbackUrl must use HTTPS (HTTP is accepted only for localhost)",
    );
  }

  if (
    options.validityPeriod !== undefined &&
    (!Number.isInteger(options.validityPeriod) ||
      options.validityPeriod < 1 ||
      options.validityPeriod > 36_000)
  ) {
    throw new TwilioConfigurationError(
      "validityPeriod must be an integer between 1 and 36000 seconds",
    );
  }
};

const assertMessage = (
  message: MessagingMessage,
  options: Pick<CreateTwilioAdapterOptions, "allowNativeScheduling" | "now">,
) => {
  const transport = message.to.transport;
  if (!E164.test(message.to.address)) {
    throw new TwilioConfigurationError("recipient address must be E.164");
  }
  if (message.fallbacks !== undefined && transport !== "rcs") {
    throw new TwilioConfigurationError(
      "Twilio fallback routes are supported only for an RCS primary route",
    );
  }
  if ((message.fallbacks?.length ?? 0) > 1) {
    throw new TwilioConfigurationError(
      "Twilio RCS supports at most one SMS fallback route",
    );
  }
  const fallback = message.fallbacks?.[0];
  if (fallback !== undefined && fallback.transport !== "sms") {
    throw new TwilioConfigurationError("Twilio RCS fallback must use SMS");
  }
  if (fallback?.content !== undefined) {
    throw new TwilioConfigurationError(
      "Twilio fallback content is defined by the Content Template and cannot be overridden per route",
    );
  }
  if (transport === "rcs" && message.from !== undefined) {
    throw new TwilioConfigurationError(
      "RCS sender comes from the Messaging Service pool; set the fallback route sender instead",
    );
  }
  if (message.from !== undefined) {
    if (message.from.transport !== transport) {
      throw new TwilioConfigurationError(
        "primary sender transport must match the recipient transport",
      );
    }
    if (!E164.test(message.from.address)) {
      throw new TwilioConfigurationError("sender address must be E.164");
    }
  }
  if (fallback?.from !== undefined) {
    if (
      fallback.from.transport !== fallback.transport ||
      !E164.test(fallback.from.address)
    ) {
      throw new TwilioConfigurationError(
        "fallback sender must be an E.164 endpoint matching the fallback transport",
      );
    }
  }
  if (
    message.content.kind === "text" &&
    message.content.text.trim().length === 0
  ) {
    throw new TwilioConfigurationError("message body must not be empty");
  }
  if (
    message.content.kind === "template" &&
    !CONTENT_SID.test(message.content.id)
  ) {
    throw new TwilioConfigurationError(
      "template id must be a Twilio Content SID",
    );
  }
  if (message.content.kind === "rich") {
    throw new TwilioConfigurationError(
      "Twilio rich content must be published as a Content Template and sent with content.kind template",
    );
  }
  for (const mediaUrl of message.content.kind === "media"
    ? message.content.mediaUrls
    : []) {
    let parsed: URL;
    try {
      parsed = new URL(mediaUrl);
    } catch {
      throw new TwilioConfigurationError(
        "media URLs must be absolute HTTPS URLs",
      );
    }
    if (parsed.protocol !== "https:") {
      throw new TwilioConfigurationError("media URLs must use HTTPS");
    }
  }
  if (message.sendAt !== undefined) {
    const sendAt = new Date(message.sendAt);
    const now = options.now?.() ?? Date.now();
    if (options.allowNativeScheduling !== true) {
      throw new TwilioConfigurationError(
        "native scheduling is disabled; enqueue the dispatch operation so consent is re-evaluated at send time",
      );
    }
    if (message.consent !== undefined) {
      throw new TwilioConfigurationError(
        "consent-scoped messages must be scheduled through an application queue and re-evaluated at send time",
      );
    }
    if (
      Number.isNaN(sendAt.valueOf()) ||
      sendAt.valueOf() < now + 15 * 60_000 ||
      sendAt.valueOf() > now + 35 * 24 * 60 * 60_000
    ) {
      throw new TwilioConfigurationError(
        "sendAt must be between 15 minutes and 35 days in the future",
      );
    }
  }
};

export const createTwilioAdapter = (
  options: CreateTwilioAdapterOptions,
): MessagingAdapter => {
  assertConfiguration(options);

  return {
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    name: "twilio",
    send: async (message) => {
      assertMessage(message, options);
      const tenant =
        message.tenant === undefined
          ? undefined
          : await options.resolveTenant?.(message.tenant);
      const accountSid = tenant?.accountSid ?? options.accountSid;
      const client = tenant?.client ?? options.client;
      const messagingServiceSid =
        tenant?.messagingServiceSid ?? options.messagingServiceSid;
      const statusCallback =
        tenant?.statusCallbackUrl ?? options.statusCallbackUrl;
      assertConfiguration({
        ...options,
        accountSid,
        messagingServiceSid,
        statusCallbackUrl: statusCallback,
      });
      const params: TwilioMessageCreateParams = {
        ...(message.privacy?.addressRetention === undefined
          ? {}
          : { addressRetention: message.privacy.addressRetention }),
        ...(message.content.kind === "text"
          ? { body: message.content.text }
          : {}),
        ...(message.content.kind === "media"
          ? {
              ...(message.content.text === undefined
                ? {}
                : { body: message.content.text }),
              mediaUrl: [...message.content.mediaUrls],
            }
          : {}),
        ...(message.content.kind === "template"
          ? {
              contentSid: message.content.id,
              ...(message.content.variables === undefined
                ? {}
                : {
                    contentVariables: JSON.stringify(message.content.variables),
                  }),
            }
          : {}),
        ...(message.privacy?.contentRetention === undefined
          ? {}
          : { contentRetention: message.privacy.contentRetention }),
        messagingServiceSid,
        statusCallback,
        to:
          message.to.transport === "rcs" && message.fallbacks === undefined
            ? `rcs:${message.to.address}`
            : message.to.transport === "whatsapp"
              ? `whatsapp:${message.to.address}`
              : message.to.address,
      };
      const fallback = message.fallbacks?.[0];
      if (fallback?.from !== undefined) {
        params.fallbackFrom = fallback.from.address;
      }
      const from =
        message.to.transport === "rcs"
          ? undefined
          : (message.from?.address ?? tenant?.from);
      if (from !== undefined && !E164.test(from)) {
        throw new TwilioConfigurationError(
          "resolved sender must be an E.164 address",
        );
      }
      if (from !== undefined) {
        params.from =
          message.to.transport === "whatsapp" ? `whatsapp:${from}` : from;
      }
      if (message.sendAt !== undefined) {
        params.scheduleType = "fixed";
        params.sendAt = new Date(message.sendAt);
      }
      if (options.smartEncoded !== undefined) {
        params.smartEncoded = options.smartEncoded;
      }
      if (options.validityPeriod !== undefined) {
        params.validityPeriod = options.validityPeriod;
      }

      const scope: TwilioIdempotencyScope | undefined =
        message.idempotencyKey === undefined
          ? undefined
          : {
              accountSid,
              key: message.idempotencyKey,
              ...(message.tenant === undefined
                ? {}
                : { tenant: message.tenant }),
            };
      const claim =
        scope === undefined
          ? undefined
          : await options.idempotencyStore?.begin(
              scope,
              fingerprintTwilioPayload(params),
            );
      if (scope !== undefined && claim === undefined) {
        throw new TwilioConfigurationError(
          "idempotencyStore is required when idempotencyKey is set",
        );
      }
      if (claim?.disposition === "completed") {
        if (claim.outcome.kind === "provider-error") {
          throw new TwilioSendError(claim.outcome.code, claim.outcome.message);
        }
        return claim.outcome.result;
      }
      if (claim?.disposition === "in-flight") {
        throw new TwilioIdempotencyInFlightError(
          "a send with this account, tenant, and idempotency key is already in flight",
        );
      }
      if (claim?.disposition === "indeterminate") {
        throw new TwilioIdempotencyIndeterminateError(
          "Twilio may have accepted this send; reconcile it before retrying with a new key",
        );
      }
      const claimToken =
        claim?.disposition === "claimed" ? claim.token : undefined;
      if (scope !== undefined && claimToken !== undefined) {
        try {
          await options.idempotencyStore!.markExecuting(scope, claimToken);
        } catch (error) {
          await options
            .idempotencyStore!.releasePrepared(scope, claimToken)
            .catch(() => undefined);
          throw error;
        }
      }

      let response: Awaited<ReturnType<TwilioClientLike["messages"]["create"]>>;
      try {
        response = await client.messages.create(params);
      } catch (error) {
        if (scope !== undefined && claimToken !== undefined) {
          await options
            .idempotencyStore!.markIndeterminate(scope, claimToken)
            .catch(() => undefined);
        }
        throw error;
      }
      if (response.errorCode !== null && response.errorCode !== undefined) {
        if (scope !== undefined && claimToken !== undefined) {
          await options.idempotencyStore!.complete(scope, claimToken, {
            code: response.errorCode,
            kind: "provider-error",
            ...(response.errorMessage === null ||
            response.errorMessage === undefined
              ? {}
              : { message: response.errorMessage }),
          });
        }
        throw new TwilioSendError(response.errorCode, response.errorMessage);
      }
      const result: MessagingDispatchResult = {
        at: Date.now(),
        delivery: {
          actualTransport: message.to.transport,
          attempts: [
            {
              actualTransport: message.to.transport,
              ...(response.sid === undefined
                ? {}
                : { providerMessageId: response.sid }),
              route: "primary",
              status: "accepted",
              transport: message.to.transport,
            },
          ],
          requestedTransport: message.to.transport,
        },
        ...(response.sid === undefined ? {} : { id: response.sid }),
        provider: "twilio",
      };
      if (scope !== undefined && claimToken !== undefined) {
        await options.idempotencyStore!.complete(scope, claimToken, {
          kind: "success",
          result,
        });
      }
      return result;
    },
  };
};
