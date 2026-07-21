/**
 * @absolutejs/dispatch-resend — Resend-backed `EmailAdapter` for
 * `@absolutejs/dispatch`.
 *
 * Takes the user's Resend client (so they control the API key, the
 * fetch impl, the timeout config — everything the Resend SDK accepts
 * directly). Maps `EmailMessage` to Resend's request shape and the
 * response's `id` to `DispatchResult.id`.
 *
 * Resend errors propagate as Promise rejections — `@absolutejs/dispatch`
 * captures them on the `dispatch.email.send` span, bumps the failed
 * counter, emits the `dispatch.email.failed` audit event, and re-throws.
 */
import type {
  DispatchResult,
  EmailAdapter,
  EmailMessage,
} from "@absolutejs/dispatch";
import type {
  EffectAdapterDescriptor,
  EffectAdapterDriver,
  EffectAdapterDriverContext,
  EffectAdapterQueryDriver,
  EffectEvidenceRecord,
} from "@absolutejs/execution";
import { Resend, type WebhookEventPayload } from "resend";

export const RESEND_EFFECT_ADAPTER_ID = "absolutejs.dispatch-resend";
export const RESEND_EFFECT_API_DESTINATION = "https://api.resend.com";
export const RESEND_EMAIL_EFFECT = "email.send";
export const RESEND_EFFECT_ID_TAG = "abs_effect";
export const RESEND_WEBHOOK_SECRET_ALIAS = "RESEND_WEBHOOK_SECRET";
export const RESEND_EFFECT_WEBHOOK_EVENTS = [
  "email.sent",
  "email.scheduled",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.suppressed",
] as const;

export const resendEffectAdapterDescriptor: EffectAdapterDescriptor = {
  adapterId: RESEND_EFFECT_ADAPTER_ID,
  compensation: { supported: false },
  credentialBindings: [
    {
      alias: "RESEND_API_KEY",
      destination: RESEND_EFFECT_API_DESTINATION,
      mode: "provider-sdk",
    },
  ],
  destinations: [
    { kind: "https-origin", value: RESEND_EFFECT_API_DESTINATION },
  ],
  effects: [RESEND_EMAIL_EFFECT],
  idempotency: { scope: "tenant-effect", supported: true },
  reconciliation: {
    mode: "webhook-query",
    query: {
      credentialAlias: "RESEND_API_KEY",
      health: {
        staleAfterMs: 900_000,
        strategy: "last-successful-query",
      },
      pollingIntervalMs: 60_000,
      provider: "resend",
      requiresReference: true,
      rotation: { mode: "replace", verification: "successful-query" },
      supportedOutcomes: ["confirmed_succeeded"],
    },
    webhook: {
      callback: {
        body: "raw",
        mediaType: "application/json",
        method: "POST",
        pathTemplate: "/api/webhooks/agent-effects/{tenantId}/resend",
        signatureHeaders: ["svix-id", "svix-timestamp", "svix-signature"],
      },
      events: RESEND_EFFECT_WEBHOOK_EVENTS,
      health: { strategy: "last-verified-event" },
      provider: "resend",
      secret: {
        alias: RESEND_WEBHOOK_SECRET_ALIAS,
        rotation: { mode: "replace", verification: "signed-event" },
      },
    },
  },
  spendAuthority: {
    canSpend: false,
    currencies: [],
    requiresMandate: false,
  },
  title: "Resend transactional email",
  version: "0.5.0",
};

export class ResendEffectInputError extends Error {}

/**
 * Minimal subset of Resend's `Resend` client we use. Declaring it
 * locally keeps `resend` a true peer dep — its types aren't required
 * at compile time, only its tag-template-style API at runtime.
 */
type ResendEmailBase = {
  from: string;
  to: string | string[];
  subject: string;
  reply_to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
};

type ResendEmailParams = ResendEmailBase &
  ({ html: string; text?: string } | { text: string; html?: string });

export type ResendClientLike = {
  emails: {
    send: (
      params: ResendEmailParams,
      options?: { idempotencyKey?: string },
    ) => Promise<{ data?: { id?: string } | null; error?: unknown }>;
  };
};

export type ResendQueryClientLike = {
  emails: {
    get: (id: string) => Promise<{
      data?: {
        created_at: string;
        id: string;
        last_event: string;
        tags?: Array<{ name: string; value: string }>;
      } | null;
      error?: unknown;
    }>;
  };
};

export type CreateResendAdapterOptions = {
  /** The Resend client (`new Resend(process.env.RESEND_KEY)`). */
  client: ResendClientLike;
  /**
   * Default `from` address. Resend REQUIRES `from`; if neither the
   * message nor this default is set, the adapter throws.
   */
  defaultFrom?: string;
  /**
   * Map `EmailMessage.metadata` to Resend's `tags` array. The default
   * passes through string-valued entries (Resend tags must be strings).
   * Override to filter / transform / drop based on your conventions.
   */
  tagsFromMetadata?: (
    metadata: Record<string, unknown>,
  ) => Array<{ name: string; value: string }> | undefined;
};

