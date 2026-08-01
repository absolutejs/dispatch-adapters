import { describe, expect, test } from "bun:test";
import { PinpointSMSVoiceV2Client } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import {
  createAwsEndUserMessagingAdapter,
  createAwsEndUserMessagingEventHandler,
  createMemoryWebhookInboxStore,
  drainAwsEndUserMessagingEventInbox,
} from "../src";

const commandInput = (command: unknown) =>
  (command as { input: Record<string, unknown> }).input;

describe("AWS End User Messaging adapter", () => {
  test("accepts the official AWS SDK v3 clients", () => {
    const adapter = createAwsEndUserMessagingAdapter({
      client: new PinpointSMSVoiceV2Client({ region: "us-east-1" }),
      socialClient: new SocialMessagingClient({ region: "us-east-1" }),
      whatsappPhoneNumberId: "phone-number-id-1",
    });
    expect(adapter.name).toBe("aws-end-user-messaging");
  });

  test("sends transactional SMS through a protected pool", async () => {
    const commands: unknown[] = [];
    const adapter = createAwsEndUserMessagingAdapter({
      client: {
        send: async (command) => {
          commands.push(command);
          return { MessageId: "aws-1" };
        },
      },
      configurationSetName: "alerts-events",
      messageType: "TRANSACTIONAL",
      originationIdentity: "pool-alerts",
      protectConfigurationId: "protect-alerts",
    });
    const result = await adapter.send({
      content: { kind: "text", text: "Incident opened" },
      consent: { programId: "alerts", purpose: "incident-alerts" },
      idempotencyKey: "incident-1",
      tenant: "acme",
      to: { address: "+12025550100", transport: "sms" },
    });
    expect(commandInput(commands[0])).toMatchObject({
      ConfigurationSetName: "alerts-events",
      Context: { absoluteIdempotencyKey: "incident-1", absoluteTenant: "acme" },
      DestinationPhoneNumber: "+12025550100",
      MessageBody: "Incident opened",
      MessageType: "TRANSACTIONAL",
      OriginationIdentity: "pool-alerts",
      ProtectConfigurationId: "protect-alerts",
    });
    expect(result).toMatchObject({
      id: "aws-1",
      provider: "aws-end-user-messaging",
    });
  });

  test("uses rich RCS with explicit SMS fallback", async () => {
    const commands: unknown[] = [];
    const adapter = createAwsEndUserMessagingAdapter({
      client: {
        send: async (command) => {
          commands.push(command);
          return { MessageId: "rcs-1" };
        },
      },
      originationIdentity: "pool-rcs-alerts",
    });
    await adapter.send({
      content: { kind: "rich", text: "Open incident", title: "Incident" },
      fallbacks: [
        { content: { kind: "text", text: "Open incident" }, transport: "sms" },
      ],
      to: { address: "+12025550100", transport: "rcs" },
    });
    expect(commandInput(commands[0])).toMatchObject({
      DestinationPhoneNumber: "+12025550100",
      FallbackConfiguration: { Channel: "SMS", MessageBody: "Open incident" },
      OriginationIdentity: "pool-rcs-alerts",
      RcsMessageContent: {
        Content: { TextMessage: { Body: "Open incident" } },
      },
    });
  });

  test("uses managed Notify templates", async () => {
    const commands: unknown[] = [];
    const adapter = createAwsEndUserMessagingAdapter({
      client: {
        send: async (command) => {
          commands.push(command);
          return { MessageId: "notify-1" };
        },
      },
      notifyConfigurationId: "notify-auth",
    });
    await adapter.send({
      content: { kind: "template", id: "otp", variables: { code: "123456" } },
      to: { address: "+12025550100", transport: "aws-notify" },
    });
    expect(commandInput(commands[0])).toMatchObject({
      NotifyConfigurationId: "notify-auth",
      TemplateId: "otp",
      TemplateVariables: { code: "123456" },
    });
  });

  test("sends WhatsApp with the social client", async () => {
    const commands: unknown[] = [];
    const adapter = createAwsEndUserMessagingAdapter({
      client: { send: async () => ({}) },
      socialClient: {
        send: async (command) => {
          commands.push(command);
          return { messageId: "wa-1" };
        },
      },
      whatsappPhoneNumberId: "phone-number-id-1",
    });
    const output = await adapter.send({
      content: { kind: "text", text: "Hello" },
      to: { address: "15551234567", transport: "whatsapp" },
    });
    const input = commandInput(commands[0]);
    expect(
      JSON.parse(new TextDecoder().decode(input.message as Uint8Array)),
    ).toMatchObject({
      text: { body: "Hello" },
      to: "15551234567",
      type: "text",
    });
    expect(output.id).toBe("wa-1");
  });

  test("authenticates and durably stores events before effects", async () => {
    const inbox = createMemoryWebhookInboxStore<string>();
    const handler = createAwsEndUserMessagingEventHandler({
      inbox,
      verify: (headers) => headers.get("authorization") === "trusted",
    });
    const body = JSON.stringify({
      detail: { eventType: "DELIVERED", messageId: "aws-1" },
      id: "event-1",
      time: "2026-08-01T12:00:00Z",
    });
    expect(
      (
        await handler(
          new Request("https://site.test/aws", { body, method: "POST" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request("https://site.test/aws", {
            body,
            headers: { authorization: "trusted" },
            method: "POST",
          }),
        )
      ).status,
    ).toBe(202);
    const events: unknown[] = [];
    expect(
      await drainAwsEndUserMessagingEventInbox({
        inbox,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).toBe(1);
    expect(events[0]).toMatchObject({
      eventId: "event-1",
      messageId: "aws-1",
      status: "delivered",
    });
  });
});
