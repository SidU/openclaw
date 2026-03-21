import type { ChannelMessageActionContext, OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { handleMSTeamsMessageAction, listMSTeamsActions } from "./actions.js";

// Mock the send-context module
vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: vi.fn(),
}));

// Mock the teams-bot-api module
vi.mock("./teams-bot-api.js", () => ({
  getConversationMembers: vi.fn(),
  getConversationMember: vi.fn(),
  getTeamChannels: vi.fn(),
  getTeamDetails: vi.fn(),
  updateActivity: vi.fn(),
  deleteActivity: vi.fn(),
  replyToActivity: vi.fn(),
}));

import { resolveMSTeamsSendContext } from "./send-context.js";
import {
  deleteActivity,
  getConversationMember,
  getConversationMembers,
  getTeamChannels,
  getTeamDetails,
  replyToActivity,
  updateActivity,
} from "./teams-bot-api.js";

const BASE_CFG = {
  channels: {
    msteams: {
      enabled: true,
      appId: "app-id",
      appPassword: "app-pw",
      tenantId: "tenant-id",
    },
  },
} as unknown as OpenClawConfig;

function buildCtx(
  action: string,
  params: Record<string, unknown>,
  cfg = BASE_CFG,
): ChannelMessageActionContext {
  return {
    channel: "msteams",
    action: action as ChannelMessageActionContext["action"],
    cfg,
    params,
  };
}

const MOCK_PROACTIVE = {
  appId: "app-id",
  conversationId: "19:abc@thread.tacv2",
  ref: {
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    teamId: "team-123",
    conversation: { id: "19:abc@thread.tacv2" },
  },
  serviceUrl: "https://smba.trafficmanager.net/teams/",
  tokenProvider: { getAccessToken: vi.fn(async () => "token") },
  conversationType: "channel" as const,
  adapter: {} as never,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
};

describe("listMSTeamsActions", () => {
  it("returns empty when msteams is disabled", () => {
    const cfg = { channels: { msteams: { enabled: false } } } as unknown as OpenClawConfig;
    expect(listMSTeamsActions(cfg)).toEqual([]);
  });

  it("returns empty when credentials are missing", () => {
    const cfg = { channels: { msteams: { enabled: true } } } as unknown as OpenClawConfig;
    expect(listMSTeamsActions(cfg)).toEqual([]);
  });

  it("returns all actions by default when configured", () => {
    const actions = listMSTeamsActions(BASE_CFG);
    expect(actions).toContain("poll");
    expect(actions).toContain("edit");
    expect(actions).toContain("delete");
    expect(actions).toContain("member-info");
    expect(actions).toContain("channel-info");
    expect(actions).toContain("channel-list");
    expect(actions).toContain("reply");
  });

  it("respects action gates", () => {
    const cfg = {
      channels: {
        msteams: {
          ...BASE_CFG.channels?.msteams,
          actions: { messages: false, channelInfo: false },
        },
      },
    } as unknown as OpenClawConfig;
    const actions = listMSTeamsActions(cfg);
    expect(actions).toContain("poll");
    expect(actions).not.toContain("edit");
    expect(actions).not.toContain("delete");
    expect(actions).not.toContain("channel-info");
    expect(actions).not.toContain("channel-list");
    expect(actions).toContain("member-info");
    expect(actions).toContain("reply");
  });
});

