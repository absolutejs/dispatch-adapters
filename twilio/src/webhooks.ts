import twilio from "twilio";
import {
  TWILIO_MESSAGE_STATUSES,
  type TwilioConsentEvent,
  type TwilioLifecycleClaim,
  type TwilioLifecycleStore,
  type TwilioMessageStatus,
  type TwilioOptOutType,
  type TwilioStatusEvent,
  type TwilioWebhookEvent,
} from "./lifecycle";

export type CreateTwilioWebhookHandlerOptions = {
  authToken: string;
  store: TwilioLifecycleStore;
  /** Called only after an event is atomically accepted by the store. */
  onEvent: (event: TwilioWebhookEvent) => Promise<void> | void;
  /** Resolve the exact public URL Twilio signed when behind a trusted proxy. */
  resolvePublicUrl?: (request: Request) => string;
};

export type TwilioWebhookProcessingResult = TwilioLifecycleClaim & {
  event: TwilioWebhookEvent;
};

export class TwilioWebhookError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TwilioWebhookError";
    this.status = status;
  }
}

const MESSAGE_SID = /^SM[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const STATUS_SET = new Set<string>(TWILIO_MESSAGE_STATUSES);
const OPT_OUT_TYPES = new Set<string>(["HELP", "START", "STOP"]);

const required = (params: Record<string, string>, key: string) => {
  const value = params[key];
  if (value === undefined || value.length === 0) {
    throw new TwilioWebhookError(`missing Twilio webhook field: ${key}`, 400);
  }
  return value;
};

const common = (params: Record<string, string>) => {
  const accountSid = required(params, "AccountSid");
  const messageSid = required(params, "MessageSid");
  if (!ACCOUNT_SID.test(accountSid) || !MESSAGE_SID.test(messageSid)) {
    throw new TwilioWebhookError("invalid Twilio webhook SID", 400);
  }
  return {
    accountSid,
    ...(params.From === undefined ? {} : { from: params.From }),
    messageSid,
    receivedAt: Date.now(),
    ...(params.To === undefined ? {} : { to: params.To }),
  };
};

export const parseTwilioWebhookEvent = (
  params: Readonly<Record<string, string>>,
): TwilioWebhookEvent => {
  const raw = Object.freeze({ ...params });
  const shared = common(raw);
  const optOutType = raw.OptOutType?.toUpperCase();
  if (optOutType !== undefined) {
    if (!OPT_OUT_TYPES.has(optOutType)) {
      throw new TwilioWebhookError("unsupported Twilio OptOutType", 400);
    }
    return {
      ...shared,
      ...(raw.Body === undefined ? {} : { body: raw.Body }),
      eventId: `consent:${shared.messageSid}:${optOutType}`,
      kind: "consent",
      optOutType: optOutType as TwilioOptOutType,
      raw,
    } satisfies TwilioConsentEvent;
  }

  const status = raw.MessageStatus ?? raw.SmsStatus;
  if (status === undefined || !STATUS_SET.has(status)) {
    throw new TwilioWebhookError("unsupported Twilio messaging webhook", 400);
  }
  const errorCodeValue = raw.ErrorCode;
  const errorCode =
    errorCodeValue === undefined || errorCodeValue.length === 0
      ? undefined
      : Number(errorCodeValue);
  if (errorCode !== undefined && !Number.isInteger(errorCode)) {
    throw new TwilioWebhookError("invalid Twilio ErrorCode", 400);
  }
  return {
    ...shared,
    ...(errorCode === undefined ? {} : { errorCode }),
    eventId: `status:${shared.messageSid}:${status}:${errorCode ?? ""}`,
    kind: "status",
    raw,
    status: status as TwilioMessageStatus,
  } satisfies TwilioStatusEvent;
};

const readForm = async (request: Request) => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0];
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new TwilioWebhookError(
      "Twilio messaging webhooks must be form encoded",
      415,
    );
  }
  const body = await request.text();
  const search = new URLSearchParams(body);
  const params: Record<string, string> = {};
  for (const [key, value] of search) params[key] = value;
  return params;
};

export const createTwilioWebhookProcessor = (
  options: CreateTwilioWebhookHandlerOptions,
) => {
  if (options.authToken.length === 0) {
    throw new TwilioWebhookError("authToken must not be empty", 500);
  }

  return async (request: Request): Promise<TwilioWebhookProcessingResult> => {
    if (request.method !== "POST") {
      throw new TwilioWebhookError("Twilio webhooks require POST", 405);
    }
    const params = await readForm(request);
    const signature = request.headers.get("x-twilio-signature");
    if (signature === null) {
      throw new TwilioWebhookError("missing X-Twilio-Signature", 403);
    }
    const publicUrl = options.resolvePublicUrl?.(request) ?? request.url;
    if (
      !twilio.validateRequest(options.authToken, signature, publicUrl, params)
    ) {
      throw new TwilioWebhookError("invalid Twilio webhook signature", 403);
    }

    const event = parseTwilioWebhookEvent(params);
    const result = await options.store.begin(event);
    if (result.claimToken !== undefined) {
      try {
        await options.onEvent(event);
        await options.store.complete(event.eventId, result.claimToken);
      } catch (error) {
        await options.store.release(event.eventId, result.claimToken);
        throw error;
      }
    }
    return { ...result, event };
  };
};

export const createTwilioWebhookHandler = (
  options: CreateTwilioWebhookHandlerOptions,
) => {
  const process = createTwilioWebhookProcessor(options);
  return async (request: Request): Promise<Response> => {
    try {
      const result = await process(request);
      return Response.json(
        { disposition: result.disposition, eventId: result.event.eventId },
        { status: 200 },
      );
    } catch (error) {
      if (error instanceof TwilioWebhookError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }
      return Response.json(
        { error: "Twilio webhook processing failed" },
        { status: 500 },
      );
    }
  };
};
