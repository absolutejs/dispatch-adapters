import type {
  MessagingCapabilityReport,
  MessagingRegistrationCapability,
} from "@absolutejs/dispatch";

export type SinchRegistrationResource = {
  id: string;
  reasons?: ReadonlyArray<string>;
  status: string;
};

export type SinchBrandRegistrationInput = {
  brandRegistrationType: "FULL" | "SIMPLIFIED";
  companyDetails: {
    brandName: string;
    businessContactEmail: string;
    city: string;
    companyEmail: string;
    companyName: string;
    country: string;
    postalCode: string;
    state: string;
    streetAddress: string;
    webAddress: string;
  };
  contactDetails: {
    email: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
  };
  displayName: string;
  financialDetails: {
    brandEntityType: "CHARITY_NON_PROFIT" | "PRIVATE" | "PUBLIC";
    brandVerticalType: string;
    exchange?: string;
    stockSymbol?: string;
    taxIdCorporate: string;
    taxIdCountry: string;
  };
  mock?: boolean;
};

export type SinchCampaignRegistrationInput = Record<string, unknown> & {
  ageGated: boolean;
  autoRenewal: boolean;
  brandId: string;
  campaignName: string;
  description: string;
  directLending: boolean;
  embeddedLink: boolean;
  embeddedPhone: boolean;
  helpKeywords: string;
  helpMessage: string;
  messageFlow: string;
  numberPool: boolean;
  optInMessage: string;
  optinKeywords: string;
  optoutKeywords: string;
  sample1: string;
  sample2: string;
  sample3: string;
  stopMessage: string;
  subscriberHelp: boolean;
  subscriberOptIn: boolean;
  subscriberOptOut: boolean;
  useCase: string;
};

export type SinchNumberLinkInput = { campaignId: string; number: string };

export type SinchTollFreeVerificationInput = Record<string, unknown> & {
  businessAddress1: string;
  businessCity: string;
  businessContactEmail: string;
  businessContactFirstName: string;
  businessContactLastName: string;
  businessContactPhone: string;
  businessName: string;
  businessRegistrationCountry: string;
  businessRegistrationNumber: string;
  businessRegistrationType: string;
  businessState: string;
  businessType:
    | "GOVERNMENT"
    | "NON_PROFIT"
    | "PRIVATE_PROFIT"
    | "PUBLIC_PROFIT"
    | "SOLE_PROPRIETOR";
  businessZipCode: string;
  corporateWebsite: string;
  messageVolume: string;
  optInWorkflowDescription: string;
  optInWorkflowImageUrls: ReadonlyArray<string>;
  phoneNumber: string;
  productionMessageContent: string;
  useCase: string;
  useCaseSummary: string;
};

export type SinchRegistrationClientLike = {
  brands: {
    inspect: (
      projectId: string,
      registrationId: string,
    ) => Promise<SinchRegistrationResource>;
    submit: (
      projectId: string,
      input: SinchBrandRegistrationInput,
    ) => Promise<SinchRegistrationResource>;
  };
  campaigns: {
    inspect: (
      projectId: string,
      registrationId: string,
    ) => Promise<SinchRegistrationResource>;
    qualify: (
      projectId: string,
      brandId: string,
      useCase: string,
    ) => Promise<Record<string, unknown>>;
    submit: (
      projectId: string,
      input: SinchCampaignRegistrationInput,
    ) => Promise<SinchRegistrationResource>;
  };
  numbers: {
    link: (
      projectId: string,
      input: SinchNumberLinkInput,
    ) => Promise<SinchRegistrationResource>;
    list: (
      projectId: string,
      campaignId: string,
    ) => Promise<ReadonlyArray<string>>;
  };
  tollFreeVerifications: {
    inspect: (
      projectId: string,
      registrationId: string,
    ) => Promise<SinchRegistrationResource>;
    submit: (
      projectId: string,
      input: SinchTollFreeVerificationInput,
    ) => Promise<SinchRegistrationResource>;
  };
};

export type SinchRegistrationInspectionTarget = {
  brandRegistrationId: string;
  campaignId: string;
  campaignRegistrationId: string;
  projectId: string;
  requireLinkedNumber?: boolean;
  tollFreeRegistrationId?: string;
};

export type SinchRegistrationReport = MessagingCapabilityReport & {
  diagnostics: string[];
};

const required = (value: string, name: string) => {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
};

const normalized = (status: string) => {
  const value = status.toLowerCase();
  if (["active", "approved", "verified"].includes(value))
    return "pass" as const;
  if (
    ["failed", "rejected", "suspended"].some((item) => value.includes(item))
  ) {
    return "fail" as const;
  }
  return "pending" as const;
};

const assertHttps = (value: string, name: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
};

