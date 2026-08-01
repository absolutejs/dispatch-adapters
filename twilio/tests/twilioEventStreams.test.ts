import { describe, expect, test } from "bun:test";
import twilio from "twilio";
import {
  createMemoryTwilioEventStreamStore,
  createTwilioEventStreamProcessor,
  drainTwilioEventStreamInbox,
  type TwilioCloudEvent,
} from "../src";

const TOKEN = "event-stream-token";
const URL = "https://app.example.com/webhooks/twilio/events";
const event: TwilioCloudEvent = {
  data: {
    accountSid: `AC${"1".repeat(32)}`,
    messageSid: `SM${"2".repeat(32)}`,
  },
  id: `EZ${"3".repeat(32)}`,
  source: "twilio.messaging",
  specversion: "1.0",
  time: "2026-08-01T12:00:00.000Z",
  type: "com.twilio.messaging.message.delivered",
};

const request = (events: TwilioCloudEvent[], token = TOKEN) => {
  const body = JSON.stringify(events);
  const url = `${URL}?bodySHA256=${twilio.getExpectedBodyHash(body)}`;
  const signature = twilio.getExpectedTwilioSignature(token, url, {});
  return new Request(url, {
    body,
    headers: {
      "content-type": "application/json",
      "x-twilio-signature": signature,
    },
    method: "POST",
  });
};

describe("Twilio Event Streams", () => {
  test("validates raw JSON signatures and deduplicates CloudEvents", async () => {
    const received: TwilioCloudEvent[] = [];
    const process = createTwilioEventStreamProcessor({
      onEvent: (item) => void received.push(item),
      publicUrl: URL,
      resolveAuthTokens: () => [TOKEN],
      store: createMemoryTwilioEventStreamStore(),
    });
    expect((await process(request([event])))[0]?.disposition).toBe("accepted");
    expect((await process(request([event])))[0]?.disposition).toBe("duplicate");
    expect(received).toHaveLength(1);
  });

  test("recovers released work after Event Streams stops retrying", async () => {
    const store = createMemoryTwilioEventStreamStore();
    const process = createTwilioEventStreamProcessor({
      onEvent: () => {
        throw new Error("consumer down");
      },
      publicUrl: URL,
      resolveAuthTokens: () => [TOKEN],
      store,
    });
    await expect(process(request([event]))).rejects.toThrow("consumer down");
    const recovered: string[] = [];
    expect(
      await drainTwilioEventStreamInbox({
        onEvent: (item) => void recovered.push(item.id),
        store,
      }),
    ).toMatchObject({ claimed: 1, completed: 1, errors: [] });
    expect(recovered).toEqual([event.id]);
  });

  test("rejects forged Event Streams signatures", async () => {
    const process = createTwilioEventStreamProcessor({
      onEvent: () => {},
      publicUrl: URL,
      resolveAuthTokens: () => ["different-token"],
      store: createMemoryTwilioEventStreamStore(),
    });
    await expect(process(request([event]))).rejects.toMatchObject({
      status: 403,
    });
  });
});
