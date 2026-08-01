import type { MessagingCapabilityReport } from "@absolutejs/dispatch";

export type TelnyxReadinessCheck = {
  detail: string;
  id: string;
  status: "fail" | "pass";
};

export type TelnyxMessagingReadinessReport = MessagingCapabilityReport & {
  checks: TelnyxReadinessCheck[];
};

export type TelnyxReadinessClientLike = {
  messaging: {
    rcs: {
      agents: {
        retrieve: (agentId: string) => Promise<{
          data?: {
            id?: string;
            messaging_profile_id?: string;
            status?: string;
          };
        }>;
      };
    };
  };
  messagingProfiles: {
    retrieve: (profileId: string) => Promise<{
      data?: {
        enabled?: boolean;
        id?: string;
        webhook_api_version?: string;
        webhook_url?: string;
      };
    }>;
  };
};

export const inspectTelnyxMessagingReadiness = async (input: {
  assertions: {
    carrierRegistrationApproved: boolean;
    consentPolicyInstalled: boolean;
    durableInboxInstalled: boolean;
    optOutWorkflowTested: boolean;
    rcsAgentApproved?: boolean;
  };
  client: TelnyxReadinessClientLike;
  messagingProfileId: string;
  rcsAgentId?: string;
  webhookUrl: string;
}): Promise<TelnyxMessagingReadinessReport> => {
  const profile = await input.client.messagingProfiles.retrieve(
    input.messagingProfileId,
  );
  const checks: TelnyxReadinessCheck[] = [
    {
      detail: "Messaging Profile exists and is enabled",
      id: "profile-enabled",
      status:
        profile.data?.id === input.messagingProfileId &&
        profile.data.enabled === true
          ? "pass"
          : "fail",
    },
    {
      detail: "Messaging Profile webhook matches the configured endpoint",
      id: "webhook-bound",
      status: profile.data?.webhook_url === input.webhookUrl ? "pass" : "fail",
    },
    {
      detail: "A durable atomic webhook inbox is installed",
      id: "durable-inbox",
      status: input.assertions.durableInboxInstalled ? "pass" : "fail",
    },
    {
      detail: "Program-level consent policy is installed",
      id: "consent-policy",
      status: input.assertions.consentPolicyInstalled ? "pass" : "fail",
    },
    {
      detail: "STOP/START workflow was tested end to end",
      id: "opt-out-tested",
      status: input.assertions.optOutWorkflowTested ? "pass" : "fail",
    },
    {
      detail: "Required 10DLC or toll-free registration is approved",
      id: "carrier-registration",
      status: input.assertions.carrierRegistrationApproved ? "pass" : "fail",
    },
  ];
  if (input.rcsAgentId !== undefined) {
    const agent = await input.client.messaging.rcs.agents.retrieve(
      input.rcsAgentId,
    );
    checks.push(
      {
        detail: "RCS agent is attached to the configured Messaging Profile",
        id: "rcs-attached",
        status:
          agent.data?.messaging_profile_id === input.messagingProfileId
            ? "pass"
            : "fail",
      },
      {
        detail:
          "Operator asserts that the RCS agent completed Google/carrier approval",
        id: "rcs-approved",
        status: input.assertions.rcsAgentApproved === true ? "pass" : "fail",
      },
    );
  }
  return { checks, ready: checks.every(({ status }) => status === "pass") };
};

export const checkTelnyxMessagingReadiness = async (
  input: Parameters<typeof inspectTelnyxMessagingReadiness>[0],
) => {
  const report = await inspectTelnyxMessagingReadiness(input);
  if (!report.ready) {
    throw new Error(
      `Telnyx messaging is not ready: ${report.checks
        .filter(({ status }) => status !== "pass")
        .map(({ id }) => id)
        .join(", ")}`,
    );
  }
  return report;
};
