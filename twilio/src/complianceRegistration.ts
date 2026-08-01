export type TwilioA2PBrandRegistrationInput = {
  a2PProfileBundleSid: string;
  brandType?: "SOLE_PROPRIETOR" | "STANDARD";
  customerProfileBundleSid: string;
  mock?: boolean;
  skipAutomaticSecVet?: boolean;
};

export type TwilioA2PCampaignRegistrationInput = {
  ageGated?: boolean;
  brandRegistrationSid: string;
  description: string;
  directLending?: boolean;
  hasEmbeddedLinks: boolean;
  hasEmbeddedPhone: boolean;
  helpKeywords?: string[];
  helpMessage?: string;
  messageFlow: string;
  messageSamples: string[];
  optInKeywords?: string[];
  optInMessage?: string;
  optOutKeywords?: string[];
  optOutMessage?: string;
  privacyPolicyUrl?: string;
  subscriberOptIn?: boolean;
  termsAndConditionsUrl?: string;
  usAppToPersonUsecase: string;
};

export type TwilioTollFreeVerificationInput = {
  businessName: string;
  businessWebsite: string;
  customerProfileSid?: string;
  externalReferenceId?: string;
  messageVolume: string;
  notificationEmail: string;
  optInImageUrls: string[];
  optInType:
    | "IMPORT"
    | "MOBILE_QR_CODE"
    | "PAPER_FORM"
    | "VERBAL"
    | "VIA_TEXT"
    | "WEB_FORM";
  privacyPolicyUrl?: string;
  productionMessageSample: string;
  termsAndConditionsUrl?: string;
  tollfreePhoneNumberSid: string;
  useCaseCategories: string[];
  useCaseSummary: string;
};

export type TwilioComplianceResource = {
  campaignStatus?: string;
  sid: string;
  status?: string;
};

type FetchContext = { fetch: () => Promise<TwilioComplianceResource> };
type Collection<Create> = {
  (sid: string): FetchContext;
  create: (input: Create) => Promise<TwilioComplianceResource>;
};

export type TwilioComplianceClientLike = {
  messaging: {
    v1: {
      brandRegistrations: Collection<TwilioA2PBrandRegistrationInput>;
      services: (sid: string) => {
        usAppToPerson: Collection<TwilioA2PCampaignRegistrationInput>;
      };
      tollfreeVerifications: Collection<TwilioTollFreeVerificationInput>;
    };
  };
  trusthub: {
    v1: {
      customerProfiles: (sid: string) => FetchContext;
    };
  };
};

export type TwilioComplianceInspectionTarget = {
  brandRegistrationSid?: string;
  campaignSid?: string;
  customerProfileSid?: string;
  messagingServiceSid?: string;
  tollfreeVerificationSid?: string;
};

export type TwilioComplianceStatusCheck = {
  id: "a2p-brand" | "a2p-campaign" | "customer-profile" | "toll-free";
  providerStatus: string;
  status: "fail" | "pass" | "pending";
};

export type TwilioComplianceStatusReport = {
  checks: TwilioComplianceStatusCheck[];
  ready: boolean;
  scope: "operational-not-legal-certification";
};

const SID = /^[A-Z]{2}[0-9a-fA-F]{32}$/;

const assertSid = (value: string, name: string, prefix?: string) => {
  if (!SID.test(value) || (prefix !== undefined && !value.startsWith(prefix))) {
    throw new TypeError(`${name} must be a Twilio ${prefix ?? "resource"} SID`);
  }
};

const assertHttps = (value: string, name: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new TypeError(`${name} must be an absolute HTTPS URL`);
  }
};

const validateBrand = (input: TwilioA2PBrandRegistrationInput) => {
  assertSid(input.customerProfileBundleSid, "customerProfileBundleSid", "BU");
  assertSid(input.a2PProfileBundleSid, "a2PProfileBundleSid", "BU");
};

const validateCampaign = (input: TwilioA2PCampaignRegistrationInput) => {
  assertSid(input.brandRegistrationSid, "brandRegistrationSid", "BN");
  if (input.description.length < 40 || input.description.length > 4096) {
    throw new TypeError("description must contain 40 to 4096 characters");
  }
  if (input.messageFlow.length < 40 || input.messageFlow.length > 2048) {
    throw new TypeError("messageFlow must contain 40 to 2048 characters");
  }
  if (input.messageSamples.length < 2 || input.messageSamples.length > 5) {
    throw new TypeError("messageSamples must contain two to five samples");
  }
  if (
    input.messageSamples.some(
      (sample) => sample.length < 20 || sample.length > 1024,
    )
  ) {
    throw new TypeError(
      "each message sample must contain 20 to 1024 characters",
    );
  }
  for (const [name, value] of [
    ["privacyPolicyUrl", input.privacyPolicyUrl],
    ["termsAndConditionsUrl", input.termsAndConditionsUrl],
  ] as const) {
    if (value !== undefined) assertHttps(value, name);
  }
};

