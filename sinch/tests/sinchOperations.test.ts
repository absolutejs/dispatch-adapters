import { describe, expect, test } from "bun:test";
import {
  createSinchCapabilityManager,
  createSinchRegistrationClient,
  createSinchRegistrationManager,
  inspectSinchMessagingReadiness,
} from "../src";

const brandInput = {
  brandRegistrationType: "FULL" as const,
  companyDetails: {
    brandName: "Example",
    businessContactEmail: "ops@example.com",
    city: "New York",
    companyEmail: "support@example.com",
    companyName: "Example Inc",
    country: "US",
    postalCode: "10001",
    state: "NY",
    streetAddress: "100 Example Avenue",
    webAddress: "https://example.com",
  },
  contactDetails: {
    email: "ops@example.com",
    firstName: "Alex",
    lastName: "Example",
    phoneNumber: "+12025550199",
  },
  displayName: "Example Inc",
  financialDetails: {
    brandEntityType: "PRIVATE" as const,
    brandVerticalType: "TECHNOLOGY",
    taxIdCorporate: "12-3456789",
    taxIdCountry: "US",
  },
};

const campaignInput = {
  ageGated: false,
  autoRenewal: true,
  brandId: "brand-1",
  campaignName: "Pro alerts",
  description: "Transactional alerts requested by subscribed customers.",
  directLending: false,
  embeddedLink: false,
  embeddedPhone: false,
  helpKeywords: "HELP,INFO",
  helpMessage:
    "Example: email support@example.com for help. Reply STOP to stop.",
  messageFlow:
    "Customers opt in through the alert settings form and receive recurring-message, HELP, STOP, and message-rate disclosures.",
  numberPool: false,
  optInMessage:
    "Example alerts enabled. Msg frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to stop.",
  optinKeywords: "JOIN,SUBSCRIBE",
  optoutKeywords: "STOP,QUIT,END,CANCEL,UNSUBSCRIBE",
  sample1: "Example: your requested alert is ready. Reply STOP to stop.",
  sample2: "Example: production latency is elevated. Reply STOP to stop.",
  sample3: "Example: production latency has recovered. Reply STOP to stop.",
  stopMessage: "Example: you are unsubscribed and will receive no more alerts.",
  subscriberHelp: true,
  subscriberOptIn: true,
  subscriberOptOut: true,
  useCase: "ACCOUNT_NOTIFICATION",
};

const tollFreeInput = {
  businessAddress1: "100 Example Avenue",
  businessCity: "New York",
  businessContactEmail: "ops@example.com",
  businessContactFirstName: "Alex",
  businessContactLastName: "Example",
  businessContactPhone: "+12025550199",
  businessName: "Example Inc",
  businessRegistrationCountry: "US",
  businessRegistrationNumber: "12-3456789",
  businessRegistrationType: "EIN",
  businessState: "NY",
  businessType: "PRIVATE_PROFIT" as const,
  businessZipCode: "10001",
  corporateWebsite: "https://example.com",
  messageVolume: "1000",
  optInWorkflowDescription:
    "Customers explicitly subscribe on the authenticated alert settings page.",
  optInWorkflowImageUrls: ["https://example.com/evidence/opt-in.png"],
  phoneNumber: "+18005550199",
  productionMessageContent:
    "Example: your requested alert is ready. Reply STOP to stop.",
  useCase: "ACCOUNT_NOTIFICATIONS",
  useCaseSummary: "Transactional production alerts requested by customers.",
};

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
            id: input.companyDetails.companyName,
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
    await expect(manager.registerBrand(brandInput)).resolves.toMatchObject({
      id: "Example Inc",
    });
    await expect(
      manager.registerCampaign(campaignInput),
    ).resolves.toMatchObject({ id: "Pro alerts" });
    await expect(
      manager.linkNumber({ campaignId: "campaign-1", number: "+12025550199" }),
    ).resolves.toMatchObject({ id: "+12025550199" });
    await expect(
      manager.registerTollFree(tollFreeInput),
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

  test("runs registration and number linking through authenticated Sinch APIs", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const client = createSinchRegistrationClient({
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          ...(typeof init?.body === "string" && init.body.startsWith("{")
            ? { body: JSON.parse(init.body) }
            : {}),
          method,
          url,
        });
        if (url.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "token-1", expires_in: 3600 });
        }
        if (url.includes("brandRegistrations:submit")) {
          return Response.json({ brandRegistrationId: "brand-registration-1" });
        }
        if (url.includes("campaignRegistrations:qualify")) {
          return Response.json({
            monthlyFee: 10,
            useCase: "ACCOUNT_NOTIFICATION",
          });
        }
        if (url.includes("campaignRegistrations:submit")) {
          return Response.json({
            campaignRegistrationId: "campaign-registration-1",
          });
        }
        if (url.includes("/activeNumbers/%2B12025550199")) {
          if (method === "PATCH") {
            return Response.json({
              phoneNumber: "+12025550199",
              smsConfiguration: {
                campaignId: "campaign-1",
                servicePlanId: "service-plan-1",
              },
            });
          }
          return Response.json({
            phoneNumber: "+12025550199",
            smsConfiguration: { servicePlanId: "service-plan-1" },
          });
        }
        if (url.includes("/tfnVerification")) {
          return Response.json({
            status: "IN_PROGRESS",
            tfnVerificationId: "tfn-1",
          });
        }
        return Response.json({}, { status: 404 });
      },
      keyId: "key-id",
      keySecret: "key-secret",
    });
    await expect(
      client.brands.submit("project-1", brandInput),
    ).resolves.toMatchObject({ id: "brand-registration-1" });
    await expect(
      client.campaigns.qualify("project-1", "brand-1", "ACCOUNT_NOTIFICATION"),
    ).resolves.toMatchObject({ monthlyFee: 10 });
    await expect(
      client.campaigns.submit("project-1", campaignInput),
    ).resolves.toMatchObject({ id: "campaign-registration-1" });
    await expect(
      client.numbers.link("project-1", {
        campaignId: "campaign-1",
        number: "+12025550199",
      }),
    ).resolves.toMatchObject({ id: "+12025550199" });
    await expect(
      client.tollFreeVerifications.submit("project-1", tollFreeInput),
    ).resolves.toMatchObject({ id: "tfn-1", status: "IN_PROGRESS" });
    expect(
      requests.find((request) => request.method === "PATCH")?.body,
    ).toEqual({
      smsConfiguration: {
        campaignId: "campaign-1",
        servicePlanId: "service-plan-1",
      },
    });
    expect(
      requests.filter(({ url }) => url.endsWith("/oauth2/token")),
    ).toHaveLength(1);
  });
});
