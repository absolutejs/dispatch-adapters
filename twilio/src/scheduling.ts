import type {
  MessagingScheduledMessageReport,
  MessagingSchedulingCapability,
} from "@absolutejs/dispatch";
import { TwilioConfigurationError } from "./adapter";

export type TwilioScheduledMessageStatus =
  | "accepted"
  | "canceled"
  | "delivered"
  | "failed"
  | "queued"
  | "read"
  | "scheduled"
  | "sending"
  | "sent"
  | "undelivered";

export type TwilioScheduledMessageResource = {
  dateUpdated?: Date;
  errorCode?: number | null;
  errorMessage?: string | null;
  sendAt?: Date | null;
  sid: string;
  status: TwilioScheduledMessageStatus | string;
};

export type TwilioScheduledMessageClientLike = {
  messages: (messageSid: string) => {
    fetch: () => Promise<TwilioScheduledMessageResource>;
    update: (input: {
      status: "canceled";
    }) => Promise<TwilioScheduledMessageResource>;
  };
};

export type TwilioScheduledMessageReport = MessagingScheduledMessageReport & {
  errorCode?: number;
  errorMessage?: string;
  sendAt?: string;
  updatedAt?: string;
};

const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const STATUSES = new Set<TwilioScheduledMessageStatus>([
  "accepted",
  "canceled",
  "delivered",
  "failed",
  "queued",
  "read",
  "scheduled",
  "sending",
  "sent",
  "undelivered",
]);

const normalize = (
  resource: TwilioScheduledMessageResource,
): TwilioScheduledMessageReport => {
  if (
    !MESSAGE_SID.test(resource.sid) ||
    !STATUSES.has(resource.status as TwilioScheduledMessageStatus)
  ) {
    throw new TwilioConfigurationError(
      "Twilio returned an invalid scheduled message resource",
    );
  }
  const status = resource.status as TwilioScheduledMessageStatus;
  const state =
    status === "canceled"
      ? "canceled"
      : status === "failed" || status === "undelivered"
        ? "failed"
        : status === "delivered" || status === "read" || status === "sent"
          ? "sent"
          : "pending";
  return {
    ...(resource.errorCode === null || resource.errorCode === undefined
      ? {}
      : { errorCode: resource.errorCode }),
    ...(resource.errorMessage === null || resource.errorMessage === undefined
      ? {}
      : { errorMessage: resource.errorMessage }),
    messageId: resource.sid,
    providerStatus: status,
    ...(resource.sendAt === null || resource.sendAt === undefined
      ? {}
      : { sendAt: resource.sendAt.toISOString() }),
    state,
    ...(resource.dateUpdated === undefined
      ? {}
      : { updatedAt: resource.dateUpdated.toISOString() }),
  };
};

const assertSid = (messageSid: string) => {
  if (!MESSAGE_SID.test(messageSid)) {
    throw new TwilioConfigurationError(
      "messageSid must be a Twilio SM or MM SID",
    );
  }
};

/** Cancellation and reconciliation surface for explicitly enabled native schedules. */
export const createTwilioScheduledMessageManager = (
  client: TwilioScheduledMessageClientLike,
): MessagingSchedulingCapability => ({
  cancel: async (messageSid: string) => {
    assertSid(messageSid);
    return normalize(
      await client.messages(messageSid).update({ status: "canceled" }),
    );
  },
  inspect: async (messageSid: string) => {
    assertSid(messageSid);
    return normalize(await client.messages(messageSid).fetch());
  },
});
