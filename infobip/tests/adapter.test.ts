import { describe, expect, test } from "bun:test";
import {
  createInfobipAdapter,
  createInfobipWebhookHandler,
  createMemoryWebhookInboxStore,
  drainInfobipWebhookInbox,
} from "../src";

describe("Infobip adapter", () => {
  test("validates then sends portable rich content", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const adapter = createInfobipAdapter({
      apiKey: "secret",
      baseUrl: "tenant.api.infobip.com",
      defaultSenders: { whatsapp: "15550001111" },
      fetch: async (input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          url: String(input),
        });
        return Response.json(
          String(input).includes("messages-api")
            ? { messages: [{ messageId: "infobip-1" }] }
            : {},
        );
      },
      validateBeforeSend: true,
    });
    const result = await adapter.send({
      content: {
        actions: [{ kind: "reply", label: "Acknowledge", payload: "ack" }],
        kind: "rich",
        text: "Incident opened",
      },
      idempotencyKey: "incident-1",
      tenant: "acme",
      to: { address: "15551234567", transport: "whatsapp" },
    });
    expect(requests.map((item) => item.url)).toEqual([
      "https://tenant.api.infobip.com/resource-management/1/messages/validate",
      "https://tenant.api.infobip.com/messages-api/1/messages",
    ]);
    expect(requests[1]?.body).toMatchObject({
      messages: [
        {
          callbackData: '{"idempotencyKey":"incident-1","tenant":"acme"}',
          channel: "WHATSAPP",
          destinations: [{ to: "15551234567" }],
          sender: "15550001111",
        },
      ],
    });
    const sent = (
      requests[1]?.body.messages as Array<Record<string, unknown>>
    )[0];
    expect(sent).toMatchObject({
      body: { text: "Incident opened", type: "TEXT" },
      buttons: [{ postbackData: "ack", text: "Acknowledge", type: "REPLY" }],
    });
    expect(result.id).toBe("infobip-1");
  });

  test("requires validated provider failover details", async () => {
    const adapter = createInfobipAdapter({
      apiKey: "secret",
      baseUrl: "https://tenant.api.infobip.com",
      defaultSenders: { sms: "15550001111", whatsapp: "15550001111" },
      fetch: async () => Response.json({}),
    });
    await expect(
      adapter.send({
        content: { kind: "text", text: "Hello" },
        fallbacks: [{ transport: "sms" }],
        to: { address: "15551234567", transport: "whatsapp" },
      }),
    ).rejects.toThrow("extensions.infobip.failover");
  });

  test("refuses to silently discard portable media parts", async () => {
    const adapter = createInfobipAdapter({
      apiKey: "secret",
      baseUrl: "tenant.api.infobip.com",
      defaultSenders: { mms: "15550001111" },
      fetch: async () => Response.json({}),
    });
    await expect(
      adapter.send({
        content: {
          kind: "media",
          mediaUrls: ["https://site.test/a.jpg", "https://site.test/b.jpg"],
        },
        to: { address: "15551234567", transport: "mms" },
      }),
    ).rejects.toThrow("exactly one URL");
  });

  test("authenticates durable intake before processing", async () => {
    const inbox = createMemoryWebhookInboxStore<string>();
    const handler = createInfobipWebhookHandler({
      inbox,
      verify: (headers) => headers.get("authorization") === "Basic trusted",
    });
    const unauthorized = await handler(
      new Request("https://site.test/webhook", {
        body: "{}",
        method: "POST",
      }),
    );
    expect(unauthorized.status).toBe(401);
    const accepted = await handler(
      new Request("https://site.test/webhook", {
        body: JSON.stringify({
          results: [
            {
              doneAt: "2026-08-01T12:00:00Z",
              messageId: "m-1",
              status: { name: "DELIVERED" },
            },
          ],
        }),
        headers: { authorization: "Basic trusted" },
        method: "POST",
      }),
    );
    expect(accepted.status).toBe(202);
    const events: unknown[] = [];
    const drained = await drainInfobipWebhookInbox({
      inbox,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(drained).toEqual({ claimed: 1, completed: 1 });
    expect(events[0]).toMatchObject({ messageId: "m-1", status: "delivered" });
  });

  test("normalizes inbound messages separately from receipts", async () => {
    const inbox = createMemoryWebhookInboxStore<string>();
    const handler = createInfobipWebhookHandler({ inbox, verify: () => true });
    await handler(
      new Request("https://site.test/webhook", {
        body: JSON.stringify({
          channel: "WHATSAPP",
          from: "15551234567",
          message: { text: "YES" },
          messageId: "inbound-1",
          receivedAt: "2026-08-01T12:00:00Z",
          to: "15550001111",
        }),
        method: "POST",
      }),
    );
    const events: unknown[] = [];
    await drainInfobipWebhookInbox({
      inbox,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(events[0]).toMatchObject({
      content: { kind: "text", text: "YES" },
      from: { address: "15551234567", transport: "whatsapp" },
      kind: "inbound",
      messageId: "inbound-1",
    });
  });
});
