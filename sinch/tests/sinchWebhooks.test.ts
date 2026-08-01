import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createMemoryMessagingConsentStore,
  createMessagingConsentLedger,
} from "@absolutejs/compliance";
import {
  createMemoryWebhookInboxStore,
  createSinchWebhookHandler,
  createSinchWebhookIntake,
  drainSinchWebhookInbox,
  type SinchWebhookEvent,
} from "../src";

const SECRET = "synthetic-sinch-webhook-secret";
const NOW = Date.parse("2026-08-01T20:00:00.000Z");
const PROJECT_ID = "project-1";
const APP_ID = "app-1";

const signed = (
  payload: Record<string, unknown>,
  secret = SECRET,
  nonce = `event-${Math.random()}`,
) => {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${rawBody}.${nonce}.${timestamp}`)
    .digest("base64");
  return {
    accountKey: "account-a",
    headers: { algorithm: "HmacSHA256", nonce, signature, timestamp },
    rawBody,
  };
};

const base = {
  accepted_time: "2026-08-01T20:00:00.000Z",
  app_id: APP_ID,
  event_time: "2026-08-01T20:00:00.000Z",
  project_id: PROJECT_ID,
};

const options = (
  events: SinchWebhookEvent[],
  extra: Record<string, unknown> = {},
) => ({
  handler: (event: SinchWebhookEvent) => {
    events.push(event);
  },
  inbox: createMemoryWebhookInboxStore<SinchWebhookEvent>(),
  now: () => NOW,
  resolveAccount: (key: string) =>
    key === "account-a"
      ? {
          appIds: [APP_ID],
          projectId: PROJECT_ID,
          signatureSecrets: [SECRET] as [string],
        }
      : undefined,
  ...extra,
});

const createSinchWebhookProcessor = (
  configured: ReturnType<typeof options>,
) => {
  const intake = createSinchWebhookIntake(configured);
  return {
    process: async (input: Parameters<typeof intake.process>[0]) => {
      const result = await intake.process(input);
      await drainSinchWebhookInbox(configured);
      return {
        ...result,
        disposition:
          result.disposition === "accepted"
            ? ("processed" as const)
            : result.disposition,
      };
    },
  };
};

describe("Sinch signed Conversation callbacks", () => {
  test("normalizes delivery and switching-channel failures", async () => {
    const events: SinchWebhookEvent[] = [];
    const processor = createSinchWebhookProcessor(options(events));
    const result = await processor.process(
      signed({
        ...base,
        message_delivery_report: {
          channel_identity: { channel: "WHATSAPP", identity: "+12025550100" },
          message_id: "message-1",
          reason: {
            code: "RECIPIENT_NOT_REACHABLE",
            description: "unreachable",
          },
          status: "SWITCHING_CHANNEL",
        },
      }),
    );
    expect(result.event).toMatchObject({
      actualTransport: "whatsapp",
      errors: [{ code: "RECIPIENT_NOT_REACHABLE" }],
      kind: "delivery",
      providerStatus: "SWITCHING_CHANNEL",
      status: "accepted",
    });
  });

  test("normalizes inbound choice responses", async () => {
    const events: SinchWebhookEvent[] = [];
    const processor = createSinchWebhookProcessor(options(events));
    await processor.process(
      signed({
        ...base,
        message: {
          channel_identity: { channel: "RCS", identity: "+12025550100" },
          contact_message: {
            choice_response_message: {
              message_id: "outbound-1",
              postback_data: "ack:42",
            },
          },
          id: "inbound-1",
          sender_id: "agent-1",
        },
      }),
    );
    expect(events[0]).toMatchObject({
      from: { address: "+12025550100", transport: "rcs" },
      interaction: { payload: "ack:42" },
      kind: "inbound",
    });
  });

  test("persists SMS STOP and deduplicates provider retries with new nonces", async () => {
    const events: SinchWebhookEvent[] = [];
    const ledger = createMessagingConsentLedger({
      store: createMemoryMessagingConsentStore(),
    });
    const processor = createSinchWebhookProcessor(
      options(events, {
        consentLedger: ledger,
        resolveConsentScopes: () => [
          {
            programId: "pro-alerts",
            purpose: "incident-alerts",
            tenant: "tenant-a",
          },
        ],
      }),
    );
    const request = signed(
      {
        ...base,
        message: {
          channel_identity: { channel: "SMS", identity: "+12025550100" },
          contact_message: { text_message: { text: "STOP" } },
          id: "inbound-stop",
          sender_id: "+12025550199",
        },
      },
      SECRET,
      "nonce-stop",
    );
    expect((await processor.process(request)).disposition).toBe("processed");
    const retry = signed(JSON.parse(request.rawBody), SECRET, "nonce-retry");
    expect((await processor.process(retry)).disposition).toBe("duplicate");
    expect(
      await ledger.decision({
        programId: "pro-alerts",
        purpose: "incident-alerts",
        recipient: "+12025550100",
        tenant: "tenant-a",
        transport: "sms",
      }),
    ).toMatchObject({ allowed: false, code: "revoked" });
  });

  test("normalizes provider opt-out and WhatsApp preference events", async () => {
    const events: SinchWebhookEvent[] = [];
    const processor = createSinchWebhookProcessor(options(events));
    await processor.process(
      signed({
        ...base,
        opt_out_notification: {
          channel: "RCS",
          identity: "+12025550100",
          request_id: "opt-1",
          status: "OPT_OUT_SUCCEEDED",
        },
      }),
    );
    await processor.process(
      signed({
        ...base,
        event: {
          channel_identity: { channel: "WHATSAPP", identity: "+12025550100" },
          contact_event: {
            channel_specific_event: {
              whatsapp_user_preferences_event: { preference: "resume" },
            },
          },
          id: "preference-1",
        },
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["consent", "consent"]);
    expect(events[1]).toMatchObject({ action: "grant", keyword: "RESUME" });
  });

  test("normalizes asynchronous capabilities and generic inbound events", async () => {
    const events: SinchWebhookEvent[] = [];
    const processor = createSinchWebhookProcessor(options(events));
    await processor.process(
      signed({
        ...base,
        project_id: "",
        capability_notification: {
          capability_status: "CAPABILITY_PARTIAL",
          channel: "RCS",
          channel_capabilities: ["RICH_CARD"],
          identity: "+12025550100",
          request_id: "capability-1",
        },
      }),
    );
    await processor.process(
      signed({
        ...base,
        event: {
          channel_identity: { channel: "RCS", identity: "+12025550100" },
          contact_event: { composing_event: {} },
          id: "event-1",
        },
      }),
    );
    expect(events[0]).toMatchObject({
      features: ["RICH_CARD"],
      kind: "capability",
      providerAccountId: PROJECT_ID,
      requestId: "capability-1",
      status: "CAPABILITY_PARTIAL",
      transport: "rcs",
    });
    expect(events[1]).toMatchObject({ kind: "inbound", messageId: "event-1" });
  });

  test("accepts one previous secret but rejects stale or tampered callbacks", async () => {
    const events: SinchWebhookEvent[] = [];
    const processor = createSinchWebhookProcessor(
      options(events, {
        resolveAccount: () => ({
          appIds: [APP_ID],
          projectId: PROJECT_ID,
          signatureSecrets: ["current-sinch-secret", SECRET],
        }),
      }),
    );
    const request = signed({
      ...base,
      message: {
        channel_identity: { channel: "SMS", identity: "+12025550100" },
        contact_message: { text_message: { text: "hello" } },
        id: "inbound-2",
      },
    });
    await expect(processor.process(request)).resolves.toMatchObject({
      disposition: "processed",
    });
    await expect(
      processor.process({ ...request, rawBody: `${request.rawBody} ` }),
    ).rejects.toThrow("signature");
    await expect(
      processor.process({
        ...request,
        headers: { ...request.headers, timestamp: "1" },
      }),
    ).rejects.toThrow("stale");
  });

  test("acknowledges durable intake before running application effects", async () => {
    const events: SinchWebhookEvent[] = [];
    const configured = options(events);
    const intake = createSinchWebhookIntake(configured);
    const result = await intake.process(
      signed({
        ...base,
        message: {
          channel_identity: { channel: "SMS", identity: "+12025550100" },
          contact_message: { text_message: { text: "hello" } },
          id: "inbound-async",
        },
      }),
    );
    expect(result.disposition).toBe("accepted");
    expect(events).toHaveLength(0);
    expect(await drainSinchWebhookInbox(configured)).toBe(1);
    expect(events).toHaveLength(1);
  });

  test("returns 202 after authenticated durable HTTP intake", async () => {
    const events: SinchWebhookEvent[] = [];
    const configured = options(events);
    const callback = signed({
      ...base,
      message: {
        channel_identity: { channel: "SMS", identity: "+12025550100" },
        contact_message: { text_message: { text: "hello" } },
        id: "inbound-http",
      },
    });
    const handler = createSinchWebhookHandler({
      ...configured,
      resolveAccountKey: () => callback.accountKey,
    });
    const response = await handler(
      new Request("https://example.com/webhooks/sinch/account-a", {
        body: callback.rawBody,
        headers: {
          "x-sinch-webhook-signature": callback.headers.signature,
          "x-sinch-webhook-signature-algorithm": callback.headers.algorithm,
          "x-sinch-webhook-signature-nonce": callback.headers.nonce,
          "x-sinch-webhook-signature-timestamp": callback.headers.timestamp,
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(202);
    expect(events).toHaveLength(0);
    expect(await drainSinchWebhookInbox(configured)).toBe(1);
  });

  test("retries consent effects during durable recovery", async () => {
    const events: SinchWebhookEvent[] = [];
    const ledger = createMessagingConsentLedger({
      store: createMemoryMessagingConsentStore(),
    });
    let attempts = 0;
    const configured = options(events, {
      consentLedger: {
        decision: ledger.decision,
        grant: ledger.grant,
        revoke: async (...args: Parameters<typeof ledger.revoke>) => {
          if (++attempts === 1) throw new Error("temporary ledger failure");
          return ledger.revoke(...args);
        },
      },
      resolveConsentScopes: () => [
        {
          programId: "pro-alerts",
          purpose: "incident-alerts",
          tenant: "tenant-a",
        },
      ],
    });
    const intake = createSinchWebhookIntake(configured as never);
    await intake.process(
      signed({
        ...base,
        message: {
          channel_identity: { channel: "SMS", identity: "+12025550100" },
          contact_message: { text_message: { text: "STOP" } },
          id: "inbound-recovery-stop",
          sender_id: "+12025550199",
        },
      }),
    );
    await expect(drainSinchWebhookInbox(configured as never)).rejects.toThrow(
      "temporary ledger failure",
    );
    expect(await drainSinchWebhookInbox(configured as never)).toBe(1);
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
});
