import { describe, expect, test } from "bun:test";
import twilio from "twilio";
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
      authToken: AUTH_TOKEN,
      onEvent: (event) => {
        events.push(event);
      },
      store: createMemoryTwilioLifecycleStore(),
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

  test("deduplicates retries and suppresses out-of-order callbacks", async () => {
    const events: TwilioWebhookEvent[] = [];
    const process = createTwilioWebhookProcessor({
      authToken: AUTH_TOKEN,
      onEvent: (event) => {
        events.push(event);
      },
      store: createMemoryTwilioLifecycleStore(),
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
        authToken: AUTH_TOKEN,
        onEvent: (event) => {
          events.push(event);
        },
        store: createMemoryTwilioLifecycleStore(),
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

  test("rejects forged callbacks before parsing", async () => {
    const handler = createTwilioWebhookHandler({
      authToken: AUTH_TOKEN,
      onEvent: () => {
        throw new Error("must not run");
      },
      store: createMemoryTwilioLifecycleStore(),
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

  test("supports an exact externally resolved URL behind a trusted proxy", async () => {
    const internalUrl = "http://internal:3000/webhooks/twilio/messaging";
    const process = createTwilioWebhookProcessor({
      authToken: AUTH_TOKEN,
      onEvent: () => {},
      resolvePublicUrl: () => URL,
      store: createMemoryTwilioLifecycleStore(),
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
      authToken: AUTH_TOKEN,
      onEvent: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database unavailable");
      },
      store: createMemoryTwilioLifecycleStore(),
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
      authToken: AUTH_TOKEN,
      onEvent: (event) => {
        if (event.kind !== "status") return;
        if (event.status === "sent" && failSent) {
          failSent = false;
          throw new Error("transient failure");
        }
        delivered.push(event.status);
      },
      store: createMemoryTwilioLifecycleStore(),
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
