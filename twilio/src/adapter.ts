import type { SmsAdapter, SmsMessage } from "@absolutejs/dispatch";
import type { TwilioIdempotencyStore } from "./idempotency";

export type TwilioMessageCreateParams = {
  body?: string;
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
};

export type TwilioTenantConfiguration = {
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
const RCS_RECIPIENT = /^rcs:\+[1-9]\d{1,14}$/;
const WHATSAPP = /^whatsapp:\+[1-9]\d{1,14}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const CONTENT_SID = /^HX[0-9a-fA-F]{32}$/;

const assertConfiguration = (options: CreateTwilioAdapterOptions) => {
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

const assertMessage = (message: SmsMessage) => {
  const channel = message.channel ?? "sms";
  if (
    (channel === "whatsapp" && !WHATSAPP.test(message.to)) ||
    (channel === "rcs" &&
      !E164.test(message.to) &&
      !RCS_RECIPIENT.test(message.to)) ||
    (channel !== "whatsapp" && channel !== "rcs" && !E164.test(message.to))
  ) {
    throw new TwilioConfigurationError(
      "recipient must match the selected messaging channel",
    );
  }
  if (channel !== "rcs" && message.rcs !== undefined) {
    throw new TwilioConfigurationError("rcs options require channel rcs");
  }
  if (message.rcs?.fallback === "automatic" && RCS_RECIPIENT.test(message.to)) {
    throw new TwilioConfigurationError(
      "automatic RCS fallback requires an E.164 recipient without the rcs: prefix",
    );
  }
  if (message.rcs?.fallbackFrom !== undefined) {
    if (!E164.test(message.rcs.fallbackFrom)) {
      throw new TwilioConfigurationError(
        "RCS fallback sender must be an E.164 phone number",
      );
    }
    if (message.rcs.fallback === "disabled" || RCS_RECIPIENT.test(message.to)) {
      throw new TwilioConfigurationError(
        "RCS fallback sender cannot be used when fallback is disabled",
      );
    }
  }
  if (channel === "rcs" && message.from !== undefined) {
    throw new TwilioConfigurationError(
      "RCS sender comes from the Messaging Service pool; use rcs.fallbackFrom for fallback",
    );
  }
  if (
    message.from !== undefined &&
    ((channel === "whatsapp" && !WHATSAPP.test(message.from)) ||
      (channel !== "whatsapp" && !E164.test(message.from)))
  ) {
    throw new TwilioConfigurationError(
      "SMS sender must be an E.164 phone number",
    );
  }
  if (
    message.body?.trim().length !== 0 &&
    message.body === undefined &&
    message.template === undefined
  ) {
    throw new TwilioConfigurationError("message body or template is required");
  }
  if (message.body !== undefined && message.body.trim().length === 0) {
    throw new TwilioConfigurationError("message body must not be empty");
  }
  if (
    message.template !== undefined &&
    !CONTENT_SID.test(message.template.id)
  ) {
    throw new TwilioConfigurationError(
      "template id must be a Twilio Content SID",
    );
  }
  for (const mediaUrl of message.mediaUrls ?? []) {
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
    if (Number.isNaN(sendAt.valueOf()) || sendAt.valueOf() <= Date.now()) {
      throw new TwilioConfigurationError(
        "sendAt must be a future ISO-8601 time",
      );
    }
  }
};

export const createTwilioAdapter = (
  options: CreateTwilioAdapterOptions,
): SmsAdapter => {
  assertConfiguration(options);

  return {
    name: "twilio",
    send: async (message) => {
      assertMessage(message);
      const claim = message.idempotencyKey
        ? await options.idempotencyStore?.begin(message.idempotencyKey)
        : undefined;
      if (message.idempotencyKey && claim === undefined) {
        throw new TwilioConfigurationError(
          "idempotencyStore is required when idempotencyKey is set",
        );
      }
      if (claim?.disposition === "completed") return claim.result;
      if (claim?.disposition === "in-flight") {
        throw new TwilioIdempotencyInFlightError(
          "a send with this idempotency key is already in flight",
        );
      }
      const claimToken =
        claim?.disposition === "claimed" ? claim.token : undefined;
      try {
        const tenant =
          message.tenant === undefined
            ? undefined
            : await options.resolveTenant?.(message.tenant);
        const client = tenant?.client ?? options.client;
        const messagingServiceSid =
          tenant?.messagingServiceSid ?? options.messagingServiceSid;
        const statusCallback =
          tenant?.statusCallbackUrl ?? options.statusCallbackUrl;
        assertConfiguration({
          ...options,
          messagingServiceSid,
          statusCallbackUrl: statusCallback,
        });
        const params: TwilioMessageCreateParams = {
          ...(message.body === undefined ? {} : { body: message.body }),
          ...(message.mediaUrls === undefined
            ? {}
            : { mediaUrl: [...message.mediaUrls] }),
          ...(message.template === undefined
            ? {}
            : {
                contentSid: message.template.id,
                ...(message.template.variables === undefined
                  ? {}
                  : {
                      contentVariables: JSON.stringify(
                        message.template.variables,
                      ),
                    }),
              }),
          messagingServiceSid,
          statusCallback,
          to:
            message.channel === "rcs" &&
            message.rcs?.fallback === "disabled" &&
            E164.test(message.to)
              ? `rcs:${message.to}`
              : message.to,
        };
        if (message.rcs?.fallbackFrom !== undefined) {
          params.fallbackFrom = message.rcs.fallbackFrom;
        }
        const from =
          message.channel === "rcs"
            ? undefined
            : (message.from ?? tenant?.from);
        if (
          from !== undefined &&
          ((message.channel === "whatsapp" && !WHATSAPP.test(from)) ||
            (message.channel !== "whatsapp" && !E164.test(from)))
        ) {
          throw new TwilioConfigurationError(
            "resolved sender must match the selected messaging channel",
          );
        }
        if (from !== undefined) params.from = from;
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

        const response = await client.messages.create(params);
        if (response.errorCode !== null && response.errorCode !== undefined) {
          throw new TwilioSendError(response.errorCode, response.errorMessage);
        }
        const result = {
          at: Date.now(),
          ...(response.sid === undefined ? {} : { id: response.sid }),
          provider: "twilio",
        };
        if (message.idempotencyKey && claimToken) {
          await options.idempotencyStore?.complete(
            message.idempotencyKey,
            claimToken,
            result,
          );
        }
        return result;
      } catch (error) {
        if (message.idempotencyKey && claimToken) {
          await options.idempotencyStore
            ?.release(message.idempotencyKey, claimToken)
            .catch(() => undefined);
        }
        throw error;
      }
    },
  };
};
