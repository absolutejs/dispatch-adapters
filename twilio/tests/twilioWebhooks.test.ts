import { describe, expect, test } from "bun:test";
import twilio from "twilio";
import {
  createMemoryMessagingConsentStore,
  createMessagingConsentLedger,
} from "@absolutejs/compliance";
import {
  createMemoryTwilioLifecycleStore,
  createTwilioWebhookHandler,
  createTwilioWebhookProcessor,
  type TwilioWebhookEvent,
} from "../src";

const AUTH_TOKEN = "test_auth_token";
const URL = "https://app.example.com/webhooks/twilio/messaging";
// Construct provider-shaped test identifiers at runtime so secret scanners do
// not mistake a source fixture for a live Twilio credential.
const ACCOUNT_SID = `AC${"0".repeat(32)}`;
const MESSAGE_SID = "SM0123456789abcdef0123456789abcdef";
const SERVICE_SID = `MG${"1".repeat(32)}`;
const resolveAccount =
  (
    expectedAccountSid = ACCOUNT_SID,
    authTokens: readonly [string, ...string[]] = [AUTH_TOKEN],
    messagingServiceSids?: ReadonlyArray<string>,
  ) =>
  (accountSid: string) =>
    accountSid === expectedAccountSid
      ? {
          accountSid,
          authTokens,
          ...(messagingServiceSids === undefined
            ? {}
            : { messagingServiceSids }),
        }
      : undefined;

const signedRequest = (
  params: Record<string, string>,
  overrides?: { signature?: string; url?: string },
) => {
  const url = overrides?.url ?? URL;
  const signature =
    overrides?.signature ??
    twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return new Request(url, {
    body: new URLSearchParams(params),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    method: "POST",
  });
};

