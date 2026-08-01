import type {
  MessagingCapabilityReport,
  MessagingRegistrationCapability,
} from "@absolutejs/dispatch";

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
  privacyPolicyUrl: string;
  subscriberOptIn?: boolean;
  termsAndConditionsUrl: string;
  usAppToPersonUsecase: string;
};

type TwilioTollFreeVerificationBase = {
  businessName: string;
  businessWebsite: string;
  customerProfileSid: string;
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
  privacyPolicyUrl: string;
  productionMessageSample: string;
  termsAndConditionsUrl: string;
  tollfreePhoneNumberSid: string;
  useCaseCategories: string[];
  useCaseSummary: string;
};

export type TwilioTollFreeVerificationInput =
  | (TwilioTollFreeVerificationBase & {
      businessRegistrationAuthority?: never;
      businessRegistrationCountry?: never;
      businessRegistrationNumber?: never;
      businessType: "SOLE_PROPRIETOR";
    })
  | (TwilioTollFreeVerificationBase & {
      businessRegistrationAuthority:
        | "ABN"
        | "ACN"
        | "BRN"
        | "CBN"
        | "CIF"
        | "CNPJ"
        | "CRN"
        | "EIN"
        | "NEQ"
        | "NIF"
        | "NZBN"
        | "OTHER"
        | "PROVINCIAL_NUMBER"
        | "SIREN"
        | "SIRET"
        | "UID"
        | "USt-IdNr"
        | "VAT";
      businessRegistrationCountry: string;
      businessRegistrationNumber: string;
      businessType:
        | "GOVERNMENT"
        | "NON_PROFIT"
        | "PRIVATE_PROFIT"
        | "PUBLIC_PROFIT";
    });

export type TwilioComplianceResource = {
  campaignStatus?: string;
  editAllowed?: boolean;
  editExpiration?: Date | string;
  errorCode?: number;
  failureReason?: string;
  rejectionReason?: string;
  rejectionReasons?: unknown[];
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
      complianceTollfreeInquiries: {
        create: (
          input: TwilioTollFreeEmbeddableInquiryInput,
        ) => Promise<TwilioComplianceEmbeddableSession>;
      };
      customerProfiles: (sid: string) => FetchContext;
    };
  };
};

export type TwilioTollFreeEmbeddableInquiryInput = {
  businessName?: string;
  businessRegistrationAuthority?: string;
  businessRegistrationCountry?: string;
  businessRegistrationNumber?: string;
  businessType?:
    | "GOVERNMENT"
    | "NON_PROFIT"
    | "PRIVATE_PROFIT"
    | "PUBLIC_PROFIT"
    | "SOLE_PROPRIETOR";
  businessWebsite?: string;
  customerProfileSid: string;
  notificationEmail: string;
  privacyPolicyUrl?: string;
  termsAndConditionsUrl?: string;
  themeSetId?: string;
  tollfreePhoneNumber: string;
};

export type TwilioComplianceEmbeddableSession = {
  inquiryId: string;
  /** Ephemeral secret; expose only to the authenticated end customer's browser. */
  inquirySessionToken: string;
  registrationId: string;
  url: string;
};

export type TwilioComplianceInspectionTarget =
  | {
      brandRegistrationSid: string;
      campaignSid: string;
      customerProfileSid: string;
      kind: "a2p";
      messagingServiceSid: string;
    }
  | {
      customerProfileSid: string;
      kind: "toll-free";
      tollfreeVerificationSid: string;
    };

export type TwilioComplianceStatusCheck = {
  detail: string;
  diagnostics?: {
    editAllowed?: boolean;
    editExpiration?: string;
    errorCode?: number;
    failureReason?: string;
    rejectionReason?: string;
    rejectionReasons?: unknown[];
  };
  id: "a2p-brand" | "a2p-campaign" | "customer-profile" | "toll-free";
  providerStatus: string;
  status: "fail" | "pass" | "pending";
};

export type TwilioComplianceStatusReport = MessagingCapabilityReport & {
  checks: TwilioComplianceStatusCheck[];
  ready: boolean;
  scope: "operational-not-legal-certification";
};

const SID = /^[A-Z]{2}[0-9a-fA-F]{32}$/;
const TOLL_FREE_E164 = /^\+1(?:800|833|844|855|866|877|888)\d{7}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    assertHttps(value, name);
  }
};

const validateTollFree = (input: TwilioTollFreeVerificationInput) => {
  assertSid(input.tollfreePhoneNumberSid, "tollfreePhoneNumberSid", "PN");
  assertSid(input.customerProfileSid, "customerProfileSid", "BU");
  assertHttps(input.businessWebsite, "businessWebsite");
  for (const url of input.optInImageUrls) assertHttps(url, "optInImageUrls");
  assertHttps(input.privacyPolicyUrl, "privacyPolicyUrl");
  assertHttps(input.termsAndConditionsUrl, "termsAndConditionsUrl");
  if (input.businessType !== "SOLE_PROPRIETOR") {
    for (const [name, value] of [
      ["businessRegistrationNumber", input.businessRegistrationNumber],
      ["businessRegistrationCountry", input.businessRegistrationCountry],
      ["businessRegistrationAuthority", input.businessRegistrationAuthority],
    ] as const) {
      if (value.trim().length === 0) {
        throw new TypeError(`${name} must not be empty`);
      }
    }
  }
};

