import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { buildFileInfoCard, parseFileConsentInvoke, uploadToConsentUrl } from "./file-consent.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getPendingUpload, removePendingUpload } from "./pending-uploads.js";
import type { MSTeamsPollStore } from "./polls.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

type ActivityHandlerFn = (context: unknown, next: () => Promise<void>) => Promise<void>;

export type MSTeamsActivityHandler = {
  onMessage: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  onMembersAdded: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  onMembersRemoved: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  onReactionsAdded: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  onReactionsRemoved: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  onConversationUpdate: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  onInstallationUpdate: (handler: ActivityHandlerFn) => MSTeamsActivityHandler;
  run?: (context: unknown) => Promise<void>;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  appId: string;
  adapter: MSTeamsAdapter;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
};

/**
 * Handle fileConsent/invoke activities for large file uploads.
 */
async function handleFileConsentInvoke(
  context: MSTeamsTurnContext,
  log: MSTeamsMonitorLogger,
): Promise<boolean> {
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {
    return false;
  }

  const consentResponse = parseFileConsentInvoke(activity);
  if (!consentResponse) {
    log.debug?.("invalid file consent invoke", { value: activity.value });
    return false;
  }

  const uploadId =
    typeof consentResponse.context?.uploadId === "string"
      ? consentResponse.context.uploadId
      : undefined;

  if (consentResponse.action === "accept" && consentResponse.uploadInfo) {
    const pendingFile = getPendingUpload(uploadId);
    if (pendingFile) {
      log.debug?.("user accepted file consent, uploading", {
        uploadId,
        filename: pendingFile.filename,
        size: pendingFile.buffer.length,
      });

      try {
        // Upload file to the provided URL
        await uploadToConsentUrl({
          url: consentResponse.uploadInfo.uploadUrl,
          buffer: pendingFile.buffer,
          contentType: pendingFile.contentType,
        });

        // Send confirmation card
        const fileInfoCard = buildFileInfoCard({
          filename: consentResponse.uploadInfo.name,
          contentUrl: consentResponse.uploadInfo.contentUrl,
          uniqueId: consentResponse.uploadInfo.uniqueId,
          fileType: consentResponse.uploadInfo.fileType,
        });

        await context.sendActivity({
          type: "message",
          attachments: [fileInfoCard],
        });

        log.info("file upload complete", {
          uploadId,
          filename: consentResponse.uploadInfo.name,
          uniqueId: consentResponse.uploadInfo.uniqueId,
        });
      } catch (err) {
        log.debug?.("file upload failed", { uploadId, error: String(err) });
        await context.sendActivity(`File upload failed: ${String(err)}`);
      } finally {
        removePendingUpload(uploadId);
      }
    } else {
      log.debug?.("pending file not found for consent", { uploadId });
      await context.sendActivity(
        "The file upload request has expired. Please try sending the file again.",
      );
    }
  } else {
    // User declined
    log.debug?.("user declined file consent", { uploadId });
    removePendingUpload(uploadId);
  }

  return true;
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;
      // Handle file consent invokes before passing to normal flow
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
        const handled = await handleFileConsentInvoke(ctx, deps.log);
        if (handled) {
          // Send invoke response for file consent
          await ctx.sendActivity({ type: "invokeResponse", value: { status: 200 } });
          return;
        }
      }
      return originalRun.call(handler, context);
    };
  }

  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error?.(`msteams handler failed: ${String(err)}`);
    }
    await next();
  });

  // --- Activity event handlers (enqueue system events, no auto-reply) ---

  const core = getMSTeamsRuntime();
  const { cfg } = deps;

  /** Resolve agent route from an activity's conversation context. */
  const resolveRouteFromActivity = (activity: MSTeamsTurnContext["activity"]) => {
    const conversation = activity.conversation;
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat = conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;
    const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "";

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      peer: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    return { route, conversationId, conversationType, isDirectMessage };
  };

  handler.onMembersAdded(async (context, next) => {
    const activity = (context as MSTeamsTurnContext).activity;
    const members = activity?.membersAdded ?? [];
    for (const member of members) {
      if (member.id === activity?.recipient?.id) continue; // skip bot itself
      try {
        const { route, conversationType } = resolveRouteFromActivity(activity);
        const memberLabel = member.name ?? member.id;
        core.system.enqueueSystemEvent(
          `Teams member joined: ${memberLabel} in ${conversationType}`,
          {
            sessionKey: route.sessionKey,
            contextKey: `msteams:member:added:${route.sessionKey}:${member.id}`,
          },
        );
      } catch (err) {
        deps.log.debug?.("failed to enqueue member added event", { error: String(err) });
      }
    }
    await next();
  });

  handler.onMembersRemoved(async (context, next) => {
    const activity = (context as MSTeamsTurnContext).activity;
    const members = activity?.membersRemoved ?? [];
    for (const member of members) {
      if (member.id === activity?.recipient?.id) continue; // skip bot itself
      try {
        const { route, conversationType } = resolveRouteFromActivity(activity);
        const memberLabel = member.name ?? member.id;
        core.system.enqueueSystemEvent(`Teams member left: ${memberLabel} in ${conversationType}`, {
          sessionKey: route.sessionKey,
          contextKey: `msteams:member:removed:${route.sessionKey}:${member.id}`,
        });
      } catch (err) {
        deps.log.debug?.("failed to enqueue member removed event", { error: String(err) });
      }
    }
    await next();
  });

  handler.onReactionsAdded(async (context, next) => {
    const activity = (context as MSTeamsTurnContext).activity;
    const reactions = activity?.reactionsAdded ?? [];
    for (const reaction of reactions) {
      try {
        const { route, conversationType } = resolveRouteFromActivity(activity);
        const senderLabel = activity.from?.name ?? activity.from?.id ?? "unknown";
        core.system.enqueueSystemEvent(
          `Teams reaction added: ${reaction.type} by ${senderLabel} in ${conversationType}`,
          {
            sessionKey: route.sessionKey,
            contextKey: `msteams:reaction:added:${activity.replyToId ?? "unknown"}:${activity.from?.id ?? "unknown"}:${reaction.type}`,
          },
        );
      } catch (err) {
        deps.log.debug?.("failed to enqueue reaction added event", { error: String(err) });
      }
    }
    await next();
  });

  handler.onReactionsRemoved(async (context, next) => {
    const activity = (context as MSTeamsTurnContext).activity;
    const reactions = activity?.reactionsRemoved ?? [];
    for (const reaction of reactions) {
      try {
        const { route, conversationType } = resolveRouteFromActivity(activity);
        const senderLabel = activity.from?.name ?? activity.from?.id ?? "unknown";
        core.system.enqueueSystemEvent(
          `Teams reaction removed: ${reaction.type} by ${senderLabel} in ${conversationType}`,
          {
            sessionKey: route.sessionKey,
            contextKey: `msteams:reaction:removed:${activity.replyToId ?? "unknown"}:${activity.from?.id ?? "unknown"}:${reaction.type}`,
          },
        );
      } catch (err) {
        deps.log.debug?.("failed to enqueue reaction removed event", { error: String(err) });
      }
    }
    await next();
  });

  handler.onConversationUpdate(async (context, next) => {
    const activity = (context as MSTeamsTurnContext).activity;
    const channelData = activity?.channelData as
      | { eventType?: string; channel?: { name?: string }; team?: { name?: string } }
      | undefined;
    const eventType = channelData?.eventType;

    // Channel/team lifecycle events sent via channelData.eventType
    if (
      eventType === "channelCreated" ||
      eventType === "channelDeleted" ||
      eventType === "channelRenamed" ||
      eventType === "teamRenamed"
    ) {
      try {
        const { route } = resolveRouteFromActivity(activity);
        const channelName = channelData?.channel?.name ?? "unknown";
        const teamName = channelData?.team?.name ?? "unknown";
        let description: string;
        switch (eventType) {
          case "channelCreated":
            description = `Teams channel created: ${channelName} in ${teamName}`;
            break;
          case "channelDeleted":
            description = `Teams channel deleted: ${channelName} in ${teamName}`;
            break;
          case "channelRenamed":
            description = `Teams channel renamed: ${channelName} in ${teamName}`;
            break;
          case "teamRenamed":
            description = `Teams team renamed: ${teamName}`;
            break;
        }
        core.system.enqueueSystemEvent(description, {
          sessionKey: route.sessionKey,
          contextKey: `msteams:conversation:${eventType}:${route.sessionKey}:${channelName}`,
        });
      } catch (err) {
        deps.log.debug?.("failed to enqueue conversation update event", { error: String(err) });
      }
    }
    await next();
  });

  handler.onInstallationUpdate(async (context, next) => {
    const activity = (context as MSTeamsTurnContext).activity;
    const action = (activity as unknown as { action?: string }).action ?? "unknown";
    try {
      const { route, conversationType } = resolveRouteFromActivity(activity);
      core.system.enqueueSystemEvent(
        `Teams bot ${action === "add" ? "installed" : action === "remove" ? "uninstalled" : action} in ${conversationType}`,
        {
          sessionKey: route.sessionKey,
          contextKey: `msteams:installation:${action}:${route.sessionKey}`,
        },
      );
    } catch (err) {
      deps.log.debug?.("failed to enqueue installation update event", { error: String(err) });
    }
    await next();
  });

  return handler;
}
