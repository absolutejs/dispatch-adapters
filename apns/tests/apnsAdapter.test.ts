import { generateKeyPairSync } from "node:crypto";
import { createDispatcher } from "@absolutejs/dispatch";
import { describe, expect, test } from "bun:test";
import { createApnsAdapter, type ApnsTransportRequest } from "../src";

const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({
    format: "pem",
    type: "pkcs8",
  })
  .toString();

describe("APNs push adapter", () => {
  test("sends the native HTTP/2 request and reuses a current provider token", async () => {
    const requests: ApnsTransportRequest[] = [];
    let now = 1_700_000_000_000;
    const adapter = createApnsAdapter({
      bundleId: "com.absolute.site",
      clock: () => now,
      keyId: "ABC123DEFG",
      privateKey,
      teamId: "DEF123GHIJ",
      transport: {
        send: async (request) => {
          requests.push(request);

          return {
            body: "",
            headers: { "apns-id": "notification-id" },
            status: 200,
          };
        },
      },
    });
    const dispatcher = createDispatcher({ push: adapter });
    const result = await dispatcher.push({
      body: "Build completed",
      data: { projectId: "project-1" },
      metadata: { badge: 2, sound: "default" },
      title: "Deployment ready",
      to: "device-token",
    });
    now += 20 * 60 * 1_000;
    await dispatcher.push({ body: "Still healthy", to: "device-token" });

    expect(result).toMatchObject({ id: "notification-id", provider: "apns" });
    expect(requests[0]).toMatchObject({
      origin: "https://api.push.apple.com",
      path: "/3/device/device-token",
    });
    expect(JSON.parse(requests[0]!.payload)).toEqual({
      aps: {
        alert: { body: "Build completed", title: "Deployment ready" },
        badge: 2,
        sound: "default",
      },
      projectId: "project-1",
    });
    expect(requests[1]?.headers.authorization).toBe(
      requests[0]?.headers.authorization,
    );
  });

  test("rotates provider tokens and normalizes APNs failures", async () => {
    const tokens: string[] = [];
    let now = 1_700_000_000_000;
    const adapter = createApnsAdapter({
      bundleId: "com.absolute.site",
      clock: () => now,
      environment: "sandbox",
      keyId: "ABC123DEFG",
      privateKey,
      teamId: "DEF123GHIJ",
      transport: {
        send: async (request) => {
          const authorization = request.headers.authorization;
          if (!authorization)
            throw new Error("APNs authorization header is missing");
          tokens.push(authorization);

          return {
            body: JSON.stringify({ reason: "BadDeviceToken" }),
            headers: { "apns-id": "failed-id" },
            status: 400,
          };
        },
      },
    });

    await expect(
      adapter.send({ body: "First", to: "bad-token" }),
    ).rejects.toMatchObject({ reason: "BadDeviceToken", status: 400 });
    now += 51 * 60 * 1_000;
    await expect(
      adapter.send({ body: "Second", to: "bad-token" }),
    ).rejects.toBeInstanceOf(Error);
    expect(tokens[1]).not.toBe(tokens[0]);
  });
});