describe("Twilio webhook processing", () => {
  test("verifies and normalizes delivery status", async () => {
    const events: TwilioWebhookEvent[] = [];
    const process = createTwilioWebhookProcessor({
      resolveAccount: resolveAccount(),
      onEvent: (event) => {
        events.push(event);
      },
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const result = await process(
      signedRequest({
        AccountSid: ACCOUNT_SID,
        ErrorCode: "30003",
        From: "+12025550199",
        MessageSid: MESSAGE_SID,
        MessageStatus: "undelivered",
        To: "+12025550100",
      }),
    );
    expect(result.disposition).toBe("accepted");
    expect(result.event).toMatchObject({
      errorCode: 30003,
      kind: "status",
      status: "undelivered",
    });
    expect(events).toHaveLength(1);
  });

  test("accepts the previous auth token during rotation", async () => {
    const process = createTwilioWebhookProcessor({
      onEvent: () => {},
      resolveAccount: resolveAccount(ACCOUNT_SID, ["new-token", AUTH_TOKEN]),
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    expect(
      (
        await process(
          signedRequest({
            AccountSid: ACCOUNT_SID,
            MessageSid: MESSAGE_SID,
            MessageStatus: "sent",
          }),
        )
      ).disposition,
    ).toBe("accepted");
  });

  test("accepts MM SIDs and reports the actual fallback transport", async () => {
    const process = createTwilioWebhookProcessor({
      onEvent: () => {},
      resolveAccount: resolveAccount(),
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const result = await process(
      signedRequest({
        AccountSid: ACCOUNT_SID,
        ChannelPrefix: "sms",
        MessageSid: `MM${"7".repeat(32)}`,
        MessageStatus: "delivered",
      }),
    );
    expect(result.event).toMatchObject({
      actualTransport: "sms",
      kind: "status",
    });
  });

  test("deduplicates retries and suppresses out-of-order callbacks", async () => {
    const events: TwilioWebhookEvent[] = [];
    const process = createTwilioWebhookProcessor({
      resolveAccount: resolveAccount(),
      onEvent: (event) => {
        events.push(event);
      },
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const params = {
      AccountSid: ACCOUNT_SID,
      MessageSid: MESSAGE_SID,
      MessageStatus: "delivered",
    };
    expect((await process(signedRequest(params))).disposition).toBe("accepted");
    expect((await process(signedRequest(params))).disposition).toBe(
      "duplicate",
    );
    expect(
      (await process(signedRequest({ ...params, MessageStatus: "sent" })))
        .disposition,
    ).toBe("stale");
    expect(events).toHaveLength(1);
  });

  test.each(["STOP", "START", "HELP"])(
    "normalizes %s consent events",
    async (optOutType) => {
      const events: TwilioWebhookEvent[] = [];
      const process = createTwilioWebhookProcessor({
        resolveAccount: resolveAccount(),
        onEvent: (event) => {
          events.push(event);
        },
        store: createMemoryTwilioLifecycleStore(),
        publicUrl: URL,
      });
      await process(
        signedRequest({
          AccountSid: ACCOUNT_SID,
          Body: optOutType,
          From: "+12025550100",
          MessageSid: MESSAGE_SID,
          OptOutType: optOutType,
          To: "+12025550199",
        }),
      );
      expect(events[0]).toMatchObject({ kind: "consent", optOutType });
    },
  );

  test("persists signed START and STOP events into the consent ledger retry-safely", async () => {
    const scope = {
      programId: "acme-incident-alerts",
      purpose: "incident-alerts",
      recipient: "+12025550100",
      tenant: "tenant-a",
      transport: "sms" as const,
    };
    const ledger = createMessagingConsentLedger({
      store: createMemoryMessagingConsentStore(),
    });
    let failOnce = true;
    const process = createTwilioWebhookProcessor({
      consent: { ledger, resolveScopes: () => [scope] },
      resolveAccount: resolveAccount(),
      onEvent: () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("downstream unavailable");
        }
      },
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const stop = {
      AccountSid: ACCOUNT_SID,
      From: scope.recipient,
      MessageSid: MESSAGE_SID,
      OptOutType: "STOP",
      To: "+12025550199",
    };
    await expect(process(signedRequest(stop))).rejects.toThrow(
      "downstream unavailable",
    );
    await process(signedRequest(stop));
    expect(await ledger.decision(scope)).toMatchObject({
      allowed: false,
      code: "revoked",
    });
    expect(await ledger.history(scope)).toHaveLength(1);
  });

  test("normalizes ordinary inbound replies and media", async () => {
    const events: TwilioWebhookEvent[] = [];
    const process = createTwilioWebhookProcessor({
      resolveAccount: resolveAccount(ACCOUNT_SID, [AUTH_TOKEN], [SERVICE_SID]),
      onEvent: (event) => {
        events.push(event);
      },
      publicUrl: URL,
      store: createMemoryTwilioLifecycleStore(),
    });
    await process(
      signedRequest({
        AccountSid: ACCOUNT_SID,
        Body: "A photo",
        ButtonPayload: "ack-incident-42",
        ButtonText: "Acknowledge",
        From: "+12025550100",
        MediaContentType0: "image/jpeg",
        MediaUrl0: "https://api.twilio.com/media/one",
        MessageSid: MESSAGE_SID,
        MessagingServiceSid: SERVICE_SID,
        NumMedia: "1",
        To: "+12025550199",
      }),
    );
    expect(events[0]).toMatchObject({
      body: "A photo",
      buttonPayload: "ack-incident-42",
      buttonText: "Acknowledge",
      kind: "inbound",
      media: [
        { contentType: "image/jpeg", url: "https://api.twilio.com/media/one" },
      ],
    });
  });

  test("rejects callbacks from a different account", async () => {
    const handler = createTwilioWebhookHandler({
      resolveAccount: resolveAccount(`AC${"9".repeat(32)}`),
      onEvent: () => {},
      publicUrl: URL,
      store: createMemoryTwilioLifecycleStore(),
    });
    expect(
      (
        await handler(
          signedRequest({
            AccountSid: ACCOUNT_SID,
            MessageSid: MESSAGE_SID,
            MessageStatus: "sent",
          }),
        )
      ).status,
    ).toBe(403);
  });

  test("rejects forged callbacks before parsing", async () => {
    const handler = createTwilioWebhookHandler({
      resolveAccount: resolveAccount(),
      onEvent: () => {
        throw new Error("must not run");
      },
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const response = await handler(
      signedRequest(
        {
          AccountSid: ACCOUNT_SID,
          MessageSid: MESSAGE_SID,
          MessageStatus: "sent",
        },
        { signature: "forged" },
      ),
    );
    expect(response.status).toBe(403);
  });

  test("uses the fixed public URL behind a trusted proxy", async () => {
    const internalUrl = "http://internal:3000/webhooks/twilio/messaging";
    const process = createTwilioWebhookProcessor({
      resolveAccount: resolveAccount(),
      onEvent: () => {},
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const request = signedRequest(
      {
        AccountSid: ACCOUNT_SID,
        MessageSid: MESSAGE_SID,
        MessageStatus: "sent",
      },
      { url: URL },
    );
    const proxied = new Request(internalUrl, request);
    expect((await process(proxied)).disposition).toBe("accepted");
  });

  test("returns 500 so Twilio can retry when the consumer fails", async () => {
    let attempts = 0;
    const handler = createTwilioWebhookHandler({
      resolveAccount: resolveAccount(),
      onEvent: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database unavailable");
      },
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const params = {
      AccountSid: ACCOUNT_SID,
      MessageSid: MESSAGE_SID,
      MessageStatus: "sent",
    };
    expect((await handler(signedRequest(params))).status).toBe(500);
    expect((await handler(signedRequest(params))).status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("does not redeliver released work after a newer terminal event", async () => {
    const delivered: string[] = [];
    let failSent = true;
    const process = createTwilioWebhookProcessor({
      resolveAccount: resolveAccount(),
      onEvent: (event) => {
        if (event.kind !== "status") return;
        if (event.status === "sent" && failSent) {
          failSent = false;
          throw new Error("transient failure");
        }
        delivered.push(event.status);
      },
      store: createMemoryTwilioLifecycleStore(),
      publicUrl: URL,
    });
    const base = { AccountSid: ACCOUNT_SID, MessageSid: MESSAGE_SID };
    await expect(
      process(signedRequest({ ...base, MessageStatus: "sent" })),
    ).rejects.toThrow("transient failure");
    await process(signedRequest({ ...base, MessageStatus: "delivered" }));
    const retry = await process(
      signedRequest({ ...base, MessageStatus: "sent" }),
    );
    expect(retry.disposition).toBe("stale");
    expect(delivered).toEqual(["delivered"]);
  });
});
