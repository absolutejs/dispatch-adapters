import { describe, expect, test } from "bun:test";
import { createDispatcher, type MessagingMessage } from "@absolutejs/dispatch";
import { createMemoryIdempotentOperationStore } from "@absolutejs/reliability";
import { Telnyx } from "telnyx";
import {
  checkTelnyxRcsCapabilities,
  createTelnyxAdapter,
  createTelnyxScheduledMessageManager,
  TelnyxConfigurationError,
  TelnyxIdempotencyConflictError,
  TelnyxIdempotencyIndeterminateError,
  type TelnyxClientLike,
  type TelnyxRcsMessageParams,
  type TelnyxStandardMessageParams,
} from "../src";

const PROFILE = "4000eba1-a0c0-4562-b3fc-2c963f66afa6";
const WEBHOOK = "https://app.example.com/webhooks/telnyx/messaging";
const text = (
  value: string,
  input: Partial<MessagingMessage> = {},
): MessagingMessage => ({
  content: { kind: "text", text: value },
  to: { address: "+12025550100", transport: "sms" },
  ...input,
});

const mockClient = () => {
  const standard: TelnyxStandardMessageParams[] = [];
  const scheduled: TelnyxStandardMessageParams[] = [];
  const rcs: TelnyxRcsMessageParams[] = [];
  let failure: Error | undefined;
  const client: TelnyxClientLike = {
    messages: {
      cancelScheduled: async (id) => ({ data: { id } }),
      rcs: {
        send: async (params) => {
          rcs.push(params);
          if (failure !== undefined) throw failure;
          return { data: { id: "rcs-1", type: "RCS" } };
        },
      },
      retrieve: async (id) => ({ data: { id, status: "scheduled" } }),
      schedule: async (params) => {
        scheduled.push(params);
        if (failure !== undefined) throw failure;
        return { data: { id: "scheduled-1", type: params.type } };
      },
      send: async (params) => {
        standard.push(params);
        if (failure !== undefined) throw failure;
        return { data: { id: "message-1", type: params.type } };
      },
    },
    messaging: {
      rcs: {
        retrieveCapabilities: async (phoneNumber, params) => ({
          data: {
            agent_id: params.agent_id,
            features: ["RICHCARD_STANDALONE", "ACTION_OPEN_URL"],
            phone_number: phoneNumber,
          },
        }),
      },
    },
  };
  return {
    client,
    fail: (error: Error) => {
      failure = error;
    },
    rcs,
    scheduled,
    standard,
  };
};

const adapter = (
  client: TelnyxClientLike,
  extra: Partial<Parameters<typeof createTelnyxAdapter>[0]> = {},
) =>
  createTelnyxAdapter({
    accountId: "org-1",
    client,
    messagingProfileId: PROFILE,
    rcsAgentId: "agent-1",
    webhookUrl: WEBHOOK,
    ...extra,
  });

test("uses the current official Telnyx SDK constructor", () => {
  expect(typeof Telnyx).toBe("function");
  const client: TelnyxClientLike = new Telnyx({ apiKey: "KEY_test" });
  expect(client.messages.send).toBeFunction();
  expect(client.messages.rcs.send).toBeFunction();
});

