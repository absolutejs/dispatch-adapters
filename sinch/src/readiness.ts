import type { SinchClient } from "@sinch/sdk-core";
import type { MessagingCapabilityReport } from "@absolutejs/dispatch";
import type { SinchTransport } from "./adapter";

export type SinchReadinessClientLike = {
  conversation: {
    app: Pick<SinchClient["conversation"]["app"], "get">;
    webhooks: Pick<SinchClient["conversation"]["webhooks"], "list">;
  };
};

export type SinchReadinessCheck = {
  detail: string;
  id: string;
  status: "fail" | "pass";
};

export type SinchMessagingReadinessReport = MessagingCapabilityReport & {
  checks: SinchReadinessCheck[];
};

const channelOf = (transport: SinchTransport) =>
  transport === "kakao"
    ? "KAKAOTALK"
    : transport === "viber"
      ? "VIBERBM"
      : transport === "messenger"
        ? "MESSENGER"
        : transport.toUpperCase();

export const inspectSinchMessagingReadiness = async (input: {
  appId: string;
  assertions: {
    carrierRegistrationApproved: boolean;
    consentPolicyInstalled: boolean;
    durableInboxInstalled: boolean;
    optOutWorkflowTested: boolean;
    retentionPolicyReviewed: boolean;
  };
  client: SinchReadinessClientLike;
  requiredTransports: ReadonlyArray<SinchTransport>;
  requireCapabilityCallbacks?: boolean;
  webhookUrl: string;
}): Promise<SinchMessagingReadinessReport> => {
  const [app, webhookResponse] = await Promise.all([
    input.client.conversation.app.get({ app_id: input.appId }),
    input.client.conversation.webhooks.list({ app_id: input.appId }),
  ]);
  const credentials = app.channel_credentials ?? [];
  const activeChannels = new Set(
    credentials
      .filter(({ state }) => state?.status === "ACTIVE")
      .map(({ channel }) => channel),
  );
  const webhook = (webhookResponse.webhooks ?? []).find(
    ({ target, target_type }) =>
      target === input.webhookUrl &&
      (target_type === undefined || target_type === "HTTP"),
  );
  const triggers = new Set(webhook?.triggers ?? []);
  const checks: SinchReadinessCheck[] = [
    {
      detail: "Application identity matches the configured Conversation app",
      id: "application-binding",
      status: app.id === input.appId ? "pass" : "fail",
    },
    {
      detail:
        "Capability callback trigger is enabled when capability lookup is required",
      id: "capability-callback",
      status:
        input.requireCapabilityCallbacks !== true ||
        triggers.has("CAPABILITY" as never)
          ? "pass"
          : "fail",
    },
    {
      detail: "Every required Conversation channel credential is active",
      id: "channel-credentials",
      status: input.requiredTransports.every((transport) =>
        activeChannels.has(channelOf(transport) as never),
      )
        ? "pass"
        : "fail",
    },
    {
      detail: "The configured HTTP webhook is registered",
      id: "webhook-binding",
      status: webhook === undefined ? "fail" : "pass",
    },
    {
      detail:
        "Delivery, inbound, channel event, opt-in, and opt-out triggers are enabled",
      id: "webhook-triggers",
      status: [
        "MESSAGE_DELIVERY",
        "MESSAGE_INBOUND",
        "EVENT_INBOUND",
        "OPT_IN",
        "OPT_OUT",
      ].every((trigger) => triggers.has(trigger as never))
        ? "pass"
        : "fail",
    },
    {
      detail: "Webhook HMAC signing secret is configured",
      id: "signed-webhooks",
      status:
        typeof webhook?.secret === "string" && webhook.secret.length >= 8
          ? "pass"
          : "fail",
    },
    {
      detail: "A durable atomic webhook inbox is installed",
      id: "durable-inbox",
      status: input.assertions.durableInboxInstalled ? "pass" : "fail",
    },
    {
      detail: "Program-level consent enforcement is installed",
      id: "consent-policy",
      status: input.assertions.consentPolicyInstalled ? "pass" : "fail",
    },
    {
      detail: "STOP/START and provider opt-out behavior was tested end to end",
      id: "opt-out-tested",
      status: input.assertions.optOutWorkflowTested ? "pass" : "fail",
    },
    {
      detail: "Conversation and dispatch retention policy was reviewed",
      id: "retention-policy",
      status: input.assertions.retentionPolicyReviewed ? "pass" : "fail",
    },
    {
      detail: "Required carrier registration is approved",
      id: "carrier-registration",
      status: input.assertions.carrierRegistrationApproved ? "pass" : "fail",
    },
  ];
  return { checks, ready: checks.every(({ status }) => status === "pass") };
};

export const checkSinchMessagingReadiness = async (
  input: Parameters<typeof inspectSinchMessagingReadiness>[0],
) => {
  const report = await inspectSinchMessagingReadiness(input);
  if (!report.ready) {
    throw new Error(
      `Sinch messaging is not ready: ${report.checks
        .filter(({ status }) => status !== "pass")
        .map(({ id }) => id)
        .join(", ")}`,
    );
  }
  return report;
};

export type SinchCapabilityClientLike = {
  conversation: {
    capability: Pick<SinchClient["conversation"]["capability"], "lookup">;
  };
};

export type SinchCapabilityLookup = {
  appId?: string;
  recipient?: unknown;
  requestId?: string;
};

export const createSinchCapabilityManager = (
  client: SinchCapabilityClientLike,
  appId: string,
) => ({
  lookup: async (input: {
    address: string;
    transports: ReadonlyArray<SinchTransport>;
  }): Promise<SinchCapabilityLookup> => {
    if (input.address.trim().length === 0)
      throw new Error("address is required");
    const result = await client.conversation.capability.lookup({
      lookupCapabilityRequestBody: {
        app_id: appId,
        recipient: {
          identified_by: {
            channel_identities: input.transports.map((transport) => ({
              channel: channelOf(transport) as never,
              identity: input.address,
              ...(["instagram", "line", "messenger", "wechat"].includes(
                transport,
              )
                ? { app_id: appId }
                : {}),
            })),
          },
        },
      },
    });
    return {
      ...(result.app_id === undefined ? {} : { appId: result.app_id }),
      ...(result.recipient === undefined
        ? {}
        : { recipient: result.recipient }),
      ...(result.request_id === undefined
        ? {}
        : { requestId: result.request_id }),
    };
  },
});
