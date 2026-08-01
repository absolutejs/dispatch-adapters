import type {
  SinchBrandRegistrationInput,
  SinchCampaignRegistrationInput,
  SinchRegistrationClientLike,
  SinchRegistrationResource,
  SinchTollFreeVerificationInput,
} from "./registration";

export type SinchRegistrationFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CreateSinchRegistrationClientOptions = {
  authOrigin?: string;
  fetch?: SinchRegistrationFetch;
  keyId: string;
  keySecret: string;
  now?: () => number;
  numbersOrigin?: string;
  registrationOrigin?: string;
};

export class SinchRegistrationApiError extends Error {
  readonly body: unknown;
  readonly status: number;

  constructor(status: number, body: unknown) {
    const record = asRecord(body);
    super(
      typeof record.message === "string"
        ? record.message
        : `Sinch registration request failed with HTTP ${status}`,
    );
    this.name = "SinchRegistrationApiError";
    this.body = body;
    this.status = status;
  }
}

export class SinchRegistrationIndeterminateError extends Error {
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(
      `Sinch may have accepted ${operation}; inspect provider state before retrying`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "SinchRegistrationIndeterminateError";
    this.operation = operation;
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const required = (value: string, name: string) => {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
};

const origin = (value: string, name: string) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return parsed.origin;
};

const stringArray = (value: unknown): string[] => {
  if (typeof value === "string" && value.trim().length > 0) return [value];
  if (Array.isArray(value)) return value.flatMap(stringArray);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringArray);
  }
  return [];
};

const resourceOf = (
  payload: unknown,
  fallbackId: string,
  fallbackStatus = "pending",
): SinchRegistrationResource => {
  const value = asRecord(payload);
  const id = [
    value.id,
    value.brandRegistrationId,
    value.campaignRegistrationId,
    value.tfnVerificationId,
    value.phoneNumber,
    fallbackId,
  ].find((candidate) => typeof candidate === "string" && candidate.length > 0);
  if (id === undefined) {
    throw new SinchRegistrationIndeterminateError("registration operation");
  }
  const status = [
    value.status,
    value.brandRegistrationStatus,
    value.verificationStatus,
    value.lastActionStatus,
    value.state,
    fallbackStatus,
  ].find((candidate) => typeof candidate === "string" && candidate.length > 0);
  const reasons = stringArray(
    value.reasons ??
      value.rejectionReasons ??
      value.errors ??
      value.failureReasons,
  );
  return {
    id: String(id),
    ...(reasons.length === 0 ? {} : { reasons }),
    status: String(status),
  };
};