const validateTollFreeInquiry = (
  input: TwilioTollFreeEmbeddableInquiryInput,
) => {
  assertSid(input.customerProfileSid, "customerProfileSid", "BU");
  if (!TOLL_FREE_E164.test(input.tollfreePhoneNumber)) {
    throw new TypeError(
      "tollfreePhoneNumber must be a NANP toll-free E.164 number",
    );
  }
  if (!EMAIL.test(input.notificationEmail)) {
    throw new TypeError("notificationEmail must be a valid email address");
  }
  for (const [name, value] of [
    ["businessWebsite", input.businessWebsite],
    ["privacyPolicyUrl", input.privacyPolicyUrl],
    ["termsAndConditionsUrl", input.termsAndConditionsUrl],
  ] as const) {
    if (value !== undefined) assertHttps(value, name);
  }
  if (
    input.businessType !== undefined &&
    input.businessType !== "SOLE_PROPRIETOR"
  ) {
    for (const [name, value] of [
      ["businessRegistrationNumber", input.businessRegistrationNumber],
      ["businessRegistrationCountry", input.businessRegistrationCountry],
      ["businessRegistrationAuthority", input.businessRegistrationAuthority],
    ] as const) {
      if (value === undefined || value.trim().length === 0) {
        throw new TypeError(`${name} is required for registered businesses`);
      }
    }
  }
};

const classify = (
  id: TwilioComplianceStatusCheck["id"],
  resource: TwilioComplianceResource,
): TwilioComplianceStatusCheck => {
  const providerStatus =
    resource.campaignStatus ?? resource.status ?? "UNKNOWN";
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
    ...(resource.rejectionReason !== undefined ||
    resource.rejectionReasons !== undefined ||
    resource.errorCode !== undefined ||
    resource.failureReason !== undefined ||
    resource.editAllowed !== undefined ||
    resource.editExpiration !== undefined
      ? {
          diagnostics: {
            ...(resource.editAllowed === undefined
              ? {}
              : { editAllowed: resource.editAllowed }),
            ...(resource.editExpiration === undefined
              ? {}
              : {
                  editExpiration:
                    resource.editExpiration instanceof Date
                      ? resource.editExpiration.toISOString()
                      : resource.editExpiration,
                }),
            ...(resource.errorCode === undefined
              ? {}
              : { errorCode: resource.errorCode }),
            ...(resource.failureReason === undefined
              ? {}
              : { failureReason: resource.failureReason }),
            ...(resource.rejectionReason === undefined
              ? {}
              : { rejectionReason: resource.rejectionReason }),
            ...(resource.rejectionReasons === undefined
              ? {}
              : { rejectionReasons: resource.rejectionReasons }),
          },
        }
      : {}),
    id,
    detail: `${id} status is ${providerStatus}`,
    providerStatus,
    status: approved ? "pass" : failed ? "fail" : "pending",
  };
};

export const createTwilioComplianceManager = (
  client: TwilioComplianceClientLike,
) =>
  ({
    initializeTollFreeEmbeddableInquiry: async (
      input: TwilioTollFreeEmbeddableInquiryInput,
    ) => {
      validateTollFreeInquiry(input);
      const session =
        await client.trusthub.v1.complianceTollfreeInquiries.create(input);
      if (
        session.inquiryId.length === 0 ||
        session.inquirySessionToken.length === 0 ||
        session.registrationId.length === 0
      ) {
        throw new TypeError(
          "Twilio returned an invalid Compliance Embeddable session",
        );
      }
      return session;
    },
    inspect: async (
      target: TwilioComplianceInspectionTarget,
    ): Promise<TwilioComplianceStatusReport> => {
      const pending: Array<Promise<TwilioComplianceStatusCheck>> = [];
      assertSid(target.customerProfileSid, "customerProfileSid", "BU");
      pending.push(
        client.trusthub.v1
          .customerProfiles(target.customerProfileSid)
          .fetch()
          .then((item) => classify("customer-profile", item)),
      );
      if (target.kind === "a2p") {
        assertSid(target.brandRegistrationSid, "brandRegistrationSid", "BN");
        assertSid(target.campaignSid, "campaignSid");
        assertSid(target.messagingServiceSid, "messagingServiceSid", "MG");
        pending.push(
          client.messaging.v1
            .brandRegistrations(target.brandRegistrationSid)
            .fetch()
            .then((item) => classify("a2p-brand", item)),
        );
        pending.push(
          client.messaging.v1
            .services(target.messagingServiceSid)
            .usAppToPerson(target.campaignSid)
            .fetch()
            .then((item) => classify("a2p-campaign", item)),
        );
      } else {
        assertSid(target.tollfreeVerificationSid, "tollfreeVerificationSid");
        pending.push(
          client.messaging.v1
            .tollfreeVerifications(target.tollfreeVerificationSid)
            .fetch()
            .then((item) => classify("toll-free", item)),
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
  }) satisfies MessagingRegistrationCapability<TwilioComplianceInspectionTarget> &
    Record<string, unknown>;