describe("handleMSTeamsMessageAction", () => {
  beforeEach(() => {
    vi.mocked(resolveMSTeamsSendContext).mockResolvedValue(MOCK_PROACTIVE as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("member-info", () => {
    it("fetches a single member when userId is provided", async () => {
      const member = { id: "user1", name: "Alice", email: "alice@test.com" };
      vi.mocked(getConversationMember).mockResolvedValue(member);

      const result = await handleMSTeamsMessageAction(
        buildCtx("member-info", { conversationId: "19:abc@thread.tacv2", userId: "user1" }),
      );

      expect(getConversationMember).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: "user1" }),
      );
      expect(result.details).toEqual({ ok: true, member });
    });

    it("lists all members when no userId is provided", async () => {
      const members = [{ id: "user1" }, { id: "user2" }];
      vi.mocked(getConversationMembers).mockResolvedValue(members);

      const result = await handleMSTeamsMessageAction(
        buildCtx("member-info", { conversationId: "19:abc@thread.tacv2" }),
      );

      expect(getConversationMembers).toHaveBeenCalled();
      expect(result.details).toEqual({ ok: true, members });
    });
  });

  describe("channel-list", () => {
    it("lists channels using teamId from stored ref", async () => {
      const channels = [{ id: "19:general@thread.tacv2", name: "General" }];
      vi.mocked(getTeamChannels).mockResolvedValue(channels);

      const result = await handleMSTeamsMessageAction(
        buildCtx("channel-list", { conversationId: "19:abc@thread.tacv2" }),
      );

      expect(getTeamChannels).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-123" }));
      expect(result.details).toEqual({ ok: true, channels });
    });

    it("uses explicit teamId when provided", async () => {
      vi.mocked(getTeamChannels).mockResolvedValue([]);

      await handleMSTeamsMessageAction(
        buildCtx("channel-list", {
          conversationId: "19:abc@thread.tacv2",
          teamId: "explicit-team",
        }),
      );

      expect(getTeamChannels).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: "explicit-team" }),
      );
    });

    it("throws when no teamId is available", async () => {
      vi.mocked(resolveMSTeamsSendContext).mockResolvedValue({
        ...MOCK_PROACTIVE,
        ref: { ...MOCK_PROACTIVE.ref, teamId: undefined },
      } as never);

      await expect(
        handleMSTeamsMessageAction(
          buildCtx("channel-list", { conversationId: "19:abc@thread.tacv2" }),
        ),
      ).rejects.toThrow(/teamId is required/);
    });
  });

  describe("channel-info", () => {
    it("returns team details and channels", async () => {
      const channels = [{ id: "ch1", name: "General" }];
      const team = { id: "team-123", name: "Engineering" };
      vi.mocked(getTeamChannels).mockResolvedValue(channels);
      vi.mocked(getTeamDetails).mockResolvedValue(team);

      const result = await handleMSTeamsMessageAction(
        buildCtx("channel-info", { conversationId: "19:abc@thread.tacv2" }),
      );

      expect(result.details).toEqual({ ok: true, team, channels });
    });

    it("filters to specific channel when channelId is provided", async () => {
      const channels = [
        { id: "ch1", name: "General" },
        { id: "ch2", name: "Random" },
      ];
      const team = { id: "team-123", name: "Engineering" };
      vi.mocked(getTeamChannels).mockResolvedValue(channels);
      vi.mocked(getTeamDetails).mockResolvedValue(team);

      const result = await handleMSTeamsMessageAction(
        buildCtx("channel-info", {
          conversationId: "19:abc@thread.tacv2",
          channelId: "ch1",
        }),
      );

      expect(result.details).toEqual({
        ok: true,
        channel: { id: "ch1", name: "General" },
        team,
      });
    });
  });

  describe("edit", () => {
    it("updates an activity", async () => {
      vi.mocked(updateActivity).mockResolvedValue({ id: "activity-1" });

      const result = await handleMSTeamsMessageAction(
        buildCtx("edit", {
          conversationId: "19:abc@thread.tacv2",
          messageId: "activity-1",
          message: "Updated text",
        }),
      );

      expect(updateActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: "activity-1",
          text: "Updated text",
        }),
      );
      expect(result.details).toEqual({ ok: true, activityId: "activity-1" });
    });

    it("throws when messageId is missing", async () => {
      await expect(
        handleMSTeamsMessageAction(
          buildCtx("edit", { conversationId: "19:abc@thread.tacv2", message: "text" }),
        ),
      ).rejects.toThrow(/messageId required/);
    });
  });

  describe("delete", () => {
    it("deletes an activity", async () => {
      vi.mocked(deleteActivity).mockResolvedValue(undefined);

      const result = await handleMSTeamsMessageAction(
        buildCtx("delete", {
          conversationId: "19:abc@thread.tacv2",
          messageId: "activity-1",
        }),
      );

      expect(deleteActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activityId: "activity-1" }),
      );
      expect(result.details).toEqual({ ok: true, deleted: "activity-1" });
    });
  });

  describe("reply", () => {
    it("replies to an activity", async () => {
      vi.mocked(replyToActivity).mockResolvedValue({ id: "reply-1" });

      const result = await handleMSTeamsMessageAction(
        buildCtx("reply", {
          conversationId: "19:abc@thread.tacv2",
          messageId: "activity-1",
          message: "Reply text",
        }),
      );

      expect(replyToActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: "activity-1",
          text: "Reply text",
        }),
      );
      expect(result.details).toEqual({ ok: true, activityId: "reply-1" });
    });
  });

  describe("unsupported action", () => {
    it("throws for unknown actions", async () => {
      await expect(
        handleMSTeamsMessageAction(
          buildCtx("unknown-action", { conversationId: "19:abc@thread.tacv2" }),
        ),
      ).rejects.toThrow(/not supported/);
    });
  });
});

// Required vitest imports for beforeEach/afterEach
import { afterEach, beforeEach } from "vitest";
