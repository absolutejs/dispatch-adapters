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
  id: string;
  message: string;
  source: "assertion" | "twilio-api" | "store";
  status: "fail" | "pass";
};

export type TwilioReadinessReport = {
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
      message: "Lifecycle events use durable, atomic persistence",
      source: "store",
      status: input.store.durability === "durable" ? "pass" : "fail",
    },
    ...asserted.map(([id, message]) => ({
      id,
      message,
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
          list: (input: { limit: number }) => Promise<unknown[]>;
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
      context.channelSenders.list({ limit: 1 }),
    ],
  );
  const apiChecks: TwilioReadinessCheck[] = [
    {
      id: "account-binding",
      message: "Messaging Service belongs to the expected Twilio account",
      source: "twilio-api",
      status: service.accountSid === input.expectedAccountSid ? "pass" : "fail",
    },
    {
      id: "service-binding",
      message: "Inspected the configured Messaging Service",
      source: "twilio-api",
      status: service.sid === input.messagingServiceSid ? "pass" : "fail",
    },
    {
      id: "inbound-webhook",
      message: "Messaging Service uses the signed inbound POST webhook",
      source: "twilio-api",
      status:
        service.inboundMethod === "POST" &&
        service.inboundRequestUrl === input.inboundWebhookUrl
          ? "pass"
          : "fail",
    },
    {
      id: "status-callback",
      message: "Messaging Service delivery callback matches the application",
      source: "twilio-api",
      status:
        service.statusCallback === input.statusCallbackUrl ? "pass" : "fail",
    },
    {
      id: "sender-pool",
      message: "Messaging Service has at least one sender",
      source: "twilio-api",
      status:
        phoneNumbers.length + shortCodes.length + channelSenders.length > 0
          ? "pass"
          : "fail",
    },
    {
      id: "us-a2p-registration",
      message: "Required US A2P registration is attached to the service",
      source: "twilio-api",
      status:
        input.requiresUsA2PRegistration !== true ||
        service.usAppToPersonRegistered
          ? "pass"
          : "fail",
    },
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
  const checks = [
    ...asserted.checks.filter(
      (check) => check.id !== "carrierRegistrationApproved",
    ),
    ...apiChecks,
  ];

  return {
    checks,
    ready: checks.every((check) => check.status === "pass"),
    scope: "operational-not-legal-certification",
  };
};