describe("createTelnyxAdapter", () => {
  test("sends SMS through a Messaging Profile and dispatch observability", async () => {
    const mock = mockClient();
    const dispatcher = createDispatcher({ messaging: adapter(mock.client) });
    const result = await dispatcher.messaging(
      text("Pro alert", {
        from: { address: "+12025550199", transport: "sms" },
      }),
    );
    expect(mock.standard).toEqual([
      {
        from: "+12025550199",
        messaging_profile_id: PROFILE,
        text: "Pro alert",
        to: "+12025550100",
        type: "SMS",
        use_profile_webhooks: true,
        webhook_url: WEBHOOK,
      },
    ]);
    expect(result).toMatchObject({
      id: "message-1",
      provider: "telnyx",
      requestedTransport: "sms",
    });
  });

  test("sends MMS using exclusive media content", async () => {
    const mock = mockClient();
    await adapter(mock.client).send({
      content: {
        kind: "media",
        mediaUrls: ["https://cdn.example.com/alert.jpg"],
        subject: "Incident",
        text: "See graph",
      },
      to: { address: "+12025550100", transport: "mms" },
    });
    expect(mock.standard[0]).toMatchObject({
      media_urls: ["https://cdn.example.com/alert.jpg"],
      subject: "Incident",
      text: "See graph",
      type: "MMS",
    });
  });

  test("builds direct rich RCS cards and explicit SMS fallback", async () => {
    const mock = mockClient();
    await adapter(mock.client).send({
      content: {
        actions: [
          {
            kind: "url",
            label: "Open incident",
            url: "https://app.example.com/incidents/1",
          },
        ],
        kind: "rich",
        mediaUrl: "https://cdn.example.com/incident.jpg",
        text: "CPU is above 90%",
        title: "Production alert",
      },
      fallbacks: [
        {
          content: {
            kind: "text",
            text: "CPU is above 90%: https://app.example.com/incidents/1",
          },
          from: { address: "+12025550199", transport: "sms" },
          transport: "sms",
        },
      ],
      to: { address: "+12025550100", transport: "rcs" },
    });
    expect(mock.rcs[0]).toMatchObject({
      agent_id: "agent-1",
      messaging_profile_id: PROFILE,
      sms_fallback: {
        from: "+12025550199",
        text: expect.stringContaining("CPU"),
      },
      type: "RCS",
    });
    expect(mock.rcs[0]?.agent_message).toMatchObject({
      content_message: {
        rich_card: {
          standalone_card: {
            card_content: { title: "Production alert" },
          },
        },
      },
    });
  });

  test("checks recipient RCS capabilities", async () => {
    const mock = mockClient();
    await expect(
      checkTelnyxRcsCapabilities({
        agentId: "agent-1",
        client: mock.client,
        phoneNumber: "+12025550100",
      }),
    ).resolves.toMatchObject({ capable: true, phoneNumber: "+12025550100" });
  });

  test("routes isolated tenant configuration", async () => {
    const base = mockClient();
    const tenant = mockClient();
    await adapter(base.client, {
      resolveTenant: () => ({
        accountId: "org-tenant",
        client: tenant.client,
        messagingProfileId: "5000eba1-a0c0-4562-b3fc-2c963f66afa6",
      }),
    }).send(text("tenant alert", { tenant: "tenant-1" }));
    expect(base.standard).toHaveLength(0);
    expect(tenant.standard[0]?.messaging_profile_id).toStartWith("5000");
  });

  test("deduplicates and fingerprints scoped sends", async () => {
    const mock = mockClient();
    const target = adapter(mock.client, {
      idempotencyStore: createMemoryIdempotentOperationStore(),
    });
    const message = text("once", { idempotencyKey: "incident-1" });
    const first = await target.send(message);
    expect(await target.send(message)).toEqual(first);
    await expect(
      target.send(text("changed", { idempotencyKey: "incident-1" })),
    ).rejects.toBeInstanceOf(TelnyxIdempotencyConflictError);
    expect(mock.standard).toHaveLength(1);
  });

  test("fails closed after an indeterminate provider call", async () => {
    const mock = mockClient();
    mock.fail(new Error("connection reset after write"));
    const target = adapter(mock.client, {
      idempotencyStore: createMemoryIdempotentOperationStore(),
    });
    const message = text("once", { idempotencyKey: "incident-2" });
    await expect(target.send(message)).rejects.toThrow("connection reset");
    await expect(target.send(message)).rejects.toBeInstanceOf(
      TelnyxIdempotencyIndeterminateError,
    );
    expect(mock.standard).toHaveLength(1);
  });

  test("enforces Telnyx scheduling bounds and consent re-evaluation", async () => {
    const mock = mockClient();
    const now = Date.now();
    const target = adapter(mock.client, {
      allowNativeScheduling: true,
      now: () => now,
    });
    await target.send(
      text("later", { sendAt: new Date(now + 10 * 60_000).toISOString() }),
    );
    expect(mock.scheduled).toHaveLength(1);
    await expect(
      target.send(
        text("later", {
          consent: { programId: "alerts", purpose: "incident" },
          sendAt: new Date(now + 10 * 60_000).toISOString(),
        }),
      ),
    ).rejects.toThrow("re-evaluated");
  });

  test("rejects unsupported transports, false privacy controls, and malformed addresses", async () => {
    const mock = mockClient();
    await expect(
      adapter(mock.client).send(
        text("alert", {
          to: { address: "+12025550100", transport: "whatsapp" },
        }),
      ),
    ).rejects.toThrow("WhatsApp");
    await expect(
      adapter(mock.client).send(
        text("alert", { privacy: { contentRetention: "discard" } }),
      ),
    ).rejects.toThrow("no equivalent");
    await expect(
      adapter(mock.client).send(
        text("alert", { to: { address: "2025550100", transport: "sms" } }),
      ),
    ).rejects.toBeInstanceOf(TelnyxConfigurationError);
  });
});

test("scheduled manager inspects and cancels", async () => {
  const mock = mockClient();
  const manager = createTelnyxScheduledMessageManager(mock.client);
  await expect(manager.inspect("message-1")).resolves.toMatchObject({
    state: "pending",
  });
  await expect(manager.cancel("message-1")).resolves.toMatchObject({
    state: "canceled",
  });
});
