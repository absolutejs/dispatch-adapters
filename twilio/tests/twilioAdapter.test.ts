import { describe, expect, test } from "bun:test";
import { createDispatcher } from "@absolutejs/dispatch";
import { Twilio } from "twilio";
import {
  createTwilioAdapter,
  createMemoryTwilioIdempotencyStore,
  TwilioConfigurationError,
  TwilioSendError,
  type TwilioClientLike,
} from "../src";

const SERVICE_SID = "MG0123456789abcdef0123456789abcdef";
const CALLBACK = "https://app.example.com/webhooks/twilio/messaging";

test("manifest wiring uses the current Twilio SDK constructor export", () => {
  expect(typeof Twilio).toBe("function");
});

const makeMockTwilio = () => {
  const calls: Array<Parameters<TwilioClientLike["messages"]["create"]>[0]> =
    [];
  let response: Awaited<ReturnType<TwilioClientLike["messages"]["create"]>> = {
    sid: "SM0123456789abcdef0123456789abcdef",
    status: "queued",
  };
  let failure: Error | undefined;
  const client: TwilioClientLike = {
    messages: {
      create: async (params) => {
        calls.push(params);
        if (failure !== undefined) throw failure;
        return response;
      },
    },
  };
  return {
    calls,
    client,
    failWith: (error: Error) => {
      failure = error;
    },
    respondWith: (next: typeof response) => {
      response = next;
    },
  };
};

const createAdapter = (client: TwilioClientLike) =>
  createTwilioAdapter({
    client,
    messagingServiceSid: SERVICE_SID,
    statusCallbackUrl: CALLBACK,
  });

describe("createTwilioAdapter", () => {
  test("always sends through the configured Messaging Service and callback", async () => {
    const mock = makeMockTwilio();
    const dispatcher = createDispatcher({ sms: createAdapter(mock.client) });
    const result = await dispatcher.sms({
      body: "Pro alert",
      to: "+12025550100",
    });

    expect(mock.calls).toEqual([
      {
        body: "Pro alert",
        messagingServiceSid: SERVICE_SID,
        statusCallback: CALLBACK,
        to: "+12025550100",
      },
    ]);
    expect(result).toMatchObject({
      id: expect.stringMatching(/^SM/),
      provider: "twilio",
    });
  });

  test("pins a per-message sender while retaining Messaging Service policy", async () => {
    const mock = makeMockTwilio();
    const dispatcher = createDispatcher({ sms: createAdapter(mock.client) });
    await dispatcher.sms({
      body: "Pro alert",
      from: "+12025550199",
      to: "+12025550100",
    });
    expect(mock.calls[0]).toMatchObject({
      from: "+12025550199",
      messagingServiceSid: SERVICE_SID,
    });
  });

  test("passes operational send controls", async () => {
    const mock = makeMockTwilio();
    const adapter = createTwilioAdapter({
      client: mock.client,
      messagingServiceSid: SERVICE_SID,
      smartEncoded: true,
      statusCallbackUrl: CALLBACK,
      validityPeriod: 300,
    });
    await adapter.send({ body: "alert", to: "+12025550100" });
    expect(mock.calls[0]).toMatchObject({
      smartEncoded: true,
      validityPeriod: 300,
    });
  });

  test("sends media, templates, schedules, and tenant-routed WhatsApp", async () => {
    const base = makeMockTwilio();
    const tenant = makeMockTwilio();
    const tenantServiceSid = `MG${"9".repeat(32)}`;
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const adapter = createTwilioAdapter({
      client: base.client,
      messagingServiceSid: SERVICE_SID,
      resolveTenant: () => ({
        client: tenant.client,
        messagingServiceSid: tenantServiceSid,
      }),
      statusCallbackUrl: CALLBACK,
    });
    await adapter.send({
      channel: "whatsapp",
      mediaUrls: ["https://cdn.example.com/image.jpg"],
      sendAt,
      template: {
        id: `HX${"8".repeat(32)}`,
        variables: { "1": "Alex" },
      },
      tenant: "tenant-1",
      to: "whatsapp:+12025550100",
    });
    expect(base.calls).toHaveLength(0);
    expect(tenant.calls[0]).toMatchObject({
      contentSid: `HX${"8".repeat(32)}`,
      contentVariables: JSON.stringify({ "1": "Alex" }),
      mediaUrl: ["https://cdn.example.com/image.jpg"],
      messagingServiceSid: tenantServiceSid,
      scheduleType: "fixed",
      to: "whatsapp:+12025550100",
    });
    expect(tenant.calls[0]?.sendAt?.toISOString()).toBe(sendAt);
  });

  test("deduplicates retry-safe sends with an atomic idempotency store", async () => {
    const mock = makeMockTwilio();
    const adapter = createTwilioAdapter({
      client: mock.client,
      idempotencyStore: createMemoryTwilioIdempotencyStore(),
      messagingServiceSid: SERVICE_SID,
      statusCallbackUrl: CALLBACK,
    });
    const message = {
      body: "once",
      idempotencyKey: "alert:incident-1:user-1",
      to: "+12025550100",
    };
    const first = await adapter.send(message);
    const retry = await adapter.send(message);
    expect(retry).toEqual(first);
    expect(mock.calls).toHaveLength(1);
  });

  test.each([
    ["invalid service SID", { messagingServiceSid: "MG_bad" }],
    ["insecure callback", { statusCallbackUrl: "http://example.com/hook" }],
    ["invalid validity", { validityPeriod: 0 }],
  ])("rejects %s at construction", (_name, changed) => {
    const mock = makeMockTwilio();
    expect(() =>
      createTwilioAdapter({
        client: mock.client,
        messagingServiceSid: SERVICE_SID,
        statusCallbackUrl: CALLBACK,
        ...changed,
      }),
    ).toThrow(TwilioConfigurationError);
  });

  test.each([
    [{ body: "alert", to: "2025550100" }, "recipient"],
    [{ body: "alert", from: "sender", to: "+12025550100" }, "sender"],
    [{ body: "  ", to: "+12025550100" }, "body"],
  ])("rejects malformed outbound messages", async (message, expected) => {
    const mock = makeMockTwilio();
    await expect(createAdapter(mock.client).send(message)).rejects.toThrow(
      expected,
    );
    expect(mock.calls).toHaveLength(0);
  });

  test("propagates SDK failures through dispatch observability", async () => {
    const mock = makeMockTwilio();
    mock.failWith(new Error("rate limited"));
    const dispatcher = createDispatcher({
      onError: () => {},
      sms: createAdapter(mock.client),
    });
    await expect(
      dispatcher.sms({ body: "alert", to: "+12025550100" }),
    ).rejects.toThrow("rate limited");
    expect(dispatcher.metrics().failed).toBe(1);
  });

  test("turns response-level Twilio errors into a typed failure", async () => {
    const mock = makeMockTwilio();
    mock.respondWith({
      errorCode: 21610,
      errorMessage: "Recipient unsubscribed",
    });
    await expect(
      createAdapter(mock.client).send({ body: "alert", to: "+12025550100" }),
    ).rejects.toBeInstanceOf(TwilioSendError);
  });
});
