import { describe, expect, test } from "bun:test";
import { Vonage } from "@vonage/server-sdk";
import { createDispatcher, type MessagingMessage } from "@absolutejs/dispatch";
import {
  createMemoryIdempotentOperationStore,
  createVonageAdapter,
  VonageConfigurationError,
  VonageIdempotencyConflictError,
  VonageIdempotencyIndeterminateError,
  type VonageClientLike,
} from "../src";

const WEBHOOK = "https://app.example.com/webhooks/vonage/messages";
const text = (
  value: string,
  input: Partial<MessagingMessage> = {},
): MessagingMessage => ({
  content: { kind: "text", text: value },
  to: { address: "+12025550100", transport: "sms" },
  ...input,
});

const mockClient = () => {
  const calls: Array<Record<string, unknown>> = [];
  let failure: Error | undefined;
  const client = {
    messages: {
      send: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        if (failure !== undefined) throw failure;
        return { messageUUID: "message-1" };
      },
    },
  } as unknown as VonageClientLike;
  return {
    calls,
    client,
    fail: (error: Error) => {
      failure = error;
    },
  };
};

test("accepts the current official Vonage SDK client", () => {
  const official: VonageClientLike = new Vonage({
    applicationId: "00000000-0000-4000-8000-000000000001",
    privateKey: "synthetic-test-key",
  });
  expect(typeof official.messages.send).toBe("function");
});

describe("createVonageAdapter", () => {
  test("sends RCS rich content with ordered SMS failover", async () => {
    const mock = mockClient();
    const adapter = createVonageAdapter({
      apiKey: "api-key",
      client: mock.client,
      defaultFrom: { rcs: "agent-1", sms: "+12025550199" },
      webhookUrl: WEBHOOK,
    });
    const result = await adapter.send({
      content: {
        actions: [{ kind: "reply", label: "Ack", payload: "ack:42" }],
        kind: "rich",
        mediaUrl: "https://cdn.example.com/incident.png",
        text: "Database latency is elevated",
        title: "Incident 42",
      },
      fallbacks: [
        {
          content: { kind: "text", text: "Database latency is elevated" },
          transport: "sms",
        },
      ],
      to: { address: "+12025550100", transport: "rcs" },
    });
    expect(mock.calls[0]).toMatchObject({
      channel: "rcs",
      failover: [{ channel: "sms", message_type: "text" }],
      message_type: "card",
      webhook_version: "v1",
    });
    expect(result).toMatchObject({
      delivery: { actualTransport: "rcs", requestedTransport: "rcs" },
      id: "message-1",
      provider: "vonage",
    });
  });

  test("supports adapter-owned Viber transport and tenant isolation", async () => {
    const primary = mockClient();
    const tenant = mockClient();
    const adapter = createVonageAdapter({
      apiKey: "primary-key",
      client: primary.client,
      defaultFrom: { viber: "primary" },
      resolveTenant: () => ({
        apiKey: "tenant-key",
        client: tenant.client,
        defaultFrom: { viber: "tenant-brand" },
      }),
      webhookUrl: WEBHOOK,
    });
    await adapter.send({
      content: { kind: "text", text: "hello" },
      tenant: "tenant-a",
      to: { address: "recipient-id", transport: "viber" },
    });
    expect(primary.calls).toHaveLength(0);
    expect(tenant.calls[0]).toMatchObject({
      channel: "viber",
      from: "tenant-brand",
      to: "recipient-id",
    });
  });

  test("deduplicates scoped sends and rejects payload reuse", async () => {
    const mock = mockClient();
    const adapter = createVonageAdapter({
      apiKey: "api-key",
      client: mock.client,
      defaultFrom: { sms: "+12025550199" },
      idempotencyStore: createMemoryIdempotentOperationStore(),
      webhookUrl: WEBHOOK,
    });
    const first = text("alert", { idempotencyKey: "incident-42" });
    expect((await adapter.send(first)).id).toBe("message-1");
    expect((await adapter.send(first)).id).toBe("message-1");
    expect(mock.calls).toHaveLength(1);
    await expect(
      adapter.send(text("changed", { idempotencyKey: "incident-42" })),
    ).rejects.toBeInstanceOf(VonageIdempotencyConflictError);
  });

  test("fails closed after an ambiguous provider call", async () => {
    const mock = mockClient();
    mock.fail(new Error("connection reset after write"));
    const adapter = createVonageAdapter({
      apiKey: "api-key",
      client: mock.client,
      defaultFrom: { sms: "+12025550199" },
      idempotencyStore: createMemoryIdempotentOperationStore(),
      webhookUrl: WEBHOOK,
    });
    const message = text("alert", { idempotencyKey: "incident-43" });
    await expect(adapter.send(message)).rejects.toThrow("connection reset");
    await expect(adapter.send(message)).rejects.toBeInstanceOf(
      VonageIdempotencyIndeterminateError,
    );
    expect(mock.calls).toHaveLength(1);
  });

  test("rejects missing senders, native schedules, and unsafe extensions", async () => {
    const mock = mockClient();
    const adapter = createVonageAdapter({
      apiKey: "api-key",
      client: mock.client,
      webhookUrl: WEBHOOK,
    });
    await expect(adapter.send(text("alert"))).rejects.toBeInstanceOf(
      VonageConfigurationError,
    );
    await expect(
      adapter.send(text("later", { sendAt: new Date().toISOString() })),
    ).rejects.toThrow("does not provide native scheduling");
    await expect(
      adapter.send({
        content: {
          extensions: { vonage: { to: "attacker" } },
          kind: "rich",
          text: "alert",
        },
        from: { address: "agent", transport: "rcs" },
        to: { address: "+12025550100", transport: "rcs" },
      }),
    ).rejects.toThrow("cannot override to");
  });

  test("runs through Dispatch with normalized delivery results", async () => {
    const mock = mockClient();
    const dispatch = createDispatcher({
      messaging: createVonageAdapter({
        apiKey: "api-key",
        client: mock.client,
        defaultFrom: { sms: "+12025550199" },
        webhookUrl: WEBHOOK,
      }),
    });
    expect((await dispatch.messaging(text("hello"))).provider).toBe("vonage");
  });
});
