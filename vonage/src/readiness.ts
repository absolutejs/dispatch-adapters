import type { Vonage } from "@vonage/server-sdk";
import type { MessagingCapabilityReport } from "@absolutejs/dispatch";

export type VonageReadinessClientLike = {
  applications: Pick<Vonage["applications"], "getApplication">;
};

export type VonageReadinessCheck = {
  detail: string;
  id: string;
  status: "fail" | "pass";
};

export type VonageMessagingReadinessReport = MessagingCapabilityReport & {
  checks: VonageReadinessCheck[];
};

export const inspectVonageMessagingReadiness = async (input: {
  applicationId: string;
  assertions: {
    carrierRegistrationApproved: boolean;
    consentPolicyInstalled: boolean;
    durableInboxInstalled: boolean;
    optOutWorkflowTested: boolean;
    signedWebhooksEnabled: boolean;
  };
  client: VonageReadinessClientLike;
  inboundWebhookUrl: string;
  statusWebhookUrl: string;
}): Promise<VonageMessagingReadinessReport> => {
  const application = await input.client.applications.getApplication(
    input.applicationId,
  );
  const messages = application.capabilities.messages;
  const checks: VonageReadinessCheck[] = [
    {
      detail: "Application identity matches the configured Vonage application",
      id: "application-binding",
      status: application.id === input.applicationId ? "pass" : "fail",
    },
    {
      detail: "Messages capability uses the current v1 webhook contract",
      id: "messages-v1",
      status: messages?.version === "v1" ? "pass" : "fail",
    },
    {
      detail: "Inbound messages use the configured POST webhook",
      id: "inbound-webhook",
      status:
        messages?.webhooks.inboundUrl.address === input.inboundWebhookUrl &&
        messages.webhooks.inboundUrl.httpMethod === "POST"
          ? "pass"
          : "fail",
    },
    {
      detail: "Delivery events use the configured POST webhook",
      id: "status-webhook",
      status:
        messages?.webhooks.statusUrl.address === input.statusWebhookUrl &&
        messages.webhooks.statusUrl.httpMethod === "POST"
          ? "pass"
          : "fail",
    },
    {
      detail: "Signed webhook validation is enabled and configured",
      id: "signed-webhooks",
      status: input.assertions.signedWebhooksEnabled ? "pass" : "fail",
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
      detail: "STOP/START behavior was tested end to end",
      id: "opt-out-tested",
      status: input.assertions.optOutWorkflowTested ? "pass" : "fail",
    },
    {
      detail: "Required carrier registration is approved",
      id: "carrier-registration",
      status: input.assertions.carrierRegistrationApproved ? "pass" : "fail",
    },
  ];
  return { checks, ready: checks.every(({ status }) => status === "pass") };
};

export const checkVonageMessagingReadiness = async (
  input: Parameters<typeof inspectVonageMessagingReadiness>[0],
) => {
  const report = await inspectVonageMessagingReadiness(input);
  if (!report.ready) {
    throw new Error(
      `Vonage messaging is not ready: ${report.checks
        .filter(({ status }) => status !== "pass")
        .map(({ id }) => id)
        .join(", ")}`,
    );
  }
  return report;
};
