import { describe, expect, test } from "bun:test";
import { Twilio } from "twilio";
import {
  createTwilioComplianceManager,
  type TwilioComplianceClientLike,
  type TwilioComplianceResource,
} from "../src";

const sid = (prefix: string, digit: string) => `${prefix}${digit.repeat(32)}`;

const collection = <T>(
  fetched: TwilioComplianceResource,
  created: TwilioComplianceResource,
) => {
  const calls: T[] = [];
  const value = Object.assign(() => ({ fetch: async () => fetched }), {
    create: async (input: T) => {
      calls.push(input);
      return created;
    },
  });
  return { calls, value };
};

const makeClient = () => {
  const brands = collection(
    { sid: sid("BN", "1"), status: "APPROVED" },
    { sid: sid("BN", "1"), status: "PENDING" },
  );
  const campaigns = collection(
    { campaignStatus: "VERIFIED", sid: sid("QE", "2") },
    { campaignStatus: "PENDING", sid: sid("QE", "2") },
  );
  const tollfree = collection(
    {
      editAllowed: true,
      editExpiration: "2026-08-31T00:00:00.000Z",
      rejectionReason: "OPT_IN",
      sid: sid("HH", "3"),
      status: "TWILIO_REJECTED",
    },
    { sid: sid("HH", "3"), status: "PENDING_REVIEW" },
  );
  const client: TwilioComplianceClientLike = {
    messaging: {
      v1: {
        brandRegistrations: brands.value,
        services: () => ({ usAppToPerson: campaigns.value }),
        tollfreeVerifications: tollfree.value,
      },
    },
    trusthub: {
      v1: {
        complianceTollfreeInquiries: {
          create: async () => ({
            inquiryId: "inq_test",
            inquirySessionToken: "ephemeral.secret",
            registrationId: "tri1.test",
            url: "https://trusthub.twilio.com/inquiry",
          }),
        },
        customerProfiles: () => ({
          fetch: async () => ({
            sid: sid("BU", "4"),
            status: "twilio-approved",
          }),
        }),
      },
    },
  };
  return { brands, campaigns, client, tollfree };
};

describe("Twilio compliance manager", () => {
  test("accepts the real Twilio SDK client contract", () => {
    const accept = (_client: TwilioComplianceClientLike) => true;
    expect(accept(new Twilio(sid("AC", "0"), "test-token"))).toBe(true);
  });

  test("submits validated A2P brand and campaign registrations", async () => {
    const mock = makeClient();
    const manager = createTwilioComplianceManager(mock.client);
    await manager.registerA2PBrand({
      a2PProfileBundleSid: sid("BU", "5"),
      brandType: "STANDARD",
      customerProfileBundleSid: sid("BU", "4"),
    });
    await manager.registerA2PCampaign(sid("MG", "6"), {
      brandRegistrationSid: sid("BN", "1"),
      description:
        "Operational incident alerts for subscribed Pro-tier account owners.",
      hasEmbeddedLinks: false,
      hasEmbeddedPhone: false,
      messageFlow:
        "Customers explicitly enable alerts in account settings and can text STOP.",
      messageSamples: [
        "Acme alert: service health has degraded. Reply STOP to opt out.",
        "Acme alert: service health has recovered. Reply STOP to opt out.",
      ],
      privacyPolicyUrl: "https://acme.example/privacy",
      subscriberOptIn: true,
      termsAndConditionsUrl: "https://acme.example/terms",
      usAppToPersonUsecase: "ACCOUNT_NOTIFICATION",
    });
    expect(mock.brands.calls).toHaveLength(1);
    expect(mock.campaigns.calls).toHaveLength(1);
  });

  test("reports approved, pending, and failed provider states without certifying legality", async () => {
    const manager = createTwilioComplianceManager(makeClient().client);
    const report = await manager.inspect({
      brandRegistrationSid: sid("BN", "1"),
      campaignSid: sid("QE", "2"),
      customerProfileSid: sid("BU", "4"),
      kind: "a2p",
      messagingServiceSid: sid("MG", "6"),
    });
    expect(report.scope).toBe("operational-not-legal-certification");
    expect(report.checks).toEqual([
      expect.objectContaining({ id: "customer-profile", status: "pass" }),
      expect.objectContaining({ id: "a2p-brand", status: "pass" }),
      expect.objectContaining({ id: "a2p-campaign", status: "pass" }),
    ]);
    expect(report.ready).toBe(true);

    const tollFreeReport = await manager.inspect({
      customerProfileSid: sid("BU", "4"),
      kind: "toll-free",
      tollfreeVerificationSid: sid("HH", "3"),
    });
    expect(tollFreeReport.ready).toBe(false);
    expect(tollFreeReport.checks[1]).toMatchObject({
      diagnostics: {
        editAllowed: true,
        rejectionReason: "OPT_IN",
      },
      id: "toll-free",
      status: "fail",
    });
  });

  test("rejects incomplete campaign evidence before calling Twilio", async () => {
    const mock = makeClient();
    const manager = createTwilioComplianceManager(mock.client);
    await expect(
      manager.registerA2PCampaign(sid("MG", "6"), {
        brandRegistrationSid: sid("BN", "1"),
        description: "too short",
        hasEmbeddedLinks: false,
        hasEmbeddedPhone: false,
        messageFlow: "too short",
        messageSamples: ["one"],
        privacyPolicyUrl: "https://acme.example/privacy",
        termsAndConditionsUrl: "https://acme.example/terms",
        usAppToPersonUsecase: "ACCOUNT_NOTIFICATION",
      }),
    ).rejects.toThrow("description");
    expect(mock.campaigns.calls).toHaveLength(0);
  });

  test("requires current toll-free Trust Hub and business registration fields", async () => {
    const mock = makeClient();
    const manager = createTwilioComplianceManager(mock.client);
    await manager.submitTollFreeVerification({
      businessName: "Acme",
      businessRegistrationAuthority: "EIN",
      businessRegistrationCountry: "US",
      businessRegistrationNumber: "12-3456789",
      businessType: "PRIVATE_PROFIT",
      businessWebsite: "https://acme.example",
      customerProfileSid: sid("BU", "4"),
      messageVolume: "1,000",
      notificationEmail: "compliance@acme.example",
      optInImageUrls: ["https://acme.example/opt-in.png"],
      optInType: "WEB_FORM",
      privacyPolicyUrl: "https://acme.example/privacy",
      productionMessageSample:
        "Acme alert: incident opened. Reply STOP to opt out.",
      termsAndConditionsUrl: "https://acme.example/terms",
      tollfreePhoneNumberSid: sid("PN", "8"),
      useCaseCategories: ["ACCOUNT_NOTIFICATIONS"],
      useCaseSummary:
        "Operational incident alerts requested by account owners.",
    });
    expect(mock.tollfree.calls).toHaveLength(1);
  });

  test("initializes a validated ISV toll-free Compliance Embeddable session", async () => {
    const manager = createTwilioComplianceManager(makeClient().client);
    const session = await manager.initializeTollFreeEmbeddableInquiry({
      businessRegistrationAuthority: "EIN",
      businessRegistrationCountry: "US",
      businessRegistrationNumber: "12-3456789",
      businessType: "PRIVATE_PROFIT",
      customerProfileSid: sid("BU", "4"),
      notificationEmail: "compliance@acme.example",
      tollfreePhoneNumber: "+18005550100",
    });
    expect(session).toMatchObject({
      inquiryId: "inq_test",
      inquirySessionToken: "ephemeral.secret",
    });
  });
});
