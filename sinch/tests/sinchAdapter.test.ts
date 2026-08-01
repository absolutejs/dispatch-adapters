import { describe, expect, test } from "bun:test";
import { SinchClient } from "@sinch/sdk-core";
import { createDispatcher } from "@absolutejs/dispatch";
import {
  createMemoryIdempotentOperationStore,
  createSinchAdapter,
  SinchConfigurationError,
  SinchIdempotencyConflictError,
  type SinchConversationClientLike,
} from "../src";

const APP_ID = "app-1";
const PROJECT_ID = "project-1";
const WEBHOOK = "https://example.com/webhooks/sinch/account-a";

test("accepts the current official Sinch SDK client", () => {
  const official: SinchConversationClientLike = new SinchClient({
    conversationRegion: "us",
    keyId: "key-id",
    keySecret: "key-secret",
    projectId: PROJECT_ID,
  });
  expect(official.conversation.messages.send).toBeFunction();
});

describe("createSinchAdapter", () => {
  test("sends a rich RCS message with ordered SMS fallback", async () => {
    const calls: unknown[] = [];
    const adapter = createSinchAdapter({
      appId: APP_ID,
      client: {
        conversation: {
          messages: {
            send: async (input: unknown) => {
              calls.push(input);
              return {
                accepted_time: new Date(1_000),
                message_id: "message-1",
              };
            },
          },
        },
      } as never,
      defaultFrom: { sms: "+12025550199" },
      projectId: PROJECT_ID,
      webhookUrl: WEBHOOK,
    });
    const result = await adapter.send({
      content: {
        actions: [
          {
            kind: "url",
            label: "Open incident",
            url: "https://example.com/i/42",
          },
          { kind: "reply", label: "Acknowledge", payload: "ack:42" },
        ],
        kind: "rich",
        mediaUrl: "https://example.com/incident.png",
        text: "Database latency is elevated.",
        title: "Production alert",
      },
      fallbacks: [{ transport: "sms" }],
      to: { address: "+12025550100", transport: "rcs" },
    });
    expect(result).toMatchObject({ id: "message-1", provider: "sinch" });
    expect(calls[0]).toMatchObject({
      sendMessageRequestBody: {
        app_id: APP_ID,
        channel_priority_order: ["RCS", "SMS"],
        channel_properties: { SMS_SENDER: "+12025550199" },
        message: { card_message: { title: "Production alert" } },
        recipient: {
          identified_by: {
            channel_identities: [
              { channel: "RCS", identity: "+12025550100" },
              { channel: "SMS", identity: "+12025550100" },
            ],
          },
        },
      },
    });
  });

  test("deduplicates project and tenant scoped sends", async () => {
    let sends = 0;
    const adapter = createSinchAdapter({
      appId: APP_ID,
      client: {
        conversation: {
          messages: {
            send: async () => ({ message_id: `message-${++sends}` }),
          },
        },
      } as never,
      idempotencyStore: createMemoryIdempotentOperationStore(),
      projectId: PROJECT_ID,
      resolveTenant: (tenant) => ({
        appId: `${tenant}-app`,
        projectId: `${tenant}-project`,
      }),
      webhookUrl: WEBHOOK,
    });
    const message = {
      content: { kind: "text" as const, text: "Alert" },
      idempotencyKey: "incident-42",
      tenant: "tenant-a",
      to: { address: "+12025550100", transport: "sms" as const },
    };
    const first = await adapter.send(message);
    const second = await adapter.send(message);
    expect(second).toEqual(first);
    expect(sends).toBe(1);
    await expect(
      adapter.send({ ...message, content: { kind: "text", text: "Changed" } }),
    ).rejects.toBeInstanceOf(SinchIdempotencyConflictError);
  });

  test("resolves channel-specific recipient identities before fallback", async () => {
    let payload: any;
    const adapter = createSinchAdapter({
      appId: APP_ID,
      client: {
        conversation: {
          messages: {
            send: async (input: any) => {
              payload = input.sendMessageRequestBody;
              return { message_id: "message-identities" };
            },
          },
        },
      } as never,
      projectId: PROJECT_ID,
      resolveRecipientIdentity: ({ address, transport }) =>
        transport === "messenger" ? "page-scoped-user-1" : address,
      webhookUrl: WEBHOOK,
    });
    await adapter.send({
      content: { kind: "text", text: "Alert" },
      fallbacks: [{ transport: "messenger" }],
      to: { address: "+12025550100", transport: "rcs" },
    });
    expect(payload.recipient.identified_by.channel_identities).toEqual([
      { channel: "RCS", identity: "+12025550100" },
      {
        app_id: APP_ID,
        channel: "MESSENGER",
        identity: "page-scoped-user-1",
      },
    ]);
  });

  test("maps discard retention to dispatch mode", async () => {
    let payload: any;
    const adapter = createSinchAdapter({
      appId: APP_ID,
      client: {
        conversation: {
          messages: {
            send: async (input: any) => {
              payload = input.sendMessageRequestBody;
              return { message_id: "message-private" };
            },
          },
        },
      } as never,
      projectId: PROJECT_ID,
      webhookUrl: WEBHOOK,
    });
    await adapter.send({
      content: { kind: "text", text: "Private alert" },
      privacy: { contentRetention: "discard" },
      to: { address: "+12025550100", transport: "sms" },
    });
    expect(payload.processing_strategy).toBe("DISPATCH");
  });

  test("rejects native schedules and route-specific fallback content", async () => {
    const adapter = createSinchAdapter({
      appId: APP_ID,
      client: {
        conversation: { messages: { send: async () => ({}) } },
      } as never,
      projectId: PROJECT_ID,
      webhookUrl: WEBHOOK,
    });
    await expect(
      adapter.send({
        content: { kind: "text", text: "Alert" },
        sendAt: new Date(Date.now() + 60_000).toISOString(),
        to: { address: "+12025550100", transport: "sms" },
      }),
    ).rejects.toBeInstanceOf(SinchConfigurationError);
    await expect(
      adapter.send({
        content: { kind: "text", text: "Alert" },
        fallbacks: [
          { content: { kind: "text", text: "Fallback" }, transport: "sms" },
        ],
        to: { address: "+12025550100", transport: "rcs" },
      }),
    ).rejects.toThrow("transcodes one message");
  });

  test("runs through Dispatch with normalized results", async () => {
    const messaging = createSinchAdapter({
      appId: APP_ID,
      client: {
        conversation: {
          messages: { send: async () => ({ message_id: "message-3" }) },
        },
      } as never,
      projectId: PROJECT_ID,
      webhookUrl: WEBHOOK,
    });
    await expect(
      createDispatcher({ messaging }).messaging({
        content: { kind: "text", text: "Alert" },
        to: { address: "+12025550100", transport: "sms" },
      }),
    ).resolves.toMatchObject({ provider: "sinch" });
  });
});
