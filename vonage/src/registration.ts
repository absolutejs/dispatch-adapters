import type {
  MessagingCapabilityReport,
  MessagingRegistrationCapability,
} from "@absolutejs/dispatch";

export type VonageRegistrationResource = {
  id: string;
  reasons?: ReadonlyArray<string>;
  status: string;
};

export type VonageRegistrationClientLike = {
  brands: {
    create: (
      input: VonageBrandRegistrationInput,
    ) => Promise<VonageRegistrationResource>;
    retrieve: (id: string) => Promise<VonageRegistrationResource>;
  };
  campaigns: {
    create: (
      brandId: string,
      input: VonageCampaignRegistrationInput,
    ) => Promise<VonageRegistrationResource>;
    retrieve: (id: string) => Promise<VonageRegistrationResource>;
  };
  numbers: {
    linkToCampaign: (
      brandId: string,
      campaignId: string,
      input: VonageNumberLinkInput,
    ) => Promise<VonageRegistrationResource>;
    listForCampaign: (campaignId: string) => Promise<ReadonlyArray<string>>;
  };
};

export type VonageBrandRegistrationInput = Record<string, unknown> & {
  account_id: string;
  country: string;
  email: string;
  entity_type: string;
  vertical: string;
};

export type VonageCampaignRegistrationInput = Record<string, unknown> & {
  account_id: string;
  description: string;
  message_flow_details: Record<string, unknown>;
  sample_one: string;
  usecase: string;
};

export type VonageNumberLinkInput = {
  country: string;
  number: string;
};

export type VonageRegistrationInspectionTarget = {
  brandId: string;
  campaignId: string;
  requireLinkedNumber?: boolean;
};

export type VonageRegistrationReport = MessagingCapabilityReport & {
  diagnostics: string[];
};

const required = (value: string, name: string) => {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
};

const carrierNumber = (value: string) => {
  const number = value.replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(number)) {
    throw new Error("number must contain 7-15 E.164 digits without 00");
  }
  return number;
};

const normalized = (status: string) => {
  const value = status.toLowerCase();
  if (["active", "approved", "verified"].includes(value))
    return "pass" as const;
  if (["failed", "rejected", "suspended"].some((item) => value.includes(item)))
    return "fail" as const;
  return "pending" as const;
};

export const createVonageRegistrationManager = (
  client: VonageRegistrationClientLike,
) =>
  ({
    registerBrand: async (input: VonageBrandRegistrationInput) => {
      required(input.account_id, "account_id");
      required(input.country, "country");
      required(input.email, "email");
      required(input.entity_type, "entity_type");
      required(input.vertical, "vertical");
      return client.brands.create(input);
    },
    registerCampaign: async (
      brandId: string,
      input: VonageCampaignRegistrationInput,
    ) => {
      required(brandId, "brandId");
      required(input.account_id, "account_id");
      if (input.description.trim().length < 40) {
        throw new Error("description must contain at least 40 characters");
      }
      if (input.sample_one.trim().length < 20) {
        throw new Error("sample_one must contain at least 20 characters");
      }
      if (Object.keys(input.message_flow_details).length === 0) {
        throw new Error("message_flow_details is required");
      }
      required(input.usecase, "usecase");
      return client.campaigns.create(brandId, input);
    },
    linkNumber: async (
      brandId: string,
      campaignId: string,
      input: VonageNumberLinkInput,
    ) => {
      required(brandId, "brandId");
      required(campaignId, "campaignId");
      required(input.country, "country");
      return client.numbers.linkToCampaign(brandId, campaignId, {
        ...input,
        number: carrierNumber(input.number),
      });
    },
    inspect: async (
      target: VonageRegistrationInspectionTarget,
    ): Promise<VonageRegistrationReport> => {
      const [brand, campaign, numbers] = await Promise.all([
        client.brands.retrieve(target.brandId),
        client.campaigns.retrieve(target.campaignId),
        client.numbers.listForCampaign(target.campaignId),
      ]);
      const checks = [
        {
          detail: "10DLC brand is approved",
          id: "brand-approved",
          status: normalized(brand.status),
        },
        {
          detail: "10DLC campaign is approved by carriers",
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
      return {
        checks,
        diagnostics: [...(brand.reasons ?? []), ...(campaign.reasons ?? [])],
        ready: checks.every(({ status }) => status === "pass"),
      };
    },
  }) satisfies MessagingRegistrationCapability<VonageRegistrationInspectionTarget> &
    Record<string, unknown>;
