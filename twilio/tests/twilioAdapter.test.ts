import { describe, expect, test } from "bun:test";
import { createDispatcher, type MessagingMessage } from "@absolutejs/dispatch";
import { Twilio } from "twilio";
import {
  createTwilioAdapter,
  createTwilioScheduledMessageManager,
  createMemoryTwilioIdempotencyStore,
  TwilioConfigurationError,
  TwilioIdempotencyConflictError,
  TwilioIdempotencyIndeterminateError,
  TwilioSendError,
  type TwilioClientLike,
} from "../src";

const SERVICE_SID = "MG0123456789abcdef0123456789abcdef";
const ACCOUNT_SID = `AC${"0".repeat(32)}`;
const CALLBACK = "https://app.example.com/webhooks/twilio/messaging";
const textMessage = (
  text: string,
  input: Partial<MessagingMessage> = {},
): MessagingMessage => ({
  content: { kind: "text", text },
  to: { address: "+12025550100", transport: "sms" },
  ...input,
});

test("manifest wiring uses the current Twilio SDK constructor export", () => {
  expect(typeof Twilio).toBe("function");
});

test("cancels and reconciles explicitly scheduled messages", async () => {
  const messageSid = `MM${"7".repeat(32)}`;
  const updates: unknown[] = [];
  const manager = createTwilioScheduledMessageManager({
    messages: (sid) => ({
      fetch: async () => ({ sid, status: "scheduled" }),
      update: async (input) => {
        updates.push(input);
        return { sid, status: "canceled" };
      },
    }),
  });
  expect(await manager.inspect(messageSid)).toMatchObject({
    messageId: messageSid,
    providerStatus: "scheduled",
    state: "pending",
  });
  expect(await manager.cancel(messageSid)).toMatchObject({
    state: "canceled",
  });
  expect(updates).toEqual([{ status: "canceled" }]);
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
    accountSid: ACCOUNT_SID,
    client,
    messagingServiceSid: SERVICE_SID,
    statusCallbackUrl: CALLBACK,
  });

