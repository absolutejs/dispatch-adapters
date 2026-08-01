export type TelnyxReadinessCheck = {
  detail: string;
  id: string;
  ok: boolean;
};

export type TelnyxMessagingReadinessReport = {
  checks: TelnyxReadinessCheck[];
  ready: boolean;
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
      ok:
        profile.data?.id === input.messagingProfileId &&
        profile.data.enabled === true,
    },
    {
      detail: "Messaging Profile webhook matches the configured endpoint",
      id: "webhook-bound",
      ok: profile.data?.webhook_url === input.webhookUrl,
    },
    {
      detail: "A durable atomic webhook inbox is installed",
      id: "durable-inbox",
      ok: input.assertions.durableInboxInstalled,
    },
    {
      detail: "Program-level consent policy is installed",
      id: "consent-policy",
      ok: input.assertions.consentPolicyInstalled,
    },
    {
      detail: "STOP/START workflow was tested end to end",
      id: "opt-out-tested",
      ok: input.assertions.optOutWorkflowTested,
    },
    {
      detail: "Required 10DLC or toll-free registration is approved",
      id: "carrier-registration",
      ok: input.assertions.carrierRegistrationApproved,
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
        ok: agent.data?.messaging_profile_id === input.messagingProfileId,
      },
      {
        detail:
          "Operator asserts that the RCS agent completed Google/carrier approval",
        id: "rcs-approved",
        ok: input.assertions.rcsAgentApproved === true,
      },
    );
  }
  return { checks, ready: checks.every(({ ok }) => ok) };
};

export const checkTelnyxMessagingReadiness = async (
  input: Parameters<typeof inspectTelnyxMessagingReadiness>[0],
) => {
  const report = await inspectTelnyxMessagingReadiness(input);
  if (!report.ready) {
    throw new Error(
      `Telnyx messaging is not ready: ${report.checks
        .filter(({ ok }) => !ok)
        .map(({ id }) => id)
        .join(", ")}`,
    );
  }
  return report;
};
