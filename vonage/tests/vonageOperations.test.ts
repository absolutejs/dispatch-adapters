import { describe, expect, test } from "bun:test";
import {
  createVonageMessageController,
  createVonageRcsCapabilityManager,
  createVonageRegistrationManager,
  inspectVonageMessagingReadiness,
  type VonageReadinessClientLike,
} from "../src";

const APP_ID = "00000000-0000-4000-8000-000000000001";
const WEBHOOK = "https://app.example.com/webhooks/vonage/messages";

describe("Vonage operational capabilities", () => {
  test("inspects the official application messaging configuration", async () => {
    const client = {
      applications: {
        getApplication: async () => ({
          capabilities: {
            messages: {
              authenticateInboundMedia: true,
              version: "v1",
              webhooks: {
                inboundUrl: { address: WEBHOOK, httpMethod: "POST" },
                statusUrl: { address: WEBHOOK, httpMethod: "POST" },
              },
            },
          },
          id: APP_ID,
        }),
      },
    } as unknown as VonageReadinessClientLike;
    const report = await inspectVonageMessagingReadiness({
      applicationId: APP_ID,
      assertions: {
        carrierRegistrationApproved: true,
        consentPolicyInstalled: true,
        durableInboxInstalled: true,
        optOutWorkflowTested: true,
        signedWebhooksEnabled: true,
      },
      client,
      inboundWebhookUrl: WEBHOOK,
      statusWebhookUrl: WEBHOOK,
    });
    expect(report.ready).toBe(true);
    expect(report.checks.every(({ status }) => status === "pass")).toBe(true);
  });

  test("reports 10DLC diagnostics and number linkage", async () => {
    const manager = createVonageRegistrationManager({
      brands: {
        create: async (input) => ({
          id: String(input.account_id),
          status: "pending",
        }),
        retrieve: async (id) => ({ id, status: "approved" }),
      },
      campaigns: {
        create: async (brandId) => ({ id: brandId, status: "pending" }),
        retrieve: async (id) => ({
          id,
          reasons: ["carrier review complete"],
          status: "active",
        }),
      },
      numbers: {
        linkToCampaign: async (_brandId, _campaignId, input) => ({
          id: input.number,
          status: "linking",
        }),
        listForCampaign: async () => ["12025550199"],
      },
    });
    await expect(
      manager.inspect({
        brandId: "brand-1",
        campaignId: "campaign-1",
        requireLinkedNumber: true,
      }),
    ).resolves.toMatchObject({
      diagnostics: ["carrier review complete"],
      ready: true,
    });

    await expect(
      manager.registerBrand({
        account_id: "account-1",
        country: "US",
        email: "ops@example.com",
        entity_type: "PRIVATE_PROFIT",
        vertical: "TECHNOLOGY",
      }),
    ).resolves.toMatchObject({ id: "account-1" });
    await expect(
      manager.registerCampaign("brand-1", {
        account_id: "account-1",
        description: "Transactional alerts requested by subscribed customers.",
        message_flow_details: { brand_name: "Example" },
        sample_one: "Your requested account alert is ready.",
        usecase: "ACCOUNT_NOTIFICATION",
      }),
    ).resolves.toMatchObject({ id: "brand-1" });
    await expect(
      manager.linkNumber("brand-1", "campaign-1", {
        country: "US",
        number: "+12025550199",
      }),
    ).resolves.toMatchObject({ id: "12025550199" });
  });

  test("checks RCS reachability and controls supported message states", async () => {
    const updates: unknown[][] = [];
    const controller = createVonageMessageController({
      messages: {
        updateMessage: async (...args: unknown[]) => {
          updates.push(args);
          return true;
        },
      },
    } as never);
    await controller.revokeRcsMessage("message-1");
    await controller.markWhatsAppRead("message-2");
    expect(updates).toEqual([
      ["message-1", "revoked", undefined],
      ["message-2", "read", undefined],
    ]);

    const capabilities = createVonageRcsCapabilityManager({
      getDeviceCapabilities: async (_agentId, number) =>
        number === "12025550199" ? { features: ["RICHCARD"] } : undefined,
    });
    await expect(
      capabilities.inspect("agent-1", "+12025550199"),
    ).resolves.toEqual({ features: ["RICHCARD"], reachable: true });
    await expect(
      capabilities.inspect("agent-1", "+12025550200"),
    ).resolves.toEqual({ features: [], reachable: false });
  });
});
