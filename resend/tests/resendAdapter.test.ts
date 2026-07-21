import { describe, expect, test } from "bun:test";
import { createDispatcher } from "@absolutejs/dispatch";
import type { EffectAdapterDriverContext } from "@absolutejs/execution";
import { Resend } from "resend";
import { Webhook } from "standardwebhooks";
import {
  createResendAdapter,
  createResendEffectAdapterDriver,
  resendEffectAdapterDescriptor,
  RESEND_EFFECT_API_DESTINATION,
  RESEND_EFFECT_ID_TAG,
  RESEND_EFFECT_WEBHOOK_EVENTS,
  RESEND_EMAIL_EFFECT,
  RESEND_WEBHOOK_SECRET_ALIAS,
  verifyResendEffectWebhook,
  type ResendClientLike,
} from "../src/index";

/**
 * Mock Resend client. Captures every `emails.send` call so we can
 * assert the adapter mapped the dispatch message into Resend's request
 * shape correctly, without needing a real Resend API key.
 */
const makeMockResend = () => {
  const calls: Array<Parameters<ResendClientLike["emails"]["send"]>[0]> = [];
  const options: Array<Parameters<ResendClientLike["emails"]["send"]>[1]> = [];
  let nextId = 1;
  let nextError: unknown = undefined;
  const client: ResendClientLike = {
    emails: {
      send: async (params, requestOptions) => {
        calls.push(params);
        options.push(requestOptions);
        if (nextError !== undefined) {
          return { error: nextError };
        }
        return { data: { id: `resend-msg-${nextId++}` } };
      },
    },
  };
  return {
    calls,
    client,
    options,
    setError: (error: unknown) => {
      nextError = error;
    },
  };
};

const effectContext = (
  value = "project-resend-secret",
): EffectAdapterDriverContext => ({
  actionId: "action-a",
  credentials: [
    {
      adapterAlias: "RESEND_API_KEY",
      destination: RESEND_EFFECT_API_DESTINATION,
      mode: "provider-sdk",
      secretAlias: "PROJECT_RESEND_API_KEY",
      value,
    },
  ],
  destination: RESEND_EFFECT_API_DESTINATION,
  effect: RESEND_EMAIL_EFFECT,
  effectId: "effect-a",
  idempotencyKey: "tenant-a:effect-a",
  inputDigest: "sha256:input",
  installationId: "installation-a",
  signal: new AbortController().signal,
  tenantId: "tenant-a",
});

const testWebhookSecret = () =>
  `${["wh", "sec"].join("")}_${Buffer.from("deterministic-local-test-signing-material").toString("base64")}`;