export const createSinchRegistrationManager = (
  client: SinchRegistrationClientLike,
  projectId: string,
) =>
  ({
    registerBrand: async (input: SinchBrandRegistrationInput) => {
      required(projectId, "projectId");
      required(input.displayName, "displayName");
      required(input.companyDetails.companyName, "companyDetails.companyName");
      required(input.companyDetails.brandName, "companyDetails.brandName");
      required(input.companyDetails.country, "companyDetails.country");
      required(
        input.financialDetails.taxIdCorporate,
        "financialDetails.taxIdCorporate",
      );
      if (!/^\+[1-9]\d{6,14}$/.test(input.contactDetails.phoneNumber)) {
        throw new Error("contactDetails.phoneNumber must be an E.164 address");
      }
      assertHttps(input.companyDetails.webAddress, "companyDetails.webAddress");
      return client.brands.submit(projectId, input);
    },
    qualifyCampaign: (brandId: string, useCase: string) => {
      required(brandId, "brandId");
      required(useCase, "useCase");
      return client.campaigns.qualify(projectId, brandId, useCase);
    },
    registerCampaign: async (input: SinchCampaignRegistrationInput) => {
      required(input.brandId, "brandId");
      required(input.campaignName, "campaignName");
      required(input.useCase, "useCase");
      if (input.description.trim().length < 40) {
        throw new Error("description must contain at least 40 characters");
      }
      if (input.sample1.trim().length < 20) {
        throw new Error("sample1 must contain at least 20 characters");
      }
      if (
        input.sample2.trim().length === 0 ||
        input.sample3.trim().length === 0 ||
        input.stopMessage.trim().length < 20 ||
        input.optInMessage.trim().length < 20 ||
        input.helpMessage.trim().length < 20
      ) {
        throw new Error(
          "campaign samples and subscriber messages are incomplete",
        );
      }
      if (input.messageFlow.trim().length < 40) {
        throw new Error("messageFlow must contain at least 40 characters");
      }
      required(input.optinKeywords, "optinKeywords");
      required(input.optoutKeywords, "optoutKeywords");
      required(input.helpKeywords, "helpKeywords");
      return client.campaigns.submit(projectId, input);
    },
    linkNumber: (input: SinchNumberLinkInput) => {
      required(input.campaignId, "campaignId");
      if (!/^\+[1-9]\d{6,14}$/.test(input.number)) {
        throw new Error("number must be an E.164 address");
      }
      return client.numbers.link(projectId, input);
    },
    registerTollFree: (input: SinchTollFreeVerificationInput) => {
      required(input.businessContactEmail, "businessContactEmail");
      required(input.businessName, "businessName");
      required(input.businessRegistrationNumber, "businessRegistrationNumber");
      required(input.messageVolume, "messageVolume");
      required(input.optInWorkflowDescription, "optInWorkflowDescription");
      required(input.productionMessageContent, "productionMessageContent");
      required(input.useCase, "useCase");
      required(input.useCaseSummary, "useCaseSummary");
      assertHttps(input.corporateWebsite, "corporateWebsite");
      if (!/^\+[1-9]\d{6,14}$/.test(input.phoneNumber)) {
        throw new Error("phoneNumber must be an E.164 address");
      }
      if (!/^\+[1-9]\d{6,14}$/.test(input.businessContactPhone)) {
        throw new Error("businessContactPhone must be an E.164 address");
      }
      if (input.optInWorkflowImageUrls.length === 0) {
        throw new Error("at least one opt-in evidence image is required");
      }
      input.optInWorkflowImageUrls.forEach((url, index) =>
        assertHttps(url, `optInWorkflowImageUrls[${index}]`),
      );
      return client.tollFreeVerifications.submit(projectId, input);
    },
    inspect: async (
      target: SinchRegistrationInspectionTarget,
    ): Promise<SinchRegistrationReport> => {
      if (target.projectId !== projectId)
        throw new Error("unexpected projectId");
      const [brand, campaign, numbers, tollFree] = await Promise.all([
        client.brands.inspect(projectId, target.brandRegistrationId),
        client.campaigns.inspect(projectId, target.campaignRegistrationId),
        client.numbers.list(projectId, target.campaignId),
        target.tollFreeRegistrationId === undefined
          ? undefined
          : client.tollFreeVerifications.inspect(
              projectId,
              target.tollFreeRegistrationId,
            ),
      ]);
      const checks = [
        {
          detail: "10DLC brand is approved",
          id: "brand-approved",
          status: normalized(brand.status),
        },
        {
          detail: "10DLC campaign is approved",
          id: "campaign-approved",
          status: normalized(campaign.status),
        },
        {
          detail: "At least one sending number is linked when required",
          id: "number-linked",
          status:
            target.requireLinkedNumber !== true || numbers.length > 0
              ? ("pass" as const)
              : ("fail" as const),
        },
      ];
      if (tollFree !== undefined) {
        checks.push({
          detail: "Toll-free verification is approved",
          id: "toll-free-approved",
          status: normalized(tollFree.status),
        });
      }
      return {
        checks,
        diagnostics: [
          ...(brand.reasons ?? []),
          ...(campaign.reasons ?? []),
          ...(tollFree?.reasons ?? []),
        ],
        ready: checks.every(({ status }) => status === "pass"),
      };
    },
  }) satisfies MessagingRegistrationCapability<SinchRegistrationInspectionTarget> &
    Record<string, unknown>;
