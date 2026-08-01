import type { SmsAdapter, SmsMessage } from "@absolutejs/dispatch";

export type TwilioMessageCreateParams = {
  body: string;
  from?: string;
  messagingServiceSid: string;
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
  /** Twilio Messaging Service used for every message. */
  messagingServiceSid: string;
  /** Public callback receiving signed delivery lifecycle events. */
  statusCallbackUrl: string;
  /** Ask Twilio to replace Unicode lookalikes with GSM-7 characters. */
  smartEncoded?: boolean;
  /** Seconds Twilio may keep trying to send. Twilio accepts 1–36,000. */
  validityPeriod?: number;
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

const E164 = /^\+[1-9]\d{1,14}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;

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
  if (!E164.test(message.to)) {
    throw new TwilioConfigurationError(
      "SMS recipient must be an E.164 phone number",
    );
  }
  if (message.from !== undefined && !E164.test(message.from)) {
    throw new TwilioConfigurationError(
      "SMS sender must be an E.164 phone number",
    );
  }
  if (message.body.trim().length === 0) {
    throw new TwilioConfigurationError("SMS body must not be empty");
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
      const params: TwilioMessageCreateParams = {
        body: message.body,
        messagingServiceSid: options.messagingServiceSid,
        statusCallback: options.statusCallbackUrl,
        to: message.to,
      };
      if (message.from !== undefined) params.from = message.from;
      if (options.smartEncoded !== undefined) {
        params.smartEncoded = options.smartEncoded;
      }
      if (options.validityPeriod !== undefined) {
        params.validityPeriod = options.validityPeriod;
      }

      const response = await options.client.messages.create(params);
      if (response.errorCode !== null && response.errorCode !== undefined) {
        throw new TwilioSendError(response.errorCode, response.errorMessage);
      }
      return {
        at: Date.now(),
        ...(response.sid === undefined ? {} : { id: response.sid }),
        provider: "twilio",
      };
    },
  };
};
