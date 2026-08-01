import { describe, expect, test } from "bun:test";
import {
  checkTwilioMessagingReadiness,
  classifyTwilioStatusTransition,
  createMemoryTwilioLifecycleStore,
  inspectTwilioMessagingReadiness,
  type TwilioLifecycleStore,
} from "../src";

describe("lifecycle transitions", () => {
  test("accepts forward progress and rejects terminal regressions", () => {
    expect(classifyTwilioStatusTransition(undefined, "queued")).toBe(
      "accepted",
    );
    expect(classifyTwilioStatusTransition("queued", "sent")).toBe("accepted");
    expect(classifyTwilioStatusTransition("delivered", "sent")).toBe("stale");
    expect(classifyTwilioStatusTransition("delivered", "read")).toBe(
      "accepted",
    );
  });
});

describe("readiness", () => {
  const assertions = {
    carrierRegistrationApproved: true,
    consentEvidenceStored: true,
    optOutConfigured: true,
    privacyPolicyPublished: true,
    termsPublished: true,
  };

  test("never treats an in-memory lifecycle store as production ready", () => {
    const report = checkTwilioMessagingReadiness({
      assertions,
      store: createMemoryTwilioLifecycleStore(),
    });
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toMatchObject({
      id: "durable-lifecycle-store",
      status: "fail",
    });
    expect(report.scope).toBe("operational-not-legal-certification");
  });

  test("passes only with durable storage and every operator assertion", () => {
    const store: TwilioLifecycleStore = {
      begin: async () => ({ claimToken: "claim", disposition: "accepted" }),
      complete: async () => {},
      durability: "durable",
      release: async () => {},
    };
    expect(checkTwilioMessagingReadiness({ assertions, store }).ready).toBe(
      true,
    );
    expect(
      checkTwilioMessagingReadiness({
        assertions: { ...assertions, consentEvidenceStored: false },
        store,
      }).ready,
    ).toBe(false);
  });

  test("inspects the live Messaging Service configuration", async () => {
    const store: TwilioLifecycleStore = {
      begin: async () => ({ claimToken: "claim", disposition: "accepted" }),
      complete: async () => {},
      durability: "durable",
      release: async () => {},
    };
    const accountSid = `AC${"1".repeat(32)}`;
    const messagingServiceSid = `MG${"2".repeat(32)}`;
    const inboundWebhookUrl = "https://app.example.com/twilio/inbound";
    const statusCallbackUrl = "https://app.example.com/twilio/status";
    const report = await inspectTwilioMessagingReadiness({
      assertions: {
        consentEvidenceStored: true,
        optOutConfigured: true,
        privacyPolicyPublished: true,
        termsPublished: true,
      },
      client: {
        messaging: {
          v1: {
            services: () => ({
              channelSenders: { list: async () => [] },
              fetch: async () => ({
                accountSid,
                inboundMethod: "POST",
                inboundRequestUrl: inboundWebhookUrl,
                sid: messagingServiceSid,
                statusCallback: statusCallbackUrl,
                usAppToPersonRegistered: true,
              }),
              phoneNumbers: { list: async () => [{}] },
              shortCodes: { list: async () => [] },
            }),
          },
        },
      },
      expectedAccountSid: accountSid,
      inboundWebhookUrl,
      messagingServiceSid,
      requiresUsA2PRegistration: true,
      statusCallbackUrl,
      store,
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toContainEqual({
      id: "sender-pool",
      message: "Messaging Service has at least one sender",
      source: "twilio-api",
      status: "pass",
    });
  });
});
