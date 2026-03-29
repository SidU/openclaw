import { afterEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsAdapter, type MSTeamsTeamsSdk } from "./sdk.js";
import type { MSTeamsCredentials } from "./token.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function createSdkStub(): MSTeamsTeamsSdk {
  class AppStub {
    async getBotToken() {
      return {
        toString() {
          return "bot-token";
        },
      };
    }
  }

  class ClientStub {
    constructor(_serviceUrl: string, _options: unknown) {}

    conversations = {
      activities: (_conversationId: string) => ({
        create: async (_activity: unknown) => ({ id: "created" }),
      }),
    };
  }

  return {
    App: AppStub as unknown as MSTeamsTeamsSdk["App"],
    Client: ClientStub as unknown as MSTeamsTeamsSdk["Client"],
  };
}

describe("createMSTeamsAdapter", () => {
  it("retries deleteActivity with fresh token on 401", async () => {
    let callCount = 0;
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response(null, { status: 204 });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: "app-id",
      clientSecret: "secret",
      tenantId: "tenant-id",
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      "app-id",
      {
        serviceUrl: "https://service.example.com/",
        conversation: { id: "19:conv@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.deleteActivity("activity-456");
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both calls should target the same URL
    expect(fetchMock.mock.calls[0]![0]).toContain("activity-456");
    expect(fetchMock.mock.calls[1]![0]).toContain("activity-456");
  });

  it("retries updateActivity with fresh token on 401", async () => {
    let callCount = 0;
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ id: "activity-789" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: "app-id",
      clientSecret: "secret",
      tenantId: "tenant-id",
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      "app-id",
      {
        serviceUrl: "https://service.example.com/",
        conversation: { id: "19:conv@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.updateActivity({ id: "activity-789", text: "updated" });
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(fetchMock.mock.calls[1]![1]).toEqual(expect.objectContaining({ method: "PUT" }));
  });

  it("provides deleteActivity in proactive continueConversation contexts", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const creds = {
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
    } satisfies MSTeamsCredentials;
    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: creds.appId,
      clientSecret: creds.appPassword,
      tenantId: creds.tenantId,
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      creds.appId,
      {
        serviceUrl: "https://service.example.com/",
        conversation: { id: "19:conversation@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.deleteActivity("activity-123");
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://service.example.com/v3/conversations/19%3Aconversation%40thread.tacv2/activities/activity-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer bot-token",
        }),
      }),
    );
  });
});
