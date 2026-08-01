import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createMemoryMessagingConsentStore,
  createMessagingConsentLedger,
} from "@absolutejs/compliance";
import {
  createMemoryWebhookInboxStore,
  createVonageWebhookProcessor,
  type VonageWebhookEvent,
} from "../src";

const SECRET = "synthetic-signature-secret";
const API_KEY = "api-key";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-08-01T18:00:00.000Z");

const signed = (
  payload: Record<string, unknown>,
  secret = SECRET,
  claims: Record<string, unknown> = {},
) => {
  const rawBody = JSON.stringify(payload);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      api_key: API_KEY,
      application_id: APP_ID,
      iat: Math.floor(NOW / 1000),
      iss: "Vonage",
      jti: `event-${payload.status ?? payload.message_type ?? "inbound"}`,
      payload_hash: createHash("sha256").update(rawBody).digest("hex"),
      ...claims,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return { authorization: `Bearer ${header}.${body}.${signature}`, rawBody };
};

const options = (
  events: VonageWebhookEvent[],
  extra: Partial<Parameters<typeof createVonageWebhookProcessor>[0]> = {},
) => ({
  handler: (event: VonageWebhookEvent) => {
    events.push(event);
  },
  inbox: createMemoryWebhookInboxStore<VonageWebhookEvent>(),
  now: () => NOW,
  resolveAccount: (apiKey: string) =>
    apiKey === API_KEY
      ? {
          apiKey,
          applicationIds: [APP_ID],
          signatureSecrets: [SECRET] as [string],
        }
      : undefined,
  ...extra,
});

describe("Vonage signed messaging webhooks", () => {
  test("normalizes delivery economics, carrier data, and fallback position", async () => {
    const events: VonageWebhookEvent[] = [];
    const processor = createVonageWebhookProcessor(options(events));
    const result = await processor.process(
      signed({
        channel: "sms",
        destination: { network_code: "12345" },
        from: "12025550199",
        message_uuid: "message-2",
        sms: { total_count: "2" },
        status: "delivered",
        timestamp: "2026-08-01T18:00:00.000Z",
        to: "12025550100",
        usage: { currency: "EUR", price: "0.0333" },
        workflow: { item_number: "2", items_total: "2" },
      }),
    );
    expect(result.event).toMatchObject({
      attempt: { route: { fallbackIndex: 0 } },
      economics: { currency: "EUR", price: "0.0333", segments: 2 },
      kind: "delivery",
      networkCode: "12345",
      status: "delivered",
    });
    expect(events).toHaveLength(1);
  });

  test("normalizes inbound interactions", async () => {
    const events: VonageWebhookEvent[] = [];
    const processor = createVonageWebhookProcessor(options(events));
    await processor.process(
      signed({
        channel: "rcs",
        from: "12025550100",
        message_type: "reply",
        message_uuid: "message-inbound",
        postback_data: "ack:42",
        text: "Acknowledge",
        timestamp: "2026-08-01T18:00:00.000Z",
        to: "agent-1",
      }),
    );
    expect(events[0]).toMatchObject({
      content: { kind: "text", text: "Acknowledge" },
      from: { address: "12025550100", transport: "rcs" },
      interaction: { payload: "ack:42" },
      kind: "inbound",
      to: { address: "agent-1", transport: "rcs" },
    });
  });

  test("persists STOP and deduplicates provider retries", async () => {
    const events: VonageWebhookEvent[] = [];
    const ledger = createMessagingConsentLedger({
      store: createMemoryMessagingConsentStore(),
    });
    const inbox = createMemoryWebhookInboxStore<VonageWebhookEvent>();
    const processor = createVonageWebhookProcessor(
      options(events, {
        consentLedger: ledger,
        inbox,
        resolveConsentScopes: () => [
          {
            programId: "pro-alerts",
            purpose: "incident-alerts",
            tenant: "tenant-a",
          },
        ],
      }),
    );
    const request = signed({
      channel: "sms",
      from: "12025550100",
      message_type: "text",
      message_uuid: "message-stop",
      text: "STOP",
      timestamp: "2026-08-01T18:00:00.000Z",
      to: "12025550199",
    });
    expect((await processor.process(request)).disposition).toBe("processed");
    expect((await processor.process(request)).disposition).toBe("duplicate");
    expect(
      await ledger.decision({
        programId: "pro-alerts",
        purpose: "incident-alerts",
        recipient: "+12025550100",
        tenant: "tenant-a",
        transport: "sms",
      }),
    ).toMatchObject({ allowed: false, code: "revoked" });
    expect(events).toHaveLength(1);
  });

  test("accepts one previous secret but rejects forgery and body tampering", async () => {
    const events: VonageWebhookEvent[] = [];
    const processor = createVonageWebhookProcessor(
      options(events, {
        resolveAccount: () => ({
          apiKey: API_KEY,
          applicationIds: [APP_ID],
          signatureSecrets: ["current-secret", SECRET],
        }),
      }),
    );
    const payload = {
      channel: "sms",
      message_uuid: "message-1",
      status: "submitted",
      timestamp: "2026-08-01T18:00:00.000Z",
    };
    await expect(processor.process(signed(payload))).resolves.toMatchObject({
      disposition: "processed",
    });
    await expect(processor.process(signed(payload, "forged"))).rejects.toThrow(
      "signature",
    );
    const tampered = signed(payload);
    await expect(
      processor.process({ ...tampered, rawBody: `${tampered.rawBody} ` }),
    ).rejects.toThrow("payload hash");
  });
});