const defaultTagsFromMetadata = (
  metadata: Record<string, unknown>,
): Array<{ name: string; value: string }> | undefined => {
  const tags: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      tags.push({ name, value });
    }
  }
  return tags.length > 0 ? tags : undefined;
};

const arrayOrUndefined = (
  value: string | ReadonlyArray<string> | undefined,
): string | string[] | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return [...value];
};

export const createResendAdapter = (
  options: CreateResendAdapterOptions,
): EmailAdapter => {
  const { client } = options;
  const tagsFromMetadata = options.tagsFromMetadata ?? defaultTagsFromMetadata;

  return {
    name: "resend",
    send: async (message: EmailMessage) => {
      const from = message.from ?? options.defaultFrom;
      if (from === undefined || from.length === 0) {
        throw new Error(
          "[dispatch-resend] no `from` address — Resend requires one. " +
            "Pass `message.from` per send, or `createResendAdapter({ defaultFrom })`.",
        );
      }
      const tags =
        message.metadata !== undefined
          ? tagsFromMetadata(message.metadata)
          : undefined;
      if (message.text === undefined && message.html === undefined) {
        throw new Error(
          "[dispatch-resend] email requires `text` or `html` content.",
        );
      }
      const content =
        message.html !== undefined
          ? {
              html: message.html,
              ...(message.text !== undefined ? { text: message.text } : {}),
            }
          : { text: message.text! };
      const response = await client.emails.send(
        {
          ...content,
          from,
          to: typeof message.to === "string" ? message.to : [...message.to],
          subject: message.subject,
          ...(message.replyTo !== undefined
            ? { reply_to: message.replyTo }
            : {}),
          ...(arrayOrUndefined(message.cc) !== undefined
            ? { cc: arrayOrUndefined(message.cc) }
            : {}),
          ...(arrayOrUndefined(message.bcc) !== undefined
            ? { bcc: arrayOrUndefined(message.bcc) }
            : {}),
          ...(message.headers !== undefined
            ? { headers: message.headers }
            : {}),
          ...(tags !== undefined ? { tags } : {}),
        },
        message.idempotencyKey
          ? { idempotencyKey: message.idempotencyKey }
          : undefined,
      );
      if (response.error !== undefined && response.error !== null) {
        throw new Error(
          typeof response.error === "object" &&
          response.error !== null &&
          "message" in response.error
            ? String((response.error as { message: unknown }).message)
            : `[dispatch-resend] Resend error: ${JSON.stringify(response.error)}`,
        );
      }
      return {
        at: Date.now(),
        ...(response.data?.id !== undefined ? { id: response.data.id } : {}),
        provider: "resend",
      };
    },
  };
};

const validateEffectMessage = (message: EmailMessage) => {
  const recipients =
    typeof message.to === "string" ? [message.to] : [...message.to];
  if (
    recipients.length === 0 ||
    recipients.some((recipient) => !recipient.trim()) ||
    !message.from?.trim() ||
    !message.subject.trim() ||
    (message.text === undefined && message.html === undefined)
  )
    throw new ResendEffectInputError(
      "Resend effects require recipients, a sender, a subject, and text or HTML content",
    );
};

const validateEffectId = (effectId: string) => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(effectId))
    throw new ResendEffectInputError(
      "Resend effect IDs must fit the provider tag contract",
    );
  return effectId;
};

export type ResendWebhookHeaders = {
  id: string;
  signature: string;
  timestamp: string;
};

