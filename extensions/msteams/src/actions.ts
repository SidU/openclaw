/**
 * MSTeams message action handler/dispatcher.
 *
 * Follows the pattern from Matrix (extensions/matrix/src/actions.ts)
 * and Discord (src/channels/plugins/actions/discord/handle-action.ts).
 */

import {
  createActionGate,
  jsonResult,
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
  type ChannelMessageActionName,
  type MSTeamsActionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
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
import { resolveMSTeamsCredentials } from "./token.js";

function isMSTeamsEnabled(cfg: OpenClawConfig): boolean {
  return (
    cfg.channels?.msteams?.enabled !== false &&
    Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams))
  );
}

function createMSTeamsActionGate(cfg: OpenClawConfig) {
  return createActionGate<MSTeamsActionConfig>(cfg.channels?.msteams?.actions);
}

export function listMSTeamsActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  if (!isMSTeamsEnabled(cfg)) {
    return [];
  }
  const gate = createMSTeamsActionGate(cfg);
  const actions: ChannelMessageActionName[] = ["poll"];
  if (gate("messages")) {
    actions.push("edit", "delete");
  }
  if (gate("memberInfo")) {
    actions.push("member-info");
  }
  if (gate("channelInfo")) {
    actions.push("channel-info", "channel-list");
  }
  if (gate("threads")) {
    actions.push("reply");
  }
  return actions;
}

async function resolveContext(cfg: OpenClawConfig, params: Record<string, unknown>) {
  const conversationId = readStringParam(params, "conversationId") ?? readStringParam(params, "to");
  if (!conversationId) {
    throw new Error("conversationId (or to) is required");
  }
  const ctx = await resolveMSTeamsSendContext({ cfg, to: conversationId });
  if (!ctx.ref.serviceUrl) {
    throw new Error("No serviceUrl in stored conversation reference");
  }
  return { ...ctx, serviceUrl: ctx.ref.serviceUrl };
}

export async function handleMSTeamsMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<ReturnType<NonNullable<ChannelMessageActionAdapter["handleAction"]>>> {
  const { action, params, cfg } = ctx;

  if (action === "member-info") {
    const proactive = await resolveContext(cfg, params);
    const memberId = readStringParam(params, "userId") ?? readStringParam(params, "memberId");
    if (memberId) {
      const member = await getConversationMember({
        serviceUrl: proactive.serviceUrl,
        conversationId: proactive.conversationId,
        memberId,
        tokenProvider: proactive.tokenProvider,
      });
      return jsonResult({ ok: true, member });
    }
    // No specific member → list all
    const members = await getConversationMembers({
      serviceUrl: proactive.serviceUrl,
      conversationId: proactive.conversationId,
      tokenProvider: proactive.tokenProvider,
    });
    return jsonResult({ ok: true, members });
  }

  if (action === "channel-list") {
    const proactive = await resolveContext(cfg, params);
    const teamId = readStringParam(params, "teamId") ?? proactive.ref.teamId;
    if (!teamId) {
      throw new Error(
        "teamId is required. Provide it explicitly or ensure the conversation is in a team channel.",
      );
    }
    const channels = await getTeamChannels({
      serviceUrl: proactive.serviceUrl,
      teamId,
      tokenProvider: proactive.tokenProvider,
    });
    return jsonResult({ ok: true, channels });
  }

  if (action === "channel-info") {
    const proactive = await resolveContext(cfg, params);
    const teamId = readStringParam(params, "teamId") ?? proactive.ref.teamId;
    if (!teamId) {
      throw new Error(
        "teamId is required. Provide it explicitly or ensure the conversation is in a team channel.",
      );
    }
    const channelId = readStringParam(params, "channelId");
    // Bot Framework only provides list; filter if channelId specified
    const channels = await getTeamChannels({
      serviceUrl: proactive.serviceUrl,
      teamId,
      tokenProvider: proactive.tokenProvider,
    });
    if (channelId) {
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) {
        throw new Error(`Channel ${channelId} not found in team ${teamId}`);
      }
      // Also fetch team details for context
      const team = await getTeamDetails({
        serviceUrl: proactive.serviceUrl,
        teamId,
        tokenProvider: proactive.tokenProvider,
      });
      return jsonResult({ ok: true, channel, team });
    }
    const team = await getTeamDetails({
      serviceUrl: proactive.serviceUrl,
      teamId,
      tokenProvider: proactive.tokenProvider,
    });
    return jsonResult({ ok: true, team, channels });
  }

  if (action === "edit") {
    const proactive = await resolveContext(cfg, params);
    const activityId = readStringParam(params, "messageId", { required: true });
    const text = readStringParam(params, "message", { required: true });
    const result = await updateActivity({
      serviceUrl: proactive.serviceUrl,
      conversationId: proactive.conversationId,
      activityId: activityId!,
      text: text!,
      tokenProvider: proactive.tokenProvider,
    });
    return jsonResult({ ok: true, activityId: result.id });
  }

  if (action === "delete") {
    const proactive = await resolveContext(cfg, params);
    const activityId = readStringParam(params, "messageId", { required: true });
    await deleteActivity({
      serviceUrl: proactive.serviceUrl,
      conversationId: proactive.conversationId,
      activityId: activityId!,
      tokenProvider: proactive.tokenProvider,
    });
    return jsonResult({ ok: true, deleted: activityId });
  }

  if (action === "reply") {
    const proactive = await resolveContext(cfg, params);
    const activityId = readStringParam(params, "messageId", { required: true });
    const text = readStringParam(params, "message", { required: true });
    const result = await replyToActivity({
      serviceUrl: proactive.serviceUrl,
      conversationId: proactive.conversationId,
      activityId: activityId!,
      text: text!,
      tokenProvider: proactive.tokenProvider,
    });
    return jsonResult({ ok: true, activityId: result.id });
  }

  throw new Error(`Action ${action} is not supported for provider msteams.`);
}
