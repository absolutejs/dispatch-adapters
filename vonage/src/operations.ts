import type { Vonage } from "@vonage/server-sdk";

export type VonageMessageControlClientLike = {
  messages: Pick<Vonage["messages"], "updateMessage">;
};

export const createVonageMessageController = (
  client: VonageMessageControlClientLike,
) => ({
  markWhatsAppRead: (messageId: string) =>
    client.messages.updateMessage(messageId, "read", undefined as never),
  revokeRcsMessage: (messageId: string) =>
    client.messages.updateMessage(messageId, "revoked", undefined as never),
});

export type VonageRcsCapabilities = {
  features: ReadonlyArray<string>;
  reachable: boolean;
};

export type VonageRcsCapabilityClientLike = {
  getDeviceCapabilities: (
    agentId: string,
    phoneNumber: string,
  ) => Promise<{ features: ReadonlyArray<string> } | undefined>;
};

export const createVonageRcsCapabilityManager = (
  client: VonageRcsCapabilityClientLike,
) => ({
  inspect: async (
    agentId: string,
    phoneNumber: string,
  ): Promise<VonageRcsCapabilities> => {
    if (agentId.trim().length === 0) throw new Error("agentId is required");
    const number = phoneNumber.replace(/^\+/, "");
    if (!/^\d{7,15}$/.test(number)) {
      throw new Error("phoneNumber must contain 7-15 E.164 digits");
    }
    const result = await client.getDeviceCapabilities(agentId, number);
    return result === undefined
      ? { features: [], reachable: false }
      : { features: [...result.features], reachable: true };
  },
});
