import type { MessagingCapabilityReport } from "@absolutejs/dispatch";
import type { TwilioLifecycleStore } from "./lifecycle";

export type TwilioOperationalAssertions = {
  /** The applicable sender/campaign registration is approved by Twilio. */
  carrierRegistrationApproved: boolean;
  /** The product records the recipient's consent and its source/time. */
  consentEvidenceStored: boolean;
  /** Twilio Advanced Opt-Out is configured and tested for the service. */
  optOutConfigured: boolean;
  /** Public product privacy policy discloses the messaging program. */
  privacyPolicyPublished: boolean;
  /** Public terms include program frequency, HELP, STOP, and fee disclosures. */
  termsPublished: boolean;
};

export type TwilioReadinessCheck = {
  detail: string;
  id: string;
  source: "assertion" | "twilio-api" | "store";
  status: "fail" | "pass";
};

export type TwilioReadinessReport = MessagingCapabilityReport & {
  checks: TwilioReadinessCheck[];
  ready: boolean;
  /** This is an operational check, never a legal certification. */
  scope: "operational-not-legal-certification";
};

export const checkTwilioMessagingReadiness = (input: {
  assertions: TwilioOperationalAssertions;
  store: TwilioLifecycleStore;
}): TwilioReadinessReport => {
  const asserted: Array<[keyof TwilioOperationalAssertions, string]> = [
    ["carrierRegistrationApproved", "Carrier registration is approved"],
    ["consentEvidenceStored", "Consent evidence is durably recorded"],
    ["optOutConfigured", "Advanced Opt-Out is configured and tested"],
    ["privacyPolicyPublished", "Messaging privacy policy is published"],
    ["termsPublished", "Messaging program terms are published"],
  ];
  const checks: TwilioReadinessCheck[] = [
    {
      id: "durable-lifecycle-store",
      detail: "Lifecycle events use durable, atomic persistence",
      source: "store",
      status: input.store.durability === "durable" ? "pass" : "fail",
    },
    ...asserted.map(([id, detail]) => ({
      detail,
      id,
      source: "assertion" as const,
      status: input.assertions[id] ? ("pass" as const) : ("fail" as const),
    })),
  ];
  return {
    checks,
    ready: checks.every((check) => check.status === "pass"),
    scope: "operational-not-legal-certification",
  };
};

export type TwilioMessagingInspectorClientLike = {
  messaging: {
    v1: {
      services: (sid: string) => {
        channelSenders: {
          list: (input: {
            limit: number;
          }) => Promise<Array<{ sender?: string; senderType?: string }>>;
        };
        phoneNumbers: {
          list: (input: { limit: number }) => Promise<unknown[]>;
        };
        shortCodes: { list: (input: { limit: number }) => Promise<unknown[]> };
        fetch: () => Promise<{
          accountSid: string;
          inboundMethod: string;
          inboundRequestUrl: string;
          sid: string;
          statusCallback: string;
          usAppToPersonRegistered: boolean;
        }>;
      };
    };
  };
};

export const inspectTwilioMessagingReadiness = async (input: {
  assertions: Omit<TwilioOperationalAssertions, "carrierRegistrationApproved">;
  client: TwilioMessagingInspectorClientLike;
  expectedAccountSid: string;
  inboundWebhookUrl: string;
  messagingServiceSid: string;
  /** Require an approved RCS sender in the Messaging Service sender pool. */
  requiresRcsSender?: boolean;
  /** Required operator evidence because the sender-pool API does not expose RCS approval state. */
  rcsAssertions?: {
    advancedOptOutMitigationTested: boolean;
    senderApproved: boolean;
  };
  requiresUsA2PRegistration?: boolean;
  statusCallbackUrl: string;
  store: TwilioLifecycleStore;
}): Promise<TwilioReadinessReport> => {
  const context = input.client.messaging.v1.services(input.messagingServiceSid);
  const [service, phoneNumbers, shortCodes, channelSenders] = await Promise.all(
    [
      context.fetch(),
      context.phoneNumbers.list({ limit: 1 }),
      context.shortCodes.list({ limit: 1 }),
      context.channelSenders.list({ limit: 1_000 }),
    ],
  );
  const apiChecks: TwilioReadinessCheck[] = [
    {
      id: "account-binding",
      detail: "Messaging Service belongs to the expected Twilio account",
      source: "twilio-api",
      status: service.accountSid === input.expectedAccountSid ? "pass" : "fail",
    },
    {
      id: "service-binding",
      detail: "Inspected the configured Messaging Service",
      source: "twilio-api",
      status: service.sid === input.messagingServiceSid ? "pass" : "fail",
    },
    {
      id: "inbound-webhook",
      detail: "Messaging Service uses the signed inbound POST webhook",
      source: "twilio-api",
      status:
        service.inboundMethod === "POST" &&
        service.inboundRequestUrl === input.inboundWebhookUrl
          ? "pass"
          : "fail",
    },
    {
      id: "status-callback",
      detail: "Messaging Service delivery callback matches the application",
      source: "twilio-api",
      status:
        service.statusCallback === input.statusCallbackUrl ? "pass" : "fail",
    },
    {
      id: "sender-pool",
      detail: "Messaging Service has at least one sender",
      source: "twilio-api",
      status:
        phoneNumbers.length + shortCodes.length + channelSenders.length > 0
          ? "pass"
          : "fail",
    },
    {
      id: "us-a2p-registration",
      detail: "Required US A2P registration is attached to the service",
      source: "twilio-api",
      status:
        input.requiresUsA2PRegistration !== true ||
        service.usAppToPersonRegistered
          ? "pass"
          : "fail",
    },
    ...(input.requiresRcsSender === true
      ? [
          {
            id: "rcs-sender",
            detail: "Messaging Service has an RCS sender",
            source: "twilio-api" as const,
            status: channelSenders.some(
              ({ sender, senderType }) =>
                sender?.toLowerCase().startsWith("rcs:") === true ||
                senderType?.toLowerCase() === "rcs",
            )
              ? ("pass" as const)
              : ("fail" as const),
          },
          {
            id: "rcs-sender-approved",
            detail: "RCS sender approval was verified in Twilio",
            source: "assertion" as const,
            status:
              input.rcsAssertions?.senderApproved === true
                ? ("pass" as const)
                : ("fail" as const),
          },
          {
            id: "rcs-opt-out-mitigation",
            detail:
              "RCS Advanced Opt-Out behavior and fallback mitigation were tested",
            source: "assertion" as const,
            status:
              input.rcsAssertions?.advancedOptOutMitigationTested === true
                ? ("pass" as const)
                : ("fail" as const),
          },
        ]
      : []),
  ];
  const asserted = checkTwilioMessagingReadiness({
    assertions: {
      ...input.assertions,
      carrierRegistrationApproved:
        input.requiresUsA2PRegistration !== true ||
        service.usAppToPersonRegistered,
    },
    store: input.store,
  });
  const checks: TwilioReadinessCheck[] = [
    ...(asserted.checks.filter(
      (check) => check.id !== "carrierRegistrationApproved",
    ) as TwilioReadinessCheck[]),
    ...apiChecks,
  ];

  return {
    checks,
    ready: checks.every((check) => check.status === "pass"),
    scope: "operational-not-legal-certification",
  };
};
