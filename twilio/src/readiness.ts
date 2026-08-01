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
      status: input.store.durability === "durable" ? "pass" : "fail",
    },
    ...asserted.map(([id, message]) => ({
      id,
      message,
      status: input.assertions[id] ? ("pass" as const) : ("fail" as const),
    })),
  ];
  return {
    checks,
    ready: checks.every((check) => check.status === "pass"),
    scope: "operational-not-legal-certification",
  };
};
