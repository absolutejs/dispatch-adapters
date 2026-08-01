import twilio from "twilio";
import type {
  MessagingConsentLedger,
  MessagingConsentScope,
} from "@absolutejs/compliance";
import {
  TWILIO_MESSAGE_STATUSES,
  type TwilioConsentEvent,
  type TwilioInboundEvent,
  type TwilioLifecycleClaim,
  type TwilioLifecycleStore,
  type TwilioMessageStatus,
  type TwilioOptOutType,
  type TwilioStatusEvent,
  type TwilioWebhookEvent,
} from "./lifecycle";

export type CreateTwilioWebhookHandlerOptions = {
  authToken: string;
  expectedAccountSid: string;
  expectedMessagingServiceSid?: string;
  /** Exact public HTTPS callback URL configured in Twilio. */
  publicUrl: string;
  store: TwilioLifecycleStore;
  /** Persist signed START/STOP events into the provider-neutral consent ledger. */
  consent?: {
    ledger: MessagingConsentLedger;
    resolveScope: (
      event: TwilioConsentEvent,
    ) => Promise<MessagingConsentScope> | MessagingConsentScope;
  };
  /** Called only after an event is atomically accepted by the store. */
  onEvent: (event: TwilioWebhookEvent) => Promise<void> | void;
  /** Maximum accepted form body. Defaults to 64 KiB. */
  maxBodyBytes?: number;
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
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
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
  if (status === undefined && raw.From !== undefined && raw.To !== undefined) {
    const count = Number(raw.NumMedia ?? "0");
    if (!Number.isInteger(count) || count < 0 || count > 10) {
      throw new TwilioWebhookError("invalid Twilio NumMedia", 400);
    }
    const media = Array.from({ length: count }, (_, index) => ({
      ...(raw[`MediaContentType${index}`] === undefined
        ? {}
        : { contentType: raw[`MediaContentType${index}`] }),
      url: required(raw, `MediaUrl${index}`),
    }));
    return {
      ...shared,
      ...(raw.Body === undefined ? {} : { body: raw.Body }),
      eventId: `inbound:${shared.messageSid}`,
      kind: "inbound",
      media,
      raw,
    } satisfies TwilioInboundEvent;
  }
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

const readForm = async (request: Request, maxBodyBytes: number) => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0];
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new TwilioWebhookError(
      "Twilio messaging webhooks must be form encoded",
      415,
    );
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new TwilioWebhookError("Twilio webhook body is too large", 413);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    throw new TwilioWebhookError("Twilio webhook body is too large", 413);
  }
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
  if (!ACCOUNT_SID.test(options.expectedAccountSid)) {
    throw new TwilioWebhookError("expectedAccountSid must be an AC SID", 500);
  }
  if (
    options.expectedMessagingServiceSid !== undefined &&
    !MESSAGING_SERVICE_SID.test(options.expectedMessagingServiceSid)
  ) {
    throw new TwilioWebhookError(
      "expectedMessagingServiceSid must be an MG SID",
      500,
    );
  }
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.protocol !== "https:") {
    throw new TwilioWebhookError("publicUrl must use HTTPS", 500);
  }

  return async (request: Request): Promise<TwilioWebhookProcessingResult> => {
    if (request.method !== "POST") {
      throw new TwilioWebhookError("Twilio webhooks require POST", 405);
    }
    const params = await readForm(request, options.maxBodyBytes ?? 64 * 1024);
    const signature = request.headers.get("x-twilio-signature");
    if (signature === null) {
      throw new TwilioWebhookError("missing X-Twilio-Signature", 403);
    }
    if (
      !twilio.validateRequest(
        options.authToken,
        signature,
        options.publicUrl,
        params,
      )
    ) {
      throw new TwilioWebhookError("invalid Twilio webhook signature", 403);
    }

    const event = parseTwilioWebhookEvent(params);
    if (event.accountSid !== options.expectedAccountSid) {
      throw new TwilioWebhookError("unexpected Twilio account", 403);
    }
    if (
      options.expectedMessagingServiceSid !== undefined &&
      params.MessagingServiceSid !== options.expectedMessagingServiceSid
    ) {
      throw new TwilioWebhookError("unexpected Twilio Messaging Service", 403);
    }
    const result = await options.store.begin(event);
    if (result.claimToken !== undefined) {
      try {
        if (event.kind === "consent" && event.optOutType !== "HELP") {
          const scope = await options.consent?.resolveScope(event);
          if (scope !== undefined) {
            const evidence = {
              at: event.receivedAt,
              idempotencyKey: `twilio:${event.eventId}`,
              metadata: { optOutType: event.optOutType },
              reference: event.messageSid,
              source: "twilio-advanced-opt-out",
            };
            if (event.optOutType === "START") {
              await options.consent?.ledger.grant(scope, evidence);
            } else {
              await options.consent?.ledger.revoke(scope, evidence);
            }
          }
        }
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
