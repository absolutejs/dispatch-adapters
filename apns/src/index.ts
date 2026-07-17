import { createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { PushAdapter } from "@absolutejs/dispatch";

const PRODUCTION_ORIGIN = "https://api.push.apple.com";
const SANDBOX_ORIGIN = "https://api.development.push.apple.com";
const TOKEN_REFRESH_SECONDS = 50 * 60;
const MAX_PAYLOAD_BYTES = 4_096;

export type ApnsTransportRequest = {
  headers: Record<string, string>;
  origin: string;
  path: string;
  payload: string;
};

export type ApnsTransportResponse = {
  body: string;
  headers: Record<string, string | undefined>;
  status: number;
};

export type ApnsTransport = {
  close?: () => void;
  send: (request: ApnsTransportRequest) => Promise<ApnsTransportResponse>;
};

export type CreateApnsAdapterOptions = {
  bundleId: string;
  keyId: string;
  privateKey: string;
  teamId: string;
  environment?: "production" | "sandbox";
  transport?: ApnsTransport;
  clock?: () => number;
};

export type ApnsAdapter = PushAdapter & { dispose: () => void };

export class ApnsDispatchError extends Error {
  readonly apnsId?: string;
  readonly reason?: string;
  readonly status: number;
  readonly timestamp?: number;

  constructor(input: {
    apnsId?: string;
    message: string;
    reason?: string;
    status: number;
    timestamp?: number;
  }) {
    super(input.message);
    this.name = "ApnsDispatchError";
    this.apnsId = input.apnsId;
    this.reason = input.reason;
    this.status = input.status;
    this.timestamp = input.timestamp;
  }
}

const base64Url = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");

export const createApnsProviderToken = (input: {
  issuedAt: number;
  keyId: string;
  privateKey: string;
  teamId: string;
}) => {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const claims = base64Url(
    JSON.stringify({ iat: input.issuedAt, iss: input.teamId }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    dsaEncoding: "ieee-p1363",
    key: createPrivateKey(input.privateKey),
  });

  return `${unsigned}.${base64Url(signature)}`;
};

const headerStrings = (headers: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.join(",")
        : value === undefined
          ? undefined
          : String(value),
    ]),
  );

export const createApnsHttp2Transport = (): ApnsTransport => {
  const sessions = new Map<string, ClientHttp2Session>();
  const sessionFor = (origin: string) => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    session.once("close", () => sessions.delete(origin));
    session.once("error", () => sessions.delete(origin));
    session.once("goaway", () => session.close());
    sessions.set(origin, session);

    return session;
  };

  return {
    close: () => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
    send: (request) =>
      new Promise((resolve, reject) => {
        const stream = sessionFor(request.origin).request({
          ":method": "POST",
          ":path": request.path,
          ...request.headers,
        });
        let body = "";
        let responseHeaders: Record<string, unknown> = {};
        stream.setEncoding("utf8");
        stream.on("response", (headers) => {
          responseHeaders = headers;
        });
        stream.on("data", (chunk: string) => {
          body += chunk;
        });
        stream.once("error", reject);
        stream.once("end", () => {
          const headers = headerStrings(responseHeaders);
          resolve({
            body,
            headers,
            status: Number(responseHeaders[":status"] ?? 0),
          });
        });
        stream.end(request.payload);
      }),
  };
};

const numberMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const stringMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];

  return typeof value === "string" && value ? value : undefined;
};

const responseError = (response: ApnsTransportResponse) => {
  let payload: { reason?: string; timestamp?: number } = {};
  try {
    payload = JSON.parse(response.body) as typeof payload;
  } catch {
    payload = {};
  }
  const apnsId = response.headers["apns-id"];

  return new ApnsDispatchError({
    ...(apnsId ? { apnsId } : {}),
    message: payload.reason
      ? `[dispatch-apns] ${payload.reason}`
      : `[dispatch-apns] APNs request failed with HTTP ${response.status}`,
    ...(payload.reason ? { reason: payload.reason } : {}),
    status: response.status,
    ...(payload.timestamp ? { timestamp: payload.timestamp } : {}),
  });
};