describe("createResendAdapter", () => {
  test("accepts the current real Resend client type", () => {
    const client: ResendClientLike = new Resend("re_typecheck_only");
    expect(createResendAdapter({ client }).name).toBe("resend");
  });

  test("forwards a stable idempotency key to Resend", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    await adapter.send({
      from: "sender@acme.io",
      idempotencyKey: "effect:tenant-a:message-a",
      subject: "Welcome",
      text: "Hello there",
      to: "alice@example.com",
    });
    expect(mock.options).toEqual([
      { idempotencyKey: "effect:tenant-a:message-a" },
    ]);
  });

  test("maps EmailMessage fields to Resend params", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({
      from: "sender@acme.io",
      subject: "Welcome",
      text: "Hello there",
      to: "alice@example.com",
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      from: "sender@acme.io",
      subject: "Welcome",
      text: "Hello there",
      to: "alice@example.com",
    });
  });

  test("returns Resend message id as DispatchResult.id", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({ email: adapter });
    const result = await dispatcher.email({
      from: "s@acme.io",
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(result.provider).toBe("resend");
    expect(result.id).toBe("resend-msg-1");
  });

  test("defaultFrom fills in when message has no from", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({
      client: mock.client,
      defaultFrom: "no-reply@acme.io",
    });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({ subject: "s", text: "t", to: "a@b.c" });
    expect(mock.calls[0]!.from).toBe("no-reply@acme.io");
  });

  test("throws when no from is available (message or defaultFrom)", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({
      email: adapter,
      onError: () => {
        // swallow
      },
    });
    await expect(
      dispatcher.email({ subject: "s", text: "t", to: "a@b.c" }),
    ).rejects.toThrow(/no `from` address/);
  });

  test("throws before the client when neither text nor html is present", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({
      client: mock.client,
      defaultFrom: "no-reply@acme.io",
    });
    await expect(
      adapter.send({ subject: "empty", to: "a@b.c" }),
    ).rejects.toThrow(/requires `text` or `html`/);
    expect(mock.calls).toHaveLength(0);
  });

  test("array `to` is passed through", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({
      from: "s@acme.io",
      subject: "s",
      text: "t",
      to: ["a@b.c", "d@e.f"],
    });
    expect(mock.calls[0]!.to).toEqual(["a@b.c", "d@e.f"]);
  });

  test("replyTo, cc, bcc, headers pass through", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({
      bcc: ["silent@acme.io"],
      cc: ["cc@acme.io"],
      from: "s@acme.io",
      headers: { "X-Tenant": "tenant-A" },
      replyTo: "reply@acme.io",
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(mock.calls[0]!.reply_to).toBe("reply@acme.io");
    expect(mock.calls[0]!.cc).toEqual(["cc@acme.io"]);
    expect(mock.calls[0]!.bcc).toEqual(["silent@acme.io"]);
    expect(mock.calls[0]!.headers).toEqual({ "X-Tenant": "tenant-A" });
  });

  test("string metadata becomes Resend tags by default", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({
      from: "s@acme.io",
      metadata: { campaign: "welcome-v2", priority: "high" },
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(mock.calls[0]!.tags).toEqual([
      { name: "campaign", value: "welcome-v2" },
      { name: "priority", value: "high" },
    ]);
  });

  test("non-string metadata entries are filtered out of tags", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({
      from: "s@acme.io",
      metadata: { count: 5, tag: "keep", flag: true },
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(mock.calls[0]!.tags).toEqual([{ name: "tag", value: "keep" }]);
  });

  test("custom tagsFromMetadata replaces default", async () => {
    const mock = makeMockResend();
    const adapter = createResendAdapter({
      client: mock.client,
      tagsFromMetadata: () => [{ name: "always", value: "present" }],
    });
    const dispatcher = createDispatcher({ email: adapter });
    await dispatcher.email({
      from: "s@acme.io",
      metadata: { foo: "ignored" },
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(mock.calls[0]!.tags).toEqual([{ name: "always", value: "present" }]);
  });

  test("Resend error response throws — propagates to dispatcher", async () => {
    const mock = makeMockResend();
    mock.setError({ message: "rate limited" });
    const adapter = createResendAdapter({ client: mock.client });
    const dispatcher = createDispatcher({
      email: adapter,
      onError: () => {
        // swallow
      },
    });
    await expect(
      dispatcher.email({
        from: "s@acme.io",
        subject: "s",
        text: "t",
        to: "a@b.c",
      }),
    ).rejects.toThrow("rate limited");
    expect(dispatcher.metrics().failed).toBe(1);
  });

  test("handles missing data.id gracefully (no id in result)", async () => {
    const client: ResendClientLike = {
      emails: {
        send: async () => ({ data: null }),
      },
    };
    const adapter = createResendAdapter({ client });
    const dispatcher = createDispatcher({ email: adapter });
    const result = await dispatcher.email({
      from: "s@acme.io",
      subject: "s",
      text: "t",
      to: "a@b.c",
    });
    expect(result.id).toBeUndefined();
    expect(result.provider).toBe("resend");
  });
});

describe("createResendEffectAdapterDriver", () => {
  test("declares complete provider-neutral webhook setup", () => {
    const { reconciliation } = resendEffectAdapterDescriptor;
    expect(reconciliation.mode).toBe("webhook");
    if (reconciliation.mode !== "webhook")
      throw new Error("Expected webhook reconciliation");
    expect(reconciliation.webhook).toEqual({
      callback: {
        body: "raw",
        mediaType: "application/json",
        method: "POST",
        pathTemplate: "/api/webhooks/agent-effects/{tenantId}/resend",
        signatureHeaders: ["svix-id", "svix-timestamp", "svix-signature"],
      },
      events: RESEND_EFFECT_WEBHOOK_EVENTS,
      health: { strategy: "last-verified-event" },
      provider: "resend",
      secret: {
        alias: RESEND_WEBHOOK_SECRET_ALIAS,
        rotation: { mode: "replace", verification: "signed-event" },
      },
    });
  });

  test("uses the resolved key and stable effect idempotency key", async () => {
    const mock = makeMockResend();
    const keys: string[] = [];
    const driver = createResendEffectAdapterDriver((key) => {
      keys.push(key);
      return mock.client;
    });
    const result = await driver.execute(
      {
        from: "sender@example.com",
        subject: "Hello",
        text: "Body",
        to: "recipient@example.com",
      },
      effectContext(),
    );

    expect(keys).toEqual(["project-resend-secret"]);
    expect(mock.options).toEqual([{ idempotencyKey: "tenant-a:effect-a" }]);
    expect(mock.calls[0]!.tags).toContainEqual({
      name: RESEND_EFFECT_ID_TAG,
      value: "effect-a",
    });
    expect(result).toMatchObject({ id: "resend-msg-1", provider: "resend" });
    expect(JSON.stringify(result)).not.toContain("project-resend-secret");
  });

  test("rejects invalid input before constructing a provider client", async () => {
    let clients = 0;
    const driver = createResendEffectAdapterDriver(() => {
      clients += 1;
      throw new Error("provider client should not be created");
    });

    await expect(
      driver.execute(
        { from: "sender@example.com", subject: "", to: [] },
        effectContext(),
      ),
    ).rejects.toThrow("require recipients");
    expect(clients).toBe(0);
  });
});

describe("verifyResendEffectWebhook", () => {
  test("verifies the raw body and returns only normalized effect evidence", () => {
    const secret = testWebhookSecret();
    const payload = JSON.stringify({
      created_at: "2026-07-21T12:00:00.000Z",
      data: {
        created_at: "2026-07-21T12:00:00.000Z",
        email_id: "email-a",
        from: "private-sender@example.com",
        subject: "Private subject",
        tags: { [RESEND_EFFECT_ID_TAG]: "effect-a" },
        to: ["private-recipient@example.com"],
      },
      type: "email.delivered",
    });
    const id = "msg_test_delivery";
    const timestamp = new Date();
    const signature = new Webhook(secret).sign(id, timestamp, payload);
    const evidence = verifyResendEffectWebhook({
      headers: {
        id,
        signature,
        timestamp: String(Math.floor(timestamp.getTime() / 1000)),
      },
      payload,
      receivedAt: 2,
      tenantId: "tenant-a",
      webhookSecret: secret,
    });

    expect(evidence).toEqual({
      deliveryId: id,
      effectId: "effect-a",
      eventType: "email.delivered",
      evidenceReference: `resend:webhook:${id}`,
      occurredAt: Date.parse("2026-07-21T12:00:00.000Z"),
      outcome: "confirmed_succeeded",
      provider: "resend",
      providerResourceId: "email-a",
      receivedAt: 2,
      tenantId: "tenant-a",
      verifier: "resend-sdk@6",
    });
    expect(JSON.stringify(evidence)).not.toContain("Private");
    expect(JSON.stringify(evidence)).not.toContain("recipient");
  });

  test("rejects an invalid signature", () => {
    expect(() =>
      verifyResendEffectWebhook({
        headers: {
          id: "msg_invalid",
          signature: "v1,invalid",
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
        payload: "{}",
        tenantId: "tenant-a",
        webhookSecret: testWebhookSecret(),
      }),
    ).toThrow();
  });
});
