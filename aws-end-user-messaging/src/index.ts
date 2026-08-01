import {
  CreateRegistrationCommand,
  DescribeConfigurationSetsCommand,
  DescribePoolsCommand,
  DescribeProtectConfigurationsCommand,
  DescribeRegistrationsCommand,
  PutRegistrationFieldValueCommand,
  SendMediaMessageCommand,
  SendNotifyTextMessageCommand,
  SendRcsMessageCommand,
  SendTextMessageCommand,
  SubmitRegistrationVersionCommand,
  type CreateRegistrationCommandInput,
  type PinpointSMSVoiceV2Client,
  type RcsMessageContent,
  type SendRcsMessageCommandInput,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import {
  SendWhatsAppMessageCommand,
  type SocialMessagingClient,
} from "@aws-sdk/client-socialmessaging";
import type {
  MessagingAdapter,
  MessagingCapabilityReport,
  MessagingContent,
  MessagingDeliveryEvent,
  MessagingDispatchResult,
  MessagingEventHandler,
  MessagingFallbackRoute,
  MessagingMessage,
  MessagingTransport,
} from "@absolutejs/dispatch";
import {
  drainWebhookInbox,
  type WebhookInboxStore,
} from "@absolutejs/reliability";

export {
  createMemoryWebhookInboxStore,
  createPostgresTransactionRunner,
  createPostgresWebhookInboxStore,
  WEBHOOK_INBOX_POSTGRES_SCHEMA,
} from "@absolutejs/reliability";

export type AwsSmsClient = Pick<PinpointSMSVoiceV2Client, "send">;
export type AwsSocialClient = Pick<SocialMessagingClient, "send">;

export type CreateAwsEndUserMessagingAdapterOptions = {
  client: AwsSmsClient;
  configurationSetName?: string;
  context?: Readonly<Record<string, string>>;
  dryRun?: boolean;
  messageFeedbackEnabled?: boolean;
  messageType?: "PROMOTIONAL" | "TRANSACTIONAL";
  notifyConfigurationId?: string;
  originationIdentity?: string;
  protectConfigurationId?: string;
  socialClient?: AwsSocialClient;
  whatsappMetaApiVersion?: string;
  whatsappPhoneNumberId?: string;
};

declare module "@absolutejs/dispatch" {
  interface MessagingTransportRegistry {
    "aws-notify": { family: "carrier" };
  }
}

const extension = <T>(
  message: MessagingMessage,
  key: string,
): T | undefined => {
  const aws = message.extensions?.aws;
  if (typeof aws !== "object" || aws === null || Array.isArray(aws))
    return undefined;
  const value = (aws as Record<string, unknown>)[key];
  return value as T | undefined;
};

const textOf = (content: MessagingContent) => {
  if (content.kind === "text") return content.text;
  if (content.kind === "media") return content.text;
  if (content.kind === "rich") return content.text;
  return undefined;
};

const baseInput = (
  options: CreateAwsEndUserMessagingAdapterOptions,
  message: MessagingMessage,
) => ({
  ...(options.configurationSetName
    ? { ConfigurationSetName: options.configurationSetName }
    : {}),
  Context: {
    ...(options.context ?? {}),
    ...(message.idempotencyKey
      ? { absoluteIdempotencyKey: message.idempotencyKey }
      : {}),
    ...(message.tenant ? { absoluteTenant: message.tenant } : {}),
  },
  ...(options.dryRun === undefined ? {} : { DryRun: options.dryRun }),
  ...(options.messageFeedbackEnabled === undefined
    ? {}
    : { MessageFeedbackEnabled: options.messageFeedbackEnabled }),
  ...(options.protectConfigurationId
    ? { ProtectConfigurationId: options.protectConfigurationId }
    : {}),
});

const result = (
  transport: MessagingTransport,
  output: { MessageId?: unknown; messageId?: unknown },
): MessagingDispatchResult => {
  const id =
    typeof output.MessageId === "string"
      ? output.MessageId
      : typeof output.messageId === "string"
        ? output.messageId
        : undefined;
  return {
    at: Date.now(),
    delivery: {
      actualTransport: transport,
      attempts: [
        {
          actualTransport: transport,
          ...(id ? { providerMessageId: id } : {}),
          route: "primary",
          status: "accepted",
          transport,
        },
      ],
      requestedTransport: transport,
    },
    ...(id ? { id } : {}),
    provider: "aws-end-user-messaging",
  };
};

const fallbackInput = (fallback: MessagingFallbackRoute | undefined) => {
  if (
    !fallback ||
    (fallback.transport !== "sms" && fallback.transport !== "mms")
  )
    return undefined;
  const content = fallback.content;
  return {
    Channel: fallback.transport.toUpperCase() as "MMS" | "SMS",
    ...(content ? { MessageBody: textOf(content) } : {}),
    ...(content?.kind === "media" ? { MediaUrls: [...content.mediaUrls] } : {}),
    ...(fallback.from ? { OriginationIdentity: fallback.from.address } : {}),
  };
};

const textRcsContent = (message: MessagingMessage): RcsMessageContent => ({
  Content: { TextMessage: { Body: textOf(message.content) ?? "" } },
});

const whatsappPayload = (message: MessagingMessage) =>
  extension<Record<string, unknown>>(message, "whatsapp") ?? {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    text: { body: textOf(message.content) ?? "" },
    to: message.to.address,
    type: "text",
  };

export const createAwsEndUserMessagingAdapter = (
  options: CreateAwsEndUserMessagingAdapterOptions,
): MessagingAdapter => ({
  name: "aws-end-user-messaging",
  send: async (message) => {
    const transport = message.to.transport;
    if (transport === "whatsapp") {
      if (!options.socialClient || !options.whatsappPhoneNumberId)
        throw new Error(
          "[dispatch-aws-end-user-messaging] socialClient and whatsappPhoneNumberId are required for WhatsApp",
        );
      const output = await options.socialClient.send(
        new SendWhatsAppMessageCommand({
          message: new TextEncoder().encode(
            JSON.stringify(whatsappPayload(message)),
          ),
          metaApiVersion: options.whatsappMetaApiVersion ?? "v23.0",
          originationPhoneNumberId: options.whatsappPhoneNumberId,
        }),
      );
      return result(transport, output);
    }
    if (
      transport !== "sms" &&
      transport !== "mms" &&
      transport !== "rcs" &&
      transport !== "aws-notify"
    )
      throw new Error(
        `[dispatch-aws-end-user-messaging] unsupported transport ${transport}`,
      );
    const base = baseInput(options, message);
    if (transport === "aws-notify" || message.content.kind === "template") {
      if (!options.notifyConfigurationId)
        throw new Error(
          "[dispatch-aws-end-user-messaging] notifyConfigurationId is required for template content",
        );
      if (message.content.kind !== "template")
        throw new Error(
          "[dispatch-aws-end-user-messaging] AWS Notify requires template content",
        );
      const output = await options.client.send(
        new SendNotifyTextMessageCommand({
          ...base,
          DestinationPhoneNumber: message.to.address,
          NotifyConfigurationId: options.notifyConfigurationId,
          TemplateId: message.content.id,
          TemplateVariables: { ...(message.content.variables ?? {}) },
        }),
      );
      return result(transport, output);
    }
    if (transport === "mms") {
      if (message.content.kind !== "media")
        throw new Error(
          "[dispatch-aws-end-user-messaging] MMS requires media content",
        );
      if (
        message.content.mediaUrls.length !== 1 ||
        !message.content.mediaUrls[0]?.startsWith("s3://")
      )
        throw new Error(
          "[dispatch-aws-end-user-messaging] MMS requires exactly one s3:// media URL",
        );
      if (!options.originationIdentity && !message.from?.address)
        throw new Error(
          "[dispatch-aws-end-user-messaging] originationIdentity is required for MMS",
        );
      const output = await options.client.send(
        new SendMediaMessageCommand({
          ...base,
          DestinationPhoneNumber: message.to.address,
          MediaUrls: [...message.content.mediaUrls],
          ...(message.content.text
            ? { MessageBody: message.content.text }
            : {}),
          OriginationIdentity:
            message.from?.address ?? options.originationIdentity!,
        }),
      );
      return result(transport, output);
    }
    if (transport === "rcs" && message.content.kind === "rich") {
      const raw = extension<Partial<SendRcsMessageCommandInput>>(
        message,
        "rcs",
      );
      const origin = message.from?.address ?? options.originationIdentity;
      if (!origin)
        throw new Error(
          "[dispatch-aws-end-user-messaging] originationIdentity is required for rich RCS",
        );
      const output = await options.client.send(
        new SendRcsMessageCommand({
          ...base,
          ...raw,
          DestinationPhoneNumber: message.to.address,
          FallbackConfiguration:
            raw?.FallbackConfiguration ?? fallbackInput(message.fallbacks?.[0]),
          OriginationIdentity: origin,
          RcsMessageContent: raw?.RcsMessageContent ?? textRcsContent(message),
        }),
      );
      return result(transport, output);
    }
    const body = textOf(message.content);
    if (!body)
      throw new Error(
        "[dispatch-aws-end-user-messaging] text content is required",
      );
    const output = await options.client.send(
      new SendTextMessageCommand({
        ...base,
        DestinationPhoneNumber: message.to.address,
        MessageBody: body,
        ...(options.messageType ? { MessageType: options.messageType } : {}),
        ...((message.from?.address ?? options.originationIdentity)
          ? {
              OriginationIdentity:
                message.from?.address ?? options.originationIdentity,
            }
          : {}),
      }),
    );
    return result(transport, output);
  },
});

export type AwsRegistrationFieldValue =
  | { attachmentId: string }
  | { choices: ReadonlyArray<string> }
  | { text: string };

export const createAwsEndUserMessagingRegistrationManager = (
  client: AwsSmsClient,
) => ({
  create: async (input: CreateRegistrationCommandInput) =>
    client.send(new CreateRegistrationCommand(input)),
  inspect: async (registrationId: string) =>
    client.send(
      new DescribeRegistrationsCommand({ RegistrationIds: [registrationId] }),
    ),
  putFields: async (
    registrationId: string,
    fields: Readonly<Record<string, AwsRegistrationFieldValue>>,
  ) => {
    for (const [path, value] of Object.entries(fields))
      await client.send(
        new PutRegistrationFieldValueCommand({
          FieldPath: path,
          RegistrationId: registrationId,
          ...("text" in value ? { TextValue: value.text } : {}),
          ...("choices" in value ? { SelectChoices: [...value.choices] } : {}),
          ...("attachmentId" in value
            ? { RegistrationAttachmentId: value.attachmentId }
            : {}),
        }),
      );
  },
  submit: async (registrationId: string, awsReview = false) =>
    client.send(
      new SubmitRegistrationVersionCommand({
        AwsReview: awsReview,
        RegistrationId: registrationId,
      }),
    ),
});

export const inspectAwsEndUserMessagingReadiness = async (input: {
  client: AwsSmsClient;
  configurationSetName?: string;
  originationIdentity?: string;
  protectConfigurationId?: string;
}): Promise<MessagingCapabilityReport> => {
  const checks: MessagingCapabilityReport["checks"][number][] = [];
  const check = async (
    id: string,
    detail: string,
    run: () => Promise<unknown>,
  ) => {
    try {
      await run();
      checks.push({ detail, id, status: "pass" });
    } catch (error) {
      checks.push({
        detail: `${detail}: ${error instanceof Error ? error.message : String(error)}`,
        id,
        status: "fail",
      });
    }
  };
  if (input.originationIdentity)
    await check(
      "origination-identity",
      "AWS phone pool or origination identity is accessible",
      () =>
        input.client.send(
          new DescribePoolsCommand({ PoolIds: [input.originationIdentity!] }),
        ),
    );
  else
    checks.push({
      detail: "No origination identity configured",
      id: "origination-identity",
      status: "fail",
    });
  if (input.configurationSetName)
    await check(
      "event-destination",
      "Configuration set is accessible; confirm it has an event destination",
      () =>
        input.client.send(
          new DescribeConfigurationSetsCommand({
            ConfigurationSetNames: [input.configurationSetName!],
          }),
        ),
    );
  else
    checks.push({
      detail: "Configure a configuration set with an event destination",
      id: "event-destination",
      status: "fail",
    });
  if (input.protectConfigurationId)
    await check("fraud-protection", "Protect configuration is accessible", () =>
      input.client.send(
        new DescribeProtectConfigurationsCommand({
          ProtectConfigurationIds: [input.protectConfigurationId!],
        }),
      ),
    );
  else
    checks.push({
      detail: "Configure AWS Protect for AIT and destination controls",
      id: "fraud-protection",
      status: "fail",
    });
  return { checks, ready: checks.every((item) => item.status === "pass") };
};

const deliveryStatus = (value: string): MessagingDeliveryEvent["status"] => {
  const normalized = value.toLowerCase();
  if (normalized.includes("deliver")) return "delivered";
  if (normalized.includes("fail") || normalized.includes("reject"))
    return "failed";
  if (normalized.includes("send")) return "sent";
  return "unknown";
};

const parseAwsEndUserMessagingEvent = (
  body: string,
): MessagingDeliveryEvent => {
  const payload = JSON.parse(body) as Record<string, unknown>;
  const detail =
    typeof payload.detail === "object" && payload.detail !== null
      ? (payload.detail as Record<string, unknown>)
      : payload;
  const messageId = String(detail.messageId ?? detail.message_id ?? "");
  const providerStatus = String(
    detail.eventType ?? detail.event_type ?? detail.status ?? "unknown",
  );
  if (!messageId)
    throw new Error("[dispatch-aws-end-user-messaging] missing message id");
  return {
    errors: detail.failureReason
      ? [{ detail: String(detail.failureReason) }]
      : [],
    eventId: String(payload.id ?? `${messageId}:${providerStatus}`),
    kind: "delivery",
    messageId,
    occurredAt: Date.parse(
      String(payload.time ?? detail.timestamp ?? new Date().toISOString()),
    ),
    provider: "aws-end-user-messaging",
    providerStatus,
    status: deliveryStatus(providerStatus),
  };
};

export const createAwsEndUserMessagingEventHandler =
  (options: {
    inbox: WebhookInboxStore<string>;
    verify: (headers: Headers, body: string) => Promise<boolean> | boolean;
  }) =>
  async (request: Request): Promise<Response> => {
    const body = await request.text();
    if (!(await options.verify(request.headers, body)))
      return new Response("unauthorized", { status: 401 });
    let event: MessagingDeliveryEvent;
    try {
      event = parseAwsEndUserMessagingEvent(body);
    } catch {
      return new Response("invalid event", { status: 400 });
    }
    const now = Date.now();
    const claim = await options.inbox.accept(
      {
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: body,
        provider: "aws-end-user-messaging",
        streamId: String(request.headers.get("x-aws-event-source") ?? "events"),
      },
      { leaseMs: 1, now },
    );
    if (claim.token) await options.inbox.release(event.eventId, claim.token);
    return new Response(null, { status: 202 });
  };

export const drainAwsEndUserMessagingEventInbox = (options: {
  inbox: WebhookInboxStore<string>;
  limit?: number;
  onEvent: MessagingEventHandler;
}) =>
  drainWebhookInbox({
    handler: ({ payload }) =>
      options.onEvent(parseAwsEndUserMessagingEvent(payload)),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    store: options.inbox,
  });