const validateTollFree = (input: TwilioTollFreeVerificationInput) => {
  assertSid(input.tollfreePhoneNumberSid, "tollfreePhoneNumberSid", "PN");
  if (input.customerProfileSid !== undefined) {
    assertSid(input.customerProfileSid, "customerProfileSid", "BU");
  }
  assertHttps(input.businessWebsite, "businessWebsite");
  for (const url of input.optInImageUrls) assertHttps(url, "optInImageUrls");
  if (input.privacyPolicyUrl !== undefined)
    assertHttps(input.privacyPolicyUrl, "privacyPolicyUrl");
  if (input.termsAndConditionsUrl !== undefined)
    assertHttps(input.termsAndConditionsUrl, "termsAndConditionsUrl");
};

const classify = (
  id: TwilioComplianceStatusCheck["id"],
  providerStatus: string,
): TwilioComplianceStatusCheck => {
  const normalized = providerStatus.toUpperCase().replaceAll("-", "_");
  const approved =
    normalized === "APPROVED" ||
    normalized === "TWILIO_APPROVED" ||
    normalized === "VERIFIED";
  const failed =
    normalized.includes("FAILED") ||
    normalized.includes("REJECTED") ||
    normalized === "SUSPENDED";
  return {
    id,
    providerStatus,
    status: approved ? "pass" : failed ? "fail" : "pending",
  };
};

export const createTwilioComplianceManager = (
  client: TwilioComplianceClientLike,
) => ({
  inspect: async (
    target: TwilioComplianceInspectionTarget,
  ): Promise<TwilioComplianceStatusReport> => {
    if (
      target.campaignSid !== undefined &&
      target.messagingServiceSid === undefined
    ) {
      throw new TypeError("messagingServiceSid is required with campaignSid");
    }
    const pending: Array<Promise<TwilioComplianceStatusCheck>> = [];
    if (target.customerProfileSid !== undefined) {
      assertSid(target.customerProfileSid, "customerProfileSid", "BU");
      pending.push(
        client.trusthub.v1
          .customerProfiles(target.customerProfileSid)
          .fetch()
          .then((item) =>
            classify("customer-profile", item.status ?? "UNKNOWN"),
          ),
      );
    }
    if (target.brandRegistrationSid !== undefined) {
      assertSid(target.brandRegistrationSid, "brandRegistrationSid", "BN");
      pending.push(
        client.messaging.v1
          .brandRegistrations(target.brandRegistrationSid)
          .fetch()
          .then((item) => classify("a2p-brand", item.status ?? "UNKNOWN")),
      );
    }
    if (
      target.campaignSid !== undefined &&
      target.messagingServiceSid !== undefined
    ) {
      assertSid(target.campaignSid, "campaignSid");
      assertSid(target.messagingServiceSid, "messagingServiceSid", "MG");
      pending.push(
        client.messaging.v1
          .services(target.messagingServiceSid)
          .usAppToPerson(target.campaignSid)
          .fetch()
          .then((item) =>
            classify(
              "a2p-campaign",
              item.campaignStatus ?? item.status ?? "UNKNOWN",
            ),
          ),
      );
    }
    if (target.tollfreeVerificationSid !== undefined) {
      assertSid(target.tollfreeVerificationSid, "tollfreeVerificationSid");
      pending.push(
        client.messaging.v1
          .tollfreeVerifications(target.tollfreeVerificationSid)
          .fetch()
          .then((item) => classify("toll-free", item.status ?? "UNKNOWN")),
      );
    }
    const checks = await Promise.all(pending);
    return {
      checks,
      ready:
        checks.length > 0 && checks.every(({ status }) => status === "pass"),
      scope: "operational-not-legal-certification",
    };
  },
  registerA2PBrand: async (input: TwilioA2PBrandRegistrationInput) => {
    validateBrand(input);
    return client.messaging.v1.brandRegistrations.create(input);
  },
  registerA2PCampaign: async (
    messagingServiceSid: string,
    input: TwilioA2PCampaignRegistrationInput,
  ) => {
    assertSid(messagingServiceSid, "messagingServiceSid", "MG");
    validateCampaign(input);
    return client.messaging.v1
      .services(messagingServiceSid)
      .usAppToPerson.create(input);
  },
  submitTollFreeVerification: async (
    input: TwilioTollFreeVerificationInput,
  ) => {
    validateTollFree(input);
    return client.messaging.v1.tollfreeVerifications.create(input);
  },
});
