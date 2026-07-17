import type { PushAdapter, PushMessage } from "@absolutejs/dispatch";
import { GoogleAuth } from "google-auth-library";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_ORIGIN = "https://fcm.googleapis.com";

export type FcmFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GoogleAuthLike = {
  getClient: () => Promise<{
    getAccessToken: () => Promise<null | string | { token?: null | string }>;
  }>;
};

export type CreateFcmAdapterOptions = {
  projectId: string;
  auth?: GoogleAuthLike;
  credentials?: Record<string, unknown>;
  fetch?: FcmFetch;
  origin?: string;
};

export type FcmTargetType = "condition" | "token" | "topic";

export class FcmDispatchError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(input: { code?: string; message: string; status: number }) {
    super(input.message);
    this.name = "FcmDispatchError";
    this.code = input.code;
    this.status = input.status;
  }
}

const stringValue = (key: string, value: unknown) => {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error(`[dispatch-fcm] data value ${key} is not serializable`);

  return encoded;
};

const stringData = (data: Record<string, unknown> | undefined) =>
  data === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          stringValue(key, value),
        ]),
      );

const objectMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];

  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
};

const targetFor = (message: PushMessage) => {
  const declared = message.metadata?.targetType;
  const targetType: FcmTargetType =
    declared === "condition" || declared === "topic" || declared === "token"
      ? declared
      : message.to.startsWith("/topics/")
        ? "topic"
        : "token";
  const value =
    targetType === "topic" && message.to.startsWith("/topics/")
      ? message.to.slice("/topics/".length)
      : message.to;

  return { [targetType]: value };
};

const accessTokenFor = async (auth: GoogleAuthLike) => {
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw new Error("[dispatch-fcm] Google auth returned no token");

  return token;
};

const responseError = async (response: Response) => {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: {
      details?: Array<{ errorCode?: string }>;
      message?: string;
      status?: string;
    };
  };
  const detailCode = payload.error?.details?.find(
    (detail) => typeof detail.errorCode === "string",
  )?.errorCode;

  return new FcmDispatchError({
    ...((detailCode ?? payload.error?.status)
      ? { code: detailCode ?? payload.error?.status }
      : {}),
    message:
      payload.error?.message ??
      `[dispatch-fcm] FCM request failed with HTTP ${response.status}`,
    status: response.status,
  });
};

export const createFcmAdapter = (
  options: CreateFcmAdapterOptions,
): PushAdapter => {
  if (!options.projectId.trim())
    throw new Error("[dispatch-fcm] projectId is required");
  const auth =
    options.auth ??
    new GoogleAuth({
      ...(options.credentials ? { credentials: options.credentials } : {}),
      scopes: [FCM_SCOPE],
    });
  const request = options.fetch ?? fetch;
  const endpoint = `${options.origin ?? FCM_ORIGIN}/v1/projects/${encodeURIComponent(options.projectId)}/messages:send`;

  return {
    name: "fcm",
    send: async (message) => {
      const accessToken = await accessTokenFor(auth);
      const notification =
        message.title === undefined
          ? { body: message.body }
          : { body: message.body, title: message.title };
      const data = stringData(message.data);
      const android = objectMetadata(message.metadata, "android");
      const apns = objectMetadata(message.metadata, "apns");
      const webpush = objectMetadata(message.metadata, "webpush");
      const response = await request(endpoint, {
        body: JSON.stringify({
          message: {
            ...targetFor(message),
            ...(android ? { android } : {}),
            ...(apns ? { apns } : {}),
            ...(data ? { data } : {}),
            notification,
            ...(webpush ? { webpush } : {}),
          },
          ...(message.metadata?.validateOnly === true
            ? { validate_only: true }
            : {}),
        }),
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        method: "POST",
      });
      if (!response.ok) throw await responseError(response);
      const result = (await response.json()) as { name?: string };

      return {
        at: Date.now(),
        ...(result.name ? { id: result.name } : {}),
        provider: "fcm",
      };
    },
  };
};