export const createSinchRegistrationClient = (
  options: CreateSinchRegistrationClientOptions,
): SinchRegistrationClientLike => {
  required(options.keyId, "keyId");
  required(options.keySecret, "keySecret");
  const authOrigin = origin(
    options.authOrigin ?? "https://auth.sinch.com",
    "authOrigin",
  );
  const registrationOrigin = origin(
    options.registrationOrigin ?? "https://us10dlc.numbers.api.sinch.com",
    "registrationOrigin",
  );
  const numbersOrigin = origin(
    options.numbersOrigin ?? "https://numbers.api.sinch.com",
    "numbersOrigin",
  );
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let token: { accessToken: string; refreshAfter: number } | undefined;
  let tokenRequest: Promise<string> | undefined;

  const accessToken = async () => {
    if (token !== undefined && token.refreshAfter > now()) {
      return token.accessToken;
    }
    tokenRequest ??= (async () => {
      const response = await request(`${authOrigin}/oauth2/token`, {
        body: "grant_type=client_credentials",
        headers: {
          authorization: `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new SinchRegistrationApiError(response.status, payload);
      const value = asRecord(payload);
      if (
        typeof value.access_token !== "string" ||
        value.access_token.length === 0
      ) {
        throw new Error("Sinch OAuth response did not contain an access token");
      }
      const expiresIn =
        typeof value.expires_in === "number" && value.expires_in > 0
          ? value.expires_in
          : 3_600;
      token = {
        accessToken: value.access_token,
        refreshAfter: now() + Math.max(1, expiresIn - 60) * 1_000,
      };
      return token.accessToken;
    })().finally(() => {
      tokenRequest = undefined;
    });
    return tokenRequest;
  };

  const json = async (
    targetOrigin: string,
    path: string,
    init: { body?: unknown; method?: string } = {},
  ) => {
    const response = await request(`${targetOrigin}${path}`, {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      method: init.method ?? "GET",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new SinchRegistrationApiError(response.status, payload);
    return payload;
  };

  const projectPath = (projectId: string) =>
    `/v1/projects/${encodeURIComponent(projectId)}`;

  const mutate = async (
    targetOrigin: string,
    path: string,
    body: unknown,
    operation: string,
    method = "POST",
  ) => {
    try {
      return await json(targetOrigin, path, { body, method });
    } catch (error) {
      if (error instanceof SinchRegistrationApiError) throw error;
      if (error instanceof SinchRegistrationIndeterminateError) throw error;
      throw new SinchRegistrationIndeterminateError(operation, error);
    }
  };

  return {
    brands: {
      inspect: async (projectId, registrationId) =>
        resourceOf(
          await json(
            registrationOrigin,
            `${projectPath(projectId)}/brandRegistrations/${encodeURIComponent(registrationId)}`,
          ),
          registrationId,
        ),
      submit: async (projectId, input: SinchBrandRegistrationInput) =>
        resourceOf(
          await mutate(
            registrationOrigin,
            `${projectPath(projectId)}/brandRegistrations:submit`,
            input,
            "brand registration",
          ),
          "",
        ),
    },
    campaigns: {
      inspect: async (projectId, registrationId) =>
        resourceOf(
          await json(
            registrationOrigin,
            `${projectPath(projectId)}/campaignRegistrations/${encodeURIComponent(registrationId)}`,
          ),
          registrationId,
        ),
      qualify: (projectId, brandId, useCase) =>
        json(
          registrationOrigin,
          `${projectPath(projectId)}/campaignRegistrations:qualify?${new URLSearchParams({ brandId, useCase })}`,
        ) as Promise<Record<string, unknown>>,
      submit: async (projectId, input: SinchCampaignRegistrationInput) =>
        resourceOf(
          await mutate(
            registrationOrigin,
            `${projectPath(projectId)}/campaignRegistrations:submit`,
            input,
            "campaign registration",
          ),
          "",
        ),
    },
    numbers: {
      link: async (projectId, input) => {
        const path = `${projectPath(projectId)}/activeNumbers/${encodeURIComponent(input.number)}`;
        const active = asRecord(await json(numbersOrigin, path));
        const smsConfiguration = asRecord(active.smsConfiguration);
        if (
          typeof smsConfiguration.servicePlanId !== "string" ||
          smsConfiguration.servicePlanId.length === 0
        ) {
          throw new Error(
            "Sinch number must already have an SMS service plan before linking a campaign",
          );
        }
        if (smsConfiguration.campaignId === input.campaignId) {
          return resourceOf(active, input.number, "active");
        }
        if (
          typeof smsConfiguration.campaignId === "string" &&
          smsConfiguration.campaignId.length > 0
        ) {
          await mutate(
            numbersOrigin,
            path,
            {
              smsConfiguration: {
                campaignId: "",
                servicePlanId: smsConfiguration.servicePlanId,
              },
            },
            "campaign unlinking",
            "PATCH",
          );
        }
        const updated = await mutate(
          numbersOrigin,
          path,
          {
            smsConfiguration: {
              campaignId: input.campaignId,
              servicePlanId: smsConfiguration.servicePlanId,
            },
          },
          "campaign linking",
          "PATCH",
        );
        return resourceOf(updated, input.number, "linking");
      },
      list: async (projectId, campaignId) => {
        const numbers: string[] = [];
        let pageToken: string | undefined;
        do {
          const query = new URLSearchParams({ pageSize: "100" });
          if (pageToken !== undefined) query.set("pageToken", pageToken);
          const payload = asRecord(
            await json(
              numbersOrigin,
              `${projectPath(projectId)}/activeNumbers?${query}`,
            ),
          );
          for (const item of Array.isArray(payload.activeNumbers)
            ? payload.activeNumbers
            : []) {
            const active = asRecord(item);
            if (
              asRecord(active.smsConfiguration).campaignId === campaignId &&
              typeof active.phoneNumber === "string"
            ) {
              numbers.push(active.phoneNumber);
            }
          }
          pageToken =
            typeof payload.nextPageToken === "string" &&
            payload.nextPageToken.length > 0
              ? payload.nextPageToken
              : undefined;
        } while (pageToken !== undefined);
        return numbers;
      },
    },
    tollFreeVerifications: {
      inspect: async (projectId, registrationId) =>
        resourceOf(
          await json(
            registrationOrigin,
            `${projectPath(projectId)}/tfnVerification/${encodeURIComponent(registrationId)}`,
          ),
          registrationId,
        ),
      submit: async (projectId, input: SinchTollFreeVerificationInput) =>
        resourceOf(
          await mutate(
            registrationOrigin,
            `${projectPath(projectId)}/tfnVerification`,
            input,
            "toll-free verification",
          ),
          "",
        ),
    },
  };
};
