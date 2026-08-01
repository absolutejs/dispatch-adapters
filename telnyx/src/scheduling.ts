import type {
  MessagingScheduledMessageReport,
  MessagingSchedulingCapability,
} from "@absolutejs/dispatch";
import type { TelnyxClientLike } from "./adapter";

export type TelnyxScheduledMessageReport = MessagingScheduledMessageReport;

const stateOf = (status: string): TelnyxScheduledMessageReport["state"] => {
  if (status === "cancelled") return "canceled";
  if (["delivered", "delivery_unconfirmed", "sent"].includes(status))
    return "sent";
  if (["delivery_failed", "expired", "sending_failed"].includes(status))
    return "failed";
  return "pending";
};

const resourceOf = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  return row.data !== null && typeof row.data === "object"
    ? (row.data as Record<string, unknown>)
    : row;
};

export const createTelnyxScheduledMessageManager = (
  client: Pick<TelnyxClientLike, "messages">,
): MessagingSchedulingCapability => ({
  cancel: async (messageId: string): Promise<TelnyxScheduledMessageReport> => {
    const response = await client.messages.cancelScheduled(messageId);
    const resource = resourceOf(response);
    return {
      messageId: typeof resource.id === "string" ? resource.id : messageId,
      providerStatus: "cancelled",
      state: "canceled",
    };
  },
  inspect: async (messageId: string): Promise<TelnyxScheduledMessageReport> => {
    const response = await client.messages.retrieve(messageId);
    const resource = resourceOf(response);
    const status =
      typeof resource.status === "string" ? resource.status : "unknown";
    return {
      messageId: typeof resource.id === "string" ? resource.id : messageId,
      providerStatus: status,
      state: stateOf(status),
    };
  },
});