export const createApnsAdapter = (
  options: CreateApnsAdapterOptions,
): ApnsAdapter => {
  for (const [name, value] of Object.entries({
    bundleId: options.bundleId,
    keyId: options.keyId,
    privateKey: options.privateKey,
    teamId: options.teamId,
  }))
    if (!value.trim()) throw new Error(`[dispatch-apns] ${name} is required`);
  const transport = options.transport ?? createApnsHttp2Transport();
  const clock = options.clock ?? Date.now;
  const origin =
    options.environment === "sandbox" ? SANDBOX_ORIGIN : PRODUCTION_ORIGIN;
  let cachedToken: { issuedAt: number; value: string } | undefined;
  const providerToken = () => {
    const issuedAt = Math.floor(clock() / 1_000);
    if (cachedToken && issuedAt - cachedToken.issuedAt < TOKEN_REFRESH_SECONDS)
      return cachedToken.value;
    cachedToken = {
      issuedAt,
      value: createApnsProviderToken({
        issuedAt,
        keyId: options.keyId,
        privateKey: options.privateKey,
        teamId: options.teamId,
      }),
    };

    return cachedToken.value;
  };

  return {
    dispose: () => transport.close?.(),
    name: "apns",
    send: async (message) => {
      const metadata = message.metadata;
      const contentAvailable = metadata?.contentAvailable === true;
      const mutableContent = metadata?.mutableContent === true;
      const pushType =
        stringMetadata(metadata, "pushType") ??
        (contentAvailable ? "background" : "alert");
      const priority =
        numberMetadata(metadata, "priority") ??
        (pushType === "background" ? 5 : 10);
      if (priority !== 5 && priority !== 10)
        throw new Error("[dispatch-apns] priority must be 5 or 10");
      const aps = {
        ...(pushType === "background"
          ? {}
          : {
              alert:
                message.title === undefined
                  ? { body: message.body }
                  : { body: message.body, title: message.title },
            }),
        ...(numberMetadata(metadata, "badge") !== undefined
          ? { badge: numberMetadata(metadata, "badge") }
          : {}),
        ...(stringMetadata(metadata, "category")
          ? { category: stringMetadata(metadata, "category") }
          : {}),
        ...(contentAvailable ? { "content-available": 1 } : {}),
        ...(mutableContent ? { "mutable-content": 1 } : {}),
        ...(stringMetadata(metadata, "sound")
          ? { sound: stringMetadata(metadata, "sound") }
          : {}),
        ...(stringMetadata(metadata, "threadId")
          ? { "thread-id": stringMetadata(metadata, "threadId") }
          : {}),
      };
      const payload = JSON.stringify({ ...(message.data ?? {}), aps });
      if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES)
        throw new Error(
          `[dispatch-apns] payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
        );
      const response = await transport.send({
        headers: {
          authorization: `bearer ${providerToken()}`,
          "apns-priority": String(priority),
          "apns-push-type": pushType,
          "apns-topic": options.bundleId,
          ...(stringMetadata(metadata, "collapseId")
            ? { "apns-collapse-id": stringMetadata(metadata, "collapseId")! }
            : {}),
          ...(numberMetadata(metadata, "expiration") !== undefined
            ? {
                "apns-expiration": String(
                  numberMetadata(metadata, "expiration"),
                ),
              }
            : {}),
          ...(stringMetadata(metadata, "id")
            ? { "apns-id": stringMetadata(metadata, "id")! }
            : {}),
        },
        origin,
        path: `/3/device/${encodeURIComponent(message.to)}`,
        payload,
      });
      if (response.status !== 200) throw responseError(response);

      return {
        at: clock(),
        ...(response.headers["apns-id"]
          ? { id: response.headers["apns-id"] }
          : {}),
        provider: "apns",
      };
    },
  };
};