export type VerifyResendEffectWebhookInput = {
  headers: ResendWebhookHeaders;
  payload: string;
  receivedAt?: number;
  tenantId: string;
  webhookSecret: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const normalizeResendEffectWebhook = (input: {
  deliveryId: string;
  event: WebhookEventPayload;
  receivedAt: number;
  tenantId: string;
}): EffectEvidenceRecord => {
  if (
    !input.event.type.startsWith("email.") ||
    input.event.type === "email.received"
  )
    throw new ResendEffectInputError(
      "Resend webhook is not an outbound email effect event",
    );

  const data: unknown = input.event.data;
  if (!record(data) || typeof data.email_id !== "string" || !record(data.tags))
    throw new ResendEffectInputError(
      "Resend webhook is missing outbound email evidence",
    );
  const effectId = data.tags[RESEND_EFFECT_ID_TAG];
  if (typeof effectId !== "string")
    throw new ResendEffectInputError(
      `Resend webhook is missing the ${RESEND_EFFECT_ID_TAG} correlation tag`,
    );

  const occurredAt = Date.parse(input.event.created_at);
  if (!Number.isFinite(occurredAt))
    throw new ResendEffectInputError(
      "Resend webhook has an invalid occurrence timestamp",
    );

  return {
    deliveryId: input.deliveryId,
    effectId: validateEffectId(effectId),
    eventType: input.event.type,
    evidenceReference: `resend:webhook:${input.deliveryId}`,
    occurredAt,
    outcome: "confirmed_succeeded",
    provider: "resend",
    providerResourceId: data.email_id,
    receivedAt: input.receivedAt,
    tenantId: input.tenantId,
    verifier: "resend-sdk@6",
  };
};

/** Verifies the exact raw body with Resend before returning normalized evidence. */
export const verifyResendEffectWebhook = (
  input: VerifyResendEffectWebhookInput,
): EffectEvidenceRecord => {
  // Resend's constructor requires an API-key-shaped value even though its
  // local webhook verifier never performs an API request or reads the key.
  const event = new Resend(
    ["re", "local", "webhook", "verifier"].join("_"),
  ).webhooks.verify({
    headers: input.headers,
    payload: input.payload,
    webhookSecret: input.webhookSecret,
  });
  return normalizeResendEffectWebhook({
    deliveryId: input.headers.id,
    event,
    receivedAt: input.receivedAt ?? Date.now(),
    tenantId: input.tenantId,
  });
};

const effectApiKey = (context: EffectAdapterDriverContext) => {
  const credential = context.credentials.find(
    (candidate) =>
      candidate.adapterAlias === "RESEND_API_KEY" &&
      candidate.destination === RESEND_EFFECT_API_DESTINATION &&
      candidate.mode === "provider-sdk",
  );
  if (!credential)
    throw new ResendEffectInputError("Resend API key binding is unavailable");

  return credential.value;
};

export const createResendEffectAdapterDriver = (
  clientForKey: (value: string) => ResendClientLike,
): EffectAdapterDriver<EmailMessage, DispatchResult> => ({
  adapterId: RESEND_EFFECT_ADAPTER_ID,
  capabilities: {
    compensation: false,
    idempotency: true,
    reconciliation: "webhook-query",
  },
  execute: async (message, context) => {
    if (
      context.effect !== RESEND_EMAIL_EFFECT ||
      context.destination !== RESEND_EFFECT_API_DESTINATION
    )
      throw new ResendEffectInputError(
        "Resend execution context is outside the adapter contract",
      );
    validateEffectMessage(message);

    return createResendAdapter({
      client: clientForKey(effectApiKey(context)),
    }).send({
      ...message,
      idempotencyKey: context.idempotencyKey,
      metadata: {
        ...message.metadata,
        [RESEND_EFFECT_ID_TAG]: validateEffectId(context.effectId),
      },
      tenant: context.tenantId,
    });
  },
  reconciliationReference: (output) =>
    output.id ? { provider: "resend", resourceId: output.id } : undefined,
  version: resendEffectAdapterDescriptor.version,
});

const resendQueryApiKey = (
  credential: Parameters<EffectAdapterQueryDriver["query"]>[1]["credential"],
) => {
  if (
    credential.adapterAlias !== "RESEND_API_KEY" ||
    credential.destination !== RESEND_EFFECT_API_DESTINATION ||
    credential.mode !== "provider-sdk"
  )
    throw new ResendEffectInputError(
      "Resend query API key binding is unavailable",
    );
  return credential.value;
};

const responseError = (error: unknown) =>
  record(error) && typeof error.message === "string"
    ? error.message
    : "Resend email query failed";

export const createResendEffectQueryDriver = (
  clientForKey: (value: string) => ResendQueryClientLike,
): EffectAdapterQueryDriver => ({
  adapterId: RESEND_EFFECT_ADAPTER_ID,
  provider: "resend",
  query: async (effect, context) => {
    const reference = effect.reconciliationReference;
    if (
      !reference ||
      reference.adapterId !== RESEND_EFFECT_ADAPTER_ID ||
      reference.provider !== "resend"
    )
      throw new ResendEffectInputError(
        "Resend query requires its exact retained email reference",
      );
    if (context.signal.aborted)
      throw new ResendEffectInputError("Resend query was aborted");
    const response = await clientForKey(
      resendQueryApiKey(context.credential),
    ).emails.get(reference.resourceId);
    if (context.signal.aborted)
      throw new ResendEffectInputError("Resend query was aborted");
    if (response.error !== undefined && response.error !== null)
      throw new ResendEffectInputError(responseError(response.error));
    const data = response.data;
    if (!data || data.id !== reference.resourceId)
      throw new ResendEffectInputError(
        "Resend query response differs from the retained email reference",
      );
    const effectTag = data.tags?.find(
      ({ name }) => name === RESEND_EFFECT_ID_TAG,
    );
    if (effectTag?.value !== effect.effectId)
      throw new ResendEffectInputError(
        "Resend query response is not bound to the exact effect",
      );
    const occurredAt = Date.parse(data.created_at);
    if (!Number.isFinite(occurredAt) || !data.last_event.trim())
      throw new ResendEffectInputError(
        "Resend query response has invalid lifecycle evidence",
      );

    return {
      deliveryId: `query:${data.id}:${data.last_event}`,
      eventType: `email.${data.last_event}`,
      evidenceReference: `resend:query:${data.id}:${data.last_event}`,
      occurredAt,
      outcome: "confirmed_succeeded",
      providerResourceId: data.id,
      status: "resolved",
      verifier: "resend-sdk@6:get-email",
    };
  },
  version: resendEffectAdapterDescriptor.version,
});
