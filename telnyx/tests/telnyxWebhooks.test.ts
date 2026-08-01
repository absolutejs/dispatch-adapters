import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createMemoryMessagingConsentStore,
  createMessagingConsentLedger,
} from "@absolutejs/compliance";
import { createMemoryWebhookInboxStore } from "@absolutejs/reliability";
import {
  createTelnyxWebhookHandler,
  createTelnyxWebhookProcessor,
  TelnyxWebhookError,
  type TelnyxWebhookEvent,
} from "../src";

const NOW = 1_785_605_800_000;
const PROFILE = "4000eba1-a0c0-4562-b3fc-2c963f66afa6";
const keys = generateKeyPairSync("ed25519");
const previous = generateKeyPairSync("ed25519");
const publicPem = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const previousPem = previous.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

const body = (input: {
  eventId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
}) =>
  JSON.stringify({
    data: {
      event_type: input.eventType ?? "message.finalized",
      id: input.eventId ?? "event-1",
      occurred_at: new Date(NOW).toISOString(),
      payload: {
        id: "message-1",
        messaging_profile_id: PROFILE,
        organization_id: "org-1",
        to: [{ phone_number: "+12025550100", status: "delivered" }],
        type: "RCS",
        ...input.payload,
      },
    },
  });

const signed = (
  rawBody: string,
  privateKey = keys.privateKey,
  timestamp = String(NOW / 1000),
) => ({
  rawBody,
  signature: sign(
    null,
    Buffer.from(`${timestamp}|${rawBody}`),
    privateKey,
  ).toString("base64"),
  timestamp,
});

describe("Telnyx signed messaging webhooks", () => {
  test("verifies, normalizes, and deduplicates delivery events", async () => {
    const events: TelnyxWebhookEvent[] = [];
    const processor = createTelnyxWebhookProcessor({
      handler: (event) => void events.push(event),
      inbox: createMemoryWebhookInboxStore(),
      now: () => NOW,
      resolveAccount: () => ({
        accountId: "org-1",
        messagingProfileIds: [PROFILE],
        publicKeys: [publicPem],
      }),
    });
    const request = signed(body({}));
    await expect(processor.process(request)).resolves.toMatchObject({
      disposition: "processed",
      event: {
        actualTransport: "rcs",
        kind: "delivery",
        status: "delivered",
      },
    });
    await expect(processor.process(request)).resolves.toMatchObject({
      disposition: "duplicate",
    });
    expect(events).toHaveLength(1);
  });

  test("accepts the previous public key during bounded rotation", async () => {
    const processor = createTelnyxWebhookProcessor({
      handler: () => {},
      inbox: createMemoryWebhookInboxStore(),
      now: () => NOW,
      resolveAccount: () => ({
        accountId: "org-1",
        publicKeys: [publicPem, previousPem],
      }),
    });
    await expect(
      processor.process(signed(body({}), previous.privateKey)),
    ).resolves.toMatchObject({ disposition: "processed" });
  });

  test("normalizes RCS interactive inbound content", async () => {
    const seen: TelnyxWebhookEvent[] = [];
    const processor = createTelnyxWebhookProcessor({
      handler: (event) => void seen.push(event),
      inbox: createMemoryWebhookInboxStore(),
      now: () => NOW,
      resolveAccount: () => ({ accountId: "org-1", publicKeys: [publicPem] }),
    });
    await processor.process(
      signed(
        body({
          eventType: "message.received",
          payload: {
            from: { phone_number: "+12025550111" },
            postback_data: "incident:ack",
            text: "Acknowledge",
            type: "RCS",
          },
        }),
      ),
    );
    expect(seen[0]).toMatchObject({
      actualTransport: "rcs",
      interaction: { payload: "incident:ack" },
      kind: "inbound",
    });
  });

  test("persists STOP and START across every resolved program", async () => {
    const ledger = createMessagingConsentLedger({
      store: createMemoryMessagingConsentStore(),
    });
    const processor = createTelnyxWebhookProcessor({
      consentLedger: ledger,
      handler: () => {},
      inbox: createMemoryWebhookInboxStore(),
      now: () => NOW,
      resolveAccount: () => ({ accountId: "org-1", publicKeys: [publicPem] }),
      resolveConsentScopes: () => [
        { programId: "alerts", purpose: "incident", tenant: "tenant-1" },
        { programId: "billing", purpose: "invoice", tenant: "tenant-1" },
      ],
    });
    await processor.process(
      signed(
        body({
          eventId: "stop-1",
          eventType: "message.received",
          payload: {
            from: { phone_number: "+12025550111" },
            text: "STOP",
            type: "SMS",
          },
        }),
      ),
    );
    await expect(
      ledger.decision({
        programId: "billing",
        purpose: "invoice",
        recipient: "+12025550111",
        tenant: "tenant-1",
        transport: "sms",
      }),
    ).resolves.toMatchObject({ allowed: false, code: "revoked" });
  });

  test("rejects forged, stale, wrong-profile, and unknown-account events", async () => {
    const options = {
      handler: () => {},
      inbox: createMemoryWebhookInboxStore<TelnyxWebhookEvent>(),
      now: () => NOW,
      resolveAccount: (organizationId: string) =>
        organizationId === "org-1"
          ? {
              accountId: "org-1",
              messagingProfileIds: [PROFILE],
              publicKeys: [publicPem],
            }
          : undefined,
    };
    const processor = createTelnyxWebhookProcessor(options);
    const raw = body({});
    await expect(
      processor.process({ ...signed(raw), signature: "forged" }),
    ).rejects.toBeInstanceOf(TelnyxWebhookError);
    await expect(
      processor.process(signed(raw, keys.privateKey, String(NOW / 1000 - 301))),
    ).rejects.toThrow("stale");
    const wrongProfile = body({ payload: { messaging_profile_id: "other" } });
    await expect(processor.process(signed(wrongProfile))).rejects.toThrow(
      "not bound",
    );
    const unknown = body({ payload: { organization_id: "org-other" } });
    await expect(processor.process(signed(unknown))).rejects.toThrow("unknown");
  });

  test("HTTP handler returns 500 on consumer failure so Telnyx retries", async () => {
    const handler = createTelnyxWebhookHandler({
      handler: () => {
        throw new Error("database unavailable");
      },
      inbox: createMemoryWebhookInboxStore(),
      now: () => NOW,
      resolveAccount: () => ({ accountId: "org-1", publicKeys: [publicPem] }),
    });
    const raw = body({});
    const request = signed(raw);
    const response = await handler(
      new Request("https://app.example.com/webhooks/telnyx", {
        body: raw,
        headers: {
          "content-type": "application/json",
          "telnyx-signature-ed25519": request.signature,
          "telnyx-timestamp": request.timestamp,
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(500);
  });
});
