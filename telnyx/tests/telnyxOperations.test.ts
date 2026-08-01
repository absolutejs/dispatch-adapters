import { describe, expect, test } from "bun:test";
import {
  checkTelnyxMessagingReadiness,
  createTelnyxComplianceManager,
  inspectTelnyxMessagingReadiness,
  type TelnyxComplianceClientLike,
} from "../src";

const PROFILE = "4000eba1-a0c0-4562-b3fc-2c963f66afa6";
const WEBHOOK = "https://app.example.com/webhooks/telnyx/messaging";

describe("Telnyx messaging readiness", () => {
  const client = {
    messaging: {
      rcs: {
        agents: {
          retrieve: async (id: string) => ({
            data: {
              id,
              messaging_profile_id: PROFILE,
              status: "active",
            },
          }),
        },
      },
    },
    messagingProfiles: {
      retrieve: async (id: string) => ({
        data: { enabled: true, id, webhook_url: WEBHOOK },
      }),
    },
  };

  test("requires every operator assertion including actual RCS approval", async () => {
    const report = await inspectTelnyxMessagingReadiness({
      assertions: {
        carrierRegistrationApproved: true,
        consentPolicyInstalled: true,
        durableInboxInstalled: true,
        optOutWorkflowTested: true,
        rcsAgentApproved: false,
      },
      client,
      messagingProfileId: PROFILE,
      rcsAgentId: "agent-1",
      webhookUrl: WEBHOOK,
    });
    expect(report.ready).toBe(false);
    expect(report.checks.find(({ id }) => id === "rcs-approved")?.ok).toBe(
      false,
    );
  });

  test("passes only with live configuration and all assertions", async () => {
    await expect(
      checkTelnyxMessagingReadiness({
        assertions: {
          carrierRegistrationApproved: true,
          consentPolicyInstalled: true,
          durableInboxInstalled: true,
          optOutWorkflowTested: true,
          rcsAgentApproved: true,
        },
        client,
        messagingProfileId: PROFILE,
        rcsAgentId: "agent-1",
        webhookUrl: WEBHOOK,
      }),
    ).resolves.toMatchObject({ ready: true });
  });
});

describe("Telnyx carrier registration manager", () => {
  test("submits complete A2P brand/campaign evidence and inspects both", async () => {
    const calls: unknown[] = [];
    const client = {
      messaging10dlc: {
        brand: {
          create: async (input: unknown) => {
            calls.push(input);
            return { brandId: "brand-1", status: "approved" };
          },
          retrieve: async () => ({ brandId: "brand-1", status: "approved" }),
        },
        campaign: {
          retrieve: async () => ({
            campaignId: "campaign-1",
            status: "active",
          }),
        },
        campaignBuilder: {
          submit: async (input: unknown) => {
            calls.push(input);
            return { campaignId: "campaign-1", status: "pending" };
          },
        },
      },
      messagingTollfree: {
        verification: {
          requests: {
            create: async (input: unknown) => input,
            retrieve: async () => ({ verificationStatus: "verified" }),
            update: async (_id: string, input: unknown) => input,
          },
        },
      },
    } as unknown as TelnyxComplianceClientLike;
    const manager = createTelnyxComplianceManager(client);
    const submitted = await manager.submitA2P({
      brand: {
        country: "US",
        displayName: "Acme",
        email: "ops@example.com",
        entityType: "PRIVATE_PROFIT",
        privacyPolicyUrl: "https://example.com/privacy",
        termsOfServiceUrl: "https://example.com/terms",
        vertical: "TECHNOLOGY",
      },
      campaign: {
        description: "Production incident alerts",
        messageFlow: "Users opt in on the incident alert settings page.",
        privacyPolicyUrl: "https://example.com/privacy",
        sample1: "Acme alert: database latency is high. Reply STOP to opt out.",
        termsOfServiceUrl: "https://example.com/terms",
        usecase: "ACCOUNT_NOTIFICATION",
      },
    });
    expect(submitted).toMatchObject({ brand: { brandId: "brand-1" } });
    expect(calls[1]).toMatchObject({ brandId: "brand-1" });
    await expect(
      manager.inspect({
        brandId: "brand-1",
        campaignId: "campaign-1",
        kind: "a2p",
      }),
    ).resolves.toMatchObject({ ready: true, target: "a2p" });
  });

  test("requires current toll-free business and opt-in evidence", async () => {
    const client = {
      messaging10dlc: {},
      messagingTollfree: {
        verification: {
          requests: {
            create: async (input: unknown) => input,
            retrieve: async () => ({ verificationStatus: "verified" }),
            update: async (_id: string, input: unknown) => input,
          },
        },
      },
    } as unknown as TelnyxComplianceClientLike;
    const manager = createTelnyxComplianceManager(client);
    await expect(
      manager.submitTollFree({
        additionalInformation: "",
        businessAddr1: "1 Main St",
        businessCity: "New York",
        businessContactEmail: "ops@example.com",
        businessContactFirstName: "Alex",
        businessContactLastName: "Kahn",
        businessContactPhone: "+12025550100",
        businessName: "Acme",
        businessRegistrationCountry: "US",
        businessRegistrationNumber: "12-3456789",
        businessRegistrationType: "EIN",
        businessState: "NY",
        businessZip: "10001",
        corporateWebsite: "https://example.com",
        isvReseller: "Yes",
        messageVolume: "10,000",
        optInWorkflow:
          "Users check an unchecked box on the alert settings page.",
        optInWorkflowImageURLs: [{ url: "https://example.com/opt-in.png" }],
        phoneNumbers: [{ phoneNumber: "+18005550100" }],
        privacyPolicyUrl: "https://example.com/privacy",
        productionMessageContent:
          "Acme alert: incident opened. Reply STOP to opt out.",
        termsOfServiceUrl: "https://example.com/terms",
        useCase: "System Alerts",
        useCaseSummary: "Transactional incident alerts for opted-in customers.",
      }),
    ).resolves.toMatchObject({ businessRegistrationNumber: "12-3456789" });
  });
});
