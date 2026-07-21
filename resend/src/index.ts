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
} from "@absolutejs/execution";

export const RESEND_EFFECT_ADAPTER_ID = "absolutejs.dispatch-resend";
export const RESEND_EFFECT_API_DESTINATION = "https://api.resend.com";
export const RESEND_EMAIL_EFFECT = "email.send";

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
  reconciliation: { mode: "manual" },
  spendAuthority: {
    canSpend: false,
    currencies: [],
    requiresMandate: false,
  },
  title: "Resend transactional email",
  version: "0.1.2",
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
    reconciliation: "manual",
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
      tenant: context.tenantId,
    });
  },
  version: resendEffectAdapterDescriptor.version,
});
