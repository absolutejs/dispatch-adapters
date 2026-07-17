import { createDispatcher } from "@absolutejs/dispatch";
import { describe, expect, test } from "bun:test";
import { createFcmAdapter } from "../src";

const auth = {
  getClient: async () => ({
    getAccessToken: async () => ({ token: "short-lived-token" }),
  }),
};

describe("FCM push adapter", () => {
  test("sends a token notification through the HTTP v1 contract", async () => {
    const requests: Array<{ body: unknown; headers: Headers; url: string }> =
      [];
    const adapter = createFcmAdapter({
      auth,
      fetch: async (input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(input),
        });

        return Response.json({ name: "projects/site/messages/123" });
      },
      projectId: "site",
    });
    const result = await createDispatcher({ push: adapter }).push({
      body: "Build completed",
      data: { attempts: 2, projectId: "project-1" },
      title: "Deployment ready",
      to: "device-token",
    });

    expect(result).toMatchObject({
      id: "projects/site/messages/123",
      provider: "fcm",
    });
    expect(requests[0]?.url).toBe(
      "https://fcm.googleapis.com/v1/projects/site/messages:send",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer short-lived-token",
    );
    expect(requests[0]?.body).toEqual({
      message: {
        data: { attempts: "2", projectId: "project-1" },
        notification: { body: "Build completed", title: "Deployment ready" },
        token: "device-token",
      },
    });
  });

  test("normalizes topics and provider errors", async () => {
    const adapter = createFcmAdapter({
      auth,
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          message: { topic: "operations" },
        });

        return Response.json(
          {
            error: {
              message: "Registration token is invalid",
              status: "INVALID_ARGUMENT",
            },
          },
          { status: 400 },
        );
      },
      projectId: "site",
    });

    await expect(
      adapter.send({ body: "Incident", to: "/topics/operations" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      status: 400,
    });
  });
});
