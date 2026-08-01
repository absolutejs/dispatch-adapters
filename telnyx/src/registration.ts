import type Telnyx from "telnyx";
import type {
  MessagingCapabilityReport,
  MessagingRegistrationCapability,
} from "@absolutejs/dispatch";

export type TelnyxComplianceClientLike = Pick<
  Telnyx,
  "messaging10dlc" | "messagingTollfree"
>;

export type TelnyxA2PBrandRegistrationInput = Parameters<
  TelnyxComplianceClientLike["messaging10dlc"]["brand"]["create"]
>[0] & {
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
};

export type TelnyxA2PCampaignRegistrationInput = Parameters<
  TelnyxComplianceClientLike["messaging10dlc"]["campaignBuilder"]["submit"]
>[0] & {
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
};

export type TelnyxTollFreeVerificationInput = Parameters<
  TelnyxComplianceClientLike["messagingTollfree"]["verification"]["requests"]["create"]
>[0] & {
  businessRegistrationCountry: string;
  businessRegistrationNumber: string;
  businessRegistrationType: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
};

export type TelnyxComplianceInspectionTarget =
  | { brandId: string; campaignId: string; kind: "a2p" }
  | { kind: "toll-free"; verificationRequestId: string };

export type TelnyxComplianceStatusReport = MessagingCapabilityReport & {
  checks: Array<{
    detail: string;
    id: string;
    providerStatus: string;
    status: "fail" | "pass" | "pending";
  }>;
  diagnostics: string[];
  ready: boolean;
  target: TelnyxComplianceInspectionTarget["kind"];
};

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0;
const https = (value: string, field: string) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:")
    throw new TypeError(`${field} must use HTTPS`);
};
const requireEvidenceUrls = (input: {
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
}) => {
  https(input.privacyPolicyUrl, "privacyPolicyUrl");
  https(input.termsOfServiceUrl, "termsOfServiceUrl");
};
const row = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const statusOf = (value: unknown) => {
  const found = row(value);
  return String(
    found.status ??
      found.verificationStatus ??
      found.campaignStatus ??
      found.brandIdentityStatus ??
      "unknown",
  );
};
const diagnosticsOf = (value: unknown) => {
  const found = row(value);
  return [
    found.failureReasons,
    found.rejectionReasons,
    found.errors,
    found.reason,
  ]
    .flatMap((item) =>
      Array.isArray(item) ? item : item === undefined ? [] : [item],
    )
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
};
const approved = (status: string) =>
  ["active", "approved", "complete", "completed", "verified"].includes(
    status.toLowerCase(),
  );
const normalizedStatus = (status: string) =>
  approved(status)
    ? ("pass" as const)
    : ["failed", "rejected", "suspended"].some((value) =>
          status.toLowerCase().includes(value),
        )
      ? ("fail" as const)
      : ("pending" as const);

export const createTelnyxComplianceManager = (
  client: TelnyxComplianceClientLike,
) =>
  ({
    inspect: async (
      target: TelnyxComplianceInspectionTarget,
    ): Promise<TelnyxComplianceStatusReport> => {
      if (target.kind === "a2p") {
        const [brand, campaign] = await Promise.all([
          client.messaging10dlc.brand.retrieve(target.brandId),
          client.messaging10dlc.campaign.retrieve(target.campaignId),
        ]);
        const brandStatus = statusOf(brand);
        const campaignStatus = statusOf(campaign);
        const checks = [
          {
            detail: "10DLC brand is approved",
            id: "brand-approved",
            providerStatus: brandStatus,
            status: normalizedStatus(brandStatus),
          },
          {
            detail: "10DLC campaign is approved",
            id: "campaign-approved",
            providerStatus: campaignStatus,
            status: normalizedStatus(campaignStatus),
          },
        ];
        return {
          checks,
          diagnostics: [...diagnosticsOf(brand), ...diagnosticsOf(campaign)],
          ready: checks.every(({ status }) => status === "pass"),
          target: "a2p",
        };
      }
      const request =
        await client.messagingTollfree.verification.requests.retrieve(
          target.verificationRequestId,
        );
      const status = statusOf(request);
      const checks = [
        {
          detail: "Toll-free verification is approved",
          id: "toll-free-approved",
          providerStatus: status,
          status: normalizedStatus(status),
        },
      ];
      return {
        checks,
        diagnostics: diagnosticsOf(request),
        ready: checks.every(({ status }) => status === "pass"),
        target: "toll-free",
      };
    },
    submitA2P: async (input: {
      brand: TelnyxA2PBrandRegistrationInput;
      campaign: Omit<TelnyxA2PCampaignRegistrationInput, "brandId">;
    }) => {
      requireEvidenceUrls(input.brand);
      requireEvidenceUrls(input.campaign);
      const {
        privacyPolicyUrl: _brandPrivacy,
        termsOfServiceUrl: _brandTerms,
        ...brandInput
      } = input.brand;
      const brand = await client.messaging10dlc.brand.create(brandInput);
      const brandId = String(row(brand).brandId ?? row(brand).id ?? "");
      if (!nonEmpty(brandId))
        throw new Error("Telnyx did not return a brand id");
      const {
        privacyPolicyUrl: _campaignPrivacy,
        termsOfServiceUrl: _campaignTerms,
        ...campaignInput
      } = input.campaign;
      if (!nonEmpty(campaignInput.messageFlow))
        throw new TypeError(
          "campaign.messageFlow must describe the opt-in workflow",
        );
      const campaign = await client.messaging10dlc.campaignBuilder.submit({
        ...campaignInput,
        brandId,
      });
      return { brand, campaign };
    },
    submitTollFree: async (input: TelnyxTollFreeVerificationInput) => {
      requireEvidenceUrls(input);
      for (const field of [
        "businessRegistrationCountry",
        "businessRegistrationNumber",
        "businessRegistrationType",
        "optInWorkflow",
        "productionMessageContent",
        "useCaseSummary",
      ] as const) {
        if (!nonEmpty(input[field]))
          throw new TypeError(`${field} is required`);
      }
      const {
        privacyPolicyUrl: _privacy,
        termsOfServiceUrl: _terms,
        ...request
      } = input;
      return client.messagingTollfree.verification.requests.create(request);
    },
    updateRejectedTollFree: async (
      id: string,
      input: Parameters<
        TelnyxComplianceClientLike["messagingTollfree"]["verification"]["requests"]["update"]
      >[1],
    ) => client.messagingTollfree.verification.requests.update(id, input),
  }) satisfies MessagingRegistrationCapability<TelnyxComplianceInspectionTarget> &
    Record<string, unknown>;