describe("createTwilioAdapter", () => {
  test("always sends through the configured Messaging Service and callback", async () => {
    const mock = makeMockTwilio();
    const dispatcher = createDispatcher({
      messaging: createAdapter(mock.client),
    });
    const result = await dispatcher.messaging(textMessage("Pro alert"));

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
    const dispatcher = createDispatcher({
      messaging: createAdapter(mock.client),
    });
    await dispatcher.messaging(
      textMessage("Pro alert", {
        from: { address: "+12025550199", transport: "sms" },
      }),
    );
    expect(mock.calls[0]).toMatchObject({
      from: "+12025550199",
      messagingServiceSid: SERVICE_SID,
    });
  });

  test("passes operational send controls", async () => {
    const mock = makeMockTwilio();
    const adapter = createTwilioAdapter({
      accountSid: ACCOUNT_SID,
      client: mock.client,
      messagingServiceSid: SERVICE_SID,
      smartEncoded: true,
      statusCallbackUrl: CALLBACK,
      validityPeriod: 300,
    });
    await adapter.send(textMessage("alert"));
    expect(mock.calls[0]).toMatchObject({
      smartEncoded: true,
      validityPeriod: 300,
    });
  });

  test("sends RCS with automatic SMS fallback", async () => {
    const mock = makeMockTwilio();
    const adapter = createAdapter(mock.client);
    await adapter.send(
      textMessage("Rich alert", {
        fallbacks: [
          {
            from: { address: "+12025550199", transport: "sms" },
            transport: "sms",
          },
        ],
        to: { address: "+12025550100", transport: "rcs" },
      }),
    );
    expect(mock.calls[0]).toMatchObject({
      fallbackFrom: "+12025550199",
      to: "+12025550100",
    });
  });

  test("can require RCS without SMS fallback", async () => {
    const mock = makeMockTwilio();
    const adapter = createAdapter(mock.client);
    await adapter.send(
      textMessage("Rich alert", {
        to: { address: "+12025550100", transport: "rcs" },
      }),
    );
    expect(mock.calls[0]?.to).toBe("rcs:+12025550100");
  });

  test("sends templates, schedules, and tenant-routed WhatsApp", async () => {
    const base = makeMockTwilio();
    const tenant = makeMockTwilio();
    const tenantServiceSid = `MG${"9".repeat(32)}`;
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const adapter = createTwilioAdapter({
      accountSid: ACCOUNT_SID,
      allowNativeScheduling: true,
      client: base.client,
      messagingServiceSid: SERVICE_SID,
      resolveTenant: () => ({
        accountSid: `AC${"9".repeat(32)}`,
        client: tenant.client,
        messagingServiceSid: tenantServiceSid,
      }),
      statusCallbackUrl: CALLBACK,
    });
    await adapter.send({
      content: {
        id: `HX${"8".repeat(32)}`,
        kind: "template",
        variables: { "1": "Alex" },
      },
      sendAt,
      tenant: "tenant-1",
      to: { address: "+12025550100", transport: "whatsapp" },
    });
    expect(base.calls).toHaveLength(0);
    expect(tenant.calls[0]).toMatchObject({
      contentSid: `HX${"8".repeat(32)}`,
      contentVariables: JSON.stringify({ "1": "Alex" }),
      messagingServiceSid: tenantServiceSid,
      scheduleType: "fixed",
      to: "whatsapp:+12025550100",
    });
    expect(tenant.calls[0]?.sendAt?.toISOString()).toBe(sendAt);
  });

  test("sends MMS media without a ContentSid", async () => {
    const mock = makeMockTwilio();
    await createAdapter(mock.client).send({
      content: {
        kind: "media",
        mediaUrls: ["https://cdn.example.com/image.jpg"],
      },
      to: { address: "+12025550100", transport: "mms" },
    });
    expect(mock.calls[0]).toMatchObject({
      mediaUrl: ["https://cdn.example.com/image.jpg"],
    });
  });

  test("deduplicates retry-safe sends with an atomic idempotency store", async () => {
    const mock = makeMockTwilio();
    const adapter = createTwilioAdapter({
      accountSid: ACCOUNT_SID,
      client: mock.client,
      idempotencyStore: createMemoryTwilioIdempotencyStore(),
      messagingServiceSid: SERVICE_SID,
      statusCallbackUrl: CALLBACK,
    });
    const message = textMessage("once", {
      idempotencyKey: "alert:incident-1:user-1",
    });
    const first = await adapter.send(message);
    const retry = await adapter.send(message);
    expect(retry).toEqual(first);
    expect(mock.calls).toHaveLength(1);
  });

  test("rejects idempotency key reuse with a different payload", async () => {
    const mock = makeMockTwilio();
    const adapter = createTwilioAdapter({
      accountSid: ACCOUNT_SID,
      client: mock.client,
      idempotencyStore: createMemoryTwilioIdempotencyStore(),
      messagingServiceSid: SERVICE_SID,
      statusCallbackUrl: CALLBACK,
    });
    await adapter.send(textMessage("first", { idempotencyKey: "operation-1" }));
    await expect(
      adapter.send(textMessage("changed", { idempotencyKey: "operation-1" })),
    ).rejects.toBeInstanceOf(TwilioIdempotencyConflictError);
    expect(mock.calls).toHaveLength(1);
  });

  test("fails closed when a provider call has an indeterminate outcome", async () => {
    const mock = makeMockTwilio();
    mock.failWith(new Error("connection reset after write"));
    const adapter = createTwilioAdapter({
      accountSid: ACCOUNT_SID,
      client: mock.client,
      idempotencyStore: createMemoryTwilioIdempotencyStore(),
      messagingServiceSid: SERVICE_SID,
      statusCallbackUrl: CALLBACK,
    });
    const message = textMessage("once", {
      idempotencyKey: "operation-2",
    });
    await expect(adapter.send(message)).rejects.toThrow("connection reset");
    await expect(adapter.send(message)).rejects.toBeInstanceOf(
      TwilioIdempotencyIndeterminateError,
    );
    expect(mock.calls).toHaveLength(1);
  });

  test("passes explicit Twilio address and content retention controls", async () => {
    const mock = makeMockTwilio();
    await createAdapter(mock.client).send(
      textMessage("sensitive alert", {
        privacy: {
          addressRetention: "obfuscate",
          contentRetention: "discard",
        },
      }),
    );
    expect(mock.calls[0]).toMatchObject({
      addressRetention: "obfuscate",
      contentRetention: "discard",
    });
  });

  test("rejects provider-incompatible fallback content", async () => {
    const mock = makeMockTwilio();
    await expect(
      createAdapter(mock.client).send(
        textMessage("alert", {
          consent: {
            programId: "alerts",
            purpose: "incident-alerts",
          },
          fallbacks: [
            {
              content: { kind: "text", text: "different" },
              transport: "sms",
            },
          ],
          to: { address: "+12025550100", transport: "rcs" },
        }),
      ),
    ).rejects.toThrow("fallback content");
  });

  test("disables native scheduling unless explicitly enabled", async () => {
    const mock = makeMockTwilio();
    await expect(
      createAdapter(mock.client).send(
        textMessage("later", {
          sendAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      ),
    ).rejects.toThrow("native scheduling is disabled");
  });

  test.each([
    ["invalid service SID", { messagingServiceSid: "MG_bad" }],
    ["insecure callback", { statusCallbackUrl: "http://example.com/hook" }],
    ["invalid validity", { validityPeriod: 0 }],
  ])("rejects %s at construction", (_name, changed) => {
    const mock = makeMockTwilio();
    expect(() =>
      createTwilioAdapter({
        accountSid: ACCOUNT_SID,
        client: mock.client,
        messagingServiceSid: SERVICE_SID,
        statusCallbackUrl: CALLBACK,
        ...changed,
      }),
    ).toThrow(TwilioConfigurationError);
  });

  test.each<[MessagingMessage, string]>([
    [
      textMessage("alert", { to: { address: "2025550100", transport: "sms" } }),
      "recipient",
    ],
    [
      textMessage("alert", {
        from: { address: "sender", transport: "sms" },
      }),
      "sender",
    ],
    [textMessage("  "), "body"],
    [
      textMessage("alert", {
        from: { address: "+12025550199", transport: "rcs" },
        to: { address: "+12025550100", transport: "rcs" },
      }),
      "RCS sender",
    ],
    [
      textMessage("alert", {
        from: { address: "+12025550199", transport: "whatsapp" },
      }),
      "transport",
    ],
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
      messaging: createAdapter(mock.client),
    });
    await expect(dispatcher.messaging(textMessage("alert"))).rejects.toThrow(
      "rate limited",
    );
    expect(dispatcher.metrics().failed).toBe(1);
  });

  test("turns response-level Twilio errors into a typed failure", async () => {
    const mock = makeMockTwilio();
    mock.respondWith({
      errorCode: 21610,
      errorMessage: "Recipient unsubscribed",
    });
    await expect(
      createAdapter(mock.client).send(textMessage("alert")),
    ).rejects.toBeInstanceOf(TwilioSendError);
  });
});
