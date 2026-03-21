import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import {
  deleteActivity,
  getConversationMember,
  getConversationMembers,
  getTeamChannels,
  getTeamDetails,
  replyToActivity,
  updateActivity,
} from "./teams-bot-api.js";

const SERVICE_URL = "https://smba.trafficmanager.net/teams/";
const CONVERSATION_ID = "19:abc@thread.tacv2";
const TOKEN = "test-token-123";

function createTokenProvider(): MSTeamsAccessTokenProvider {
  return { getAccessToken: vi.fn(async () => TOKEN) };
}

describe("teams-bot-api", () => {
  let tokenProvider: MSTeamsAccessTokenProvider;

  beforeEach(() => {
    tokenProvider = createTokenProvider();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(status: number, body: unknown) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  function lastFetchCall() {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
  }

  describe("getConversationMembers", () => {
    it("fetches members with correct URL and auth", async () => {
      const members = [{ id: "user1", name: "Alice" }];
      mockFetch(200, members);

      const result = await getConversationMembers({
        serviceUrl: SERVICE_URL,
        conversationId: CONVERSATION_ID,
        tokenProvider,
      });

      expect(result).toEqual(members);
      const [url, init] = lastFetchCall();
      expect(url).toContain("/v3/conversations/");
      expect(url).toContain("/members");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.method).toBe("GET");
    });

    it("throws on non-OK response", async () => {
      mockFetch(403, { message: "Forbidden" });

      await expect(
        getConversationMembers({
          serviceUrl: SERVICE_URL,
          conversationId: CONVERSATION_ID,
          tokenProvider,
        }),
      ).rejects.toThrow(/403/);
    });
  });

  describe("getConversationMember", () => {
    it("fetches a single member", async () => {
      const member = { id: "user1", name: "Alice", email: "alice@example.com" };
      mockFetch(200, member);

      const result = await getConversationMember({
        serviceUrl: SERVICE_URL,
        conversationId: CONVERSATION_ID,
        memberId: "user1",
        tokenProvider,
      });

      expect(result).toEqual(member);
      const [url] = lastFetchCall();
      expect(url).toContain("/members/user1");
    });
  });

  describe("getTeamChannels", () => {
    it("fetches channels and unwraps conversations array", async () => {
      const channels = [
        { id: "19:general@thread.tacv2", name: "General" },
        { id: "19:random@thread.tacv2", name: "Random" },
      ];
      mockFetch(200, { conversations: channels });

      const result = await getTeamChannels({
        serviceUrl: SERVICE_URL,
        teamId: "team-123",
        tokenProvider,
      });

      expect(result).toEqual(channels);
      const [url] = lastFetchCall();
      expect(url).toContain("/v3/teams/team-123/conversations");
    });
  });

  describe("getTeamDetails", () => {
    it("fetches team details", async () => {
      const team = { id: "team-123", name: "Engineering", memberCount: 42 };
      mockFetch(200, team);

      const result = await getTeamDetails({
        serviceUrl: SERVICE_URL,
        teamId: "team-123",
        tokenProvider,
      });

      expect(result).toEqual(team);
      const [url] = lastFetchCall();
      expect(url).toContain("/v3/teams/team-123");
    });
  });

  describe("updateActivity", () => {
    it("sends PUT with correct body", async () => {
      mockFetch(200, { id: "activity-1" });

      const result = await updateActivity({
        serviceUrl: SERVICE_URL,
        conversationId: CONVERSATION_ID,
        activityId: "activity-1",
        text: "Updated text",
        tokenProvider,
      });

      expect(result).toEqual({ id: "activity-1" });
      const [url, init] = lastFetchCall();
      expect(url).toContain("/activities/activity-1");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body as string);
      expect(body.type).toBe("message");
      expect(body.text).toBe("Updated text");
    });
  });

  describe("deleteActivity", () => {
    it("sends DELETE request", async () => {
      mockFetch(200, undefined);

      await deleteActivity({
        serviceUrl: SERVICE_URL,
        conversationId: CONVERSATION_ID,
        activityId: "activity-1",
        tokenProvider,
      });

      const [url, init] = lastFetchCall();
      expect(url).toContain("/activities/activity-1");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("replyToActivity", () => {
    it("sends POST with replyToId", async () => {
      mockFetch(200, { id: "reply-1" });

      const result = await replyToActivity({
        serviceUrl: SERVICE_URL,
        conversationId: CONVERSATION_ID,
        activityId: "activity-1",
        text: "Reply text",
        tokenProvider,
      });

      expect(result).toEqual({ id: "reply-1" });
      const [url, init] = lastFetchCall();
      expect(url).toContain("/activities/activity-1");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.type).toBe("message");
      expect(body.text).toBe("Reply text");
      expect(body.replyToId).toBe("activity-1");
    });
  });
});
