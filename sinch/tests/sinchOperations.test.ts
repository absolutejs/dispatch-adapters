import { describe, expect, test } from "bun:test";
import {
  createSinchCapabilityManager,
  createSinchRegistrationManager,
  inspectSinchMessagingReadiness,
} from "../src";

describe("Sinch operational capabilities", () => {
  test("inspects live app channels and signed webhook triggers", async () => {
    const client = {
      conversation: {
        app: {
          get: async () => ({
            channel_credentials: [
              { channel: "RCS", state: { status: "ACTIVE" } },
              { channel: "SMS", state: { status: "ACTIVE" } },
            ],
            id: "app-1",
          }),
        },
        webhooks: {
          list: async () => ({
            webhooks: [
              {
                secret: "signed-secret",
                target: "https://example.com/webhooks/sinch/account-a",
                target_type: "HTTP",
                triggers: [
                  "CAPABILITY",
                  "MESSAGE_DELIVERY",
                  "MESSAGE_INBOUND",
                  "EVENT_INBOUND",
                  "OPT_IN",
                  "OPT_OUT",
                ],
              },
            ],
          }),
        },
      },
    } as never;
    const report = await inspectSinchMessagingReadiness({
      appId: "app-1",
      assertions: {
        carrierRegistrationApproved: true,
        consentPolicyInstalled: true,
        durableInboxInstalled: true,
        optOutWorkflowTested: true,
        retentionPolicyReviewed: true,
      },
      client,
      requiredTransports: ["rcs", "sms"],
      requireCapabilityCallbacks: true,
      webhookUrl: "https://example.com/webhooks/sinch/account-a",
    });
    expect(report.ready).toBe(true);
  });

  test("requests asynchronous multichannel capability lookup", async () => {
    let request: unknown;
    const manager = createSinchCapabilityManager(
      {
        conversation: {
          capability: {
            lookup: async (input: unknown) => {
              request = input;
              return { app_id: "app-1", request_id: "capability-1" };
            },
          },
        },
      } as never,
      "app-1",
    );
    await expect(
      manager.lookup({ address: "+12025550100", transports: ["rcs", "sms"] }),
    ).resolves.toMatchObject({ requestId: "capability-1" });
    expect(request).toMatchObject({
      lookupCapabilityRequestBody: { app_id: "app-1" },
    });
  });

  test("qualifies, submits, links, and inspects 10DLC resources", async () => {
    const manager = createSinchRegistrationManager(
      {
        brands: {
          inspect: async (_projectId, id) => ({ id, status: "approved" }),
          submit: async (_projectId, input) => ({
            id: input.legalName,
            status: "pending",
          }),
        },
        campaigns: {
          inspect: async (_projectId, id) => ({
            id,
            reasons: ["review complete"],
            status: "approved",
          }),
          qualify: async () => ({ monthlyFee: 10 }),
          submit: async (_projectId, input) => ({
            id: input.campaignName,
            status: "pending",
          }),
        },
        numbers: {
          link: async (_projectId, input) => ({
            id: input.number,
            status: "linking",
          }),
          list: async () => ["+12025550199"],
        },
        tollFreeVerifications: {
          inspect: async (_projectId, id) => ({ id, status: "approved" }),
          submit: async (_projectId, input) => ({
            id: input.businessName,
            status: "pending",
          }),
        },
      },
      "project-1",
    );
    await expect(
      manager.qualifyCampaign("brand-1", "ACCOUNT_NOTIFICATION"),
    ).resolves.toMatchObject({ monthlyFee: 10 });
    await expect(
      manager.registerBrand({
        country: "US",
        email: "ops@example.com",
        entityType: "PRIVATE_PROFIT",
        legalName: "Example Inc",
      }),
    ).resolves.toMatchObject({ id: "Example Inc" });
    await expect(
      manager.registerCampaign({
        brandId: "brand-1",
        campaignName: "Pro alerts",
        description: "Transactional alerts requested by subscribed customers.",
        messageFlow: { type: "TEXT_TO_JOIN" },
        sample1: "Example: your requested alert is ready. Reply STOP to stop.",
        useCase: "ACCOUNT_NOTIFICATION",
      }),
    ).resolves.toMatchObject({ id: "Pro alerts" });
    await expect(
      manager.linkNumber({ campaignId: "campaign-1", number: "+12025550199" }),
    ).resolves.toMatchObject({ id: "+12025550199" });
    await expect(
      manager.registerTollFree({
        businessContactEmail: "ops@example.com",
        businessName: "Example Inc",
        messageVolume: "1000",
        optInDescription:
          "Customers explicitly subscribe on the alert settings page.",
        optInImageUrls: ["https://example.com/evidence/opt-in.png"],
        sampleMessages: [
          "Example: your requested alert is ready. Reply STOP to stop.",
        ],
        useCase: "ACCOUNT_NOTIFICATIONS",
        website: "https://example.com",
      }),
    ).resolves.toMatchObject({ id: "Example Inc" });
    await expect(
      manager.inspect({
        brandRegistrationId: "brand-registration-1",
        campaignId: "campaign-1",
        campaignRegistrationId: "campaign-registration-1",
        projectId: "project-1",
        requireLinkedNumber: true,
        tollFreeRegistrationId: "toll-free-registration-1",
      }),
    ).resolves.toMatchObject({ diagnostics: ["review complete"], ready: true });
  });
});
