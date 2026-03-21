/**
 * Thin wrapper around the Bot Framework REST API for operations
 * not exposed by the CloudAdapter abstraction (update, delete, reply,
 * members, teams/channels).
 *
 * Each function accepts a serviceUrl + token and makes direct HTTP calls
 * to the Bot Framework connector endpoints.
 */

import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import type { MSTeamsCredentials } from "./token.js";

const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com";

/** Minimal shape for a Teams channel account returned by the members API. */
export type TeamsChannelAccount = {
  id: string;
  name?: string;
  email?: string;
  givenName?: string;
  surname?: string;
  userPrincipalName?: string;
  objectId?: string;
  aadObjectId?: string;
  userRole?: string;
  tenantId?: string;
};

/** Minimal shape for channel info returned by the teams API. */
export type ChannelInfo = {
  id: string;
  name?: string;
  type?: string;
};

/** Minimal shape for team details returned by the teams API. */
export type TeamDetails = {
  id: string;
  name?: string;
  type?: string;
  aadGroupId?: string;
  channelCount?: number;
  memberCount?: number;
};

/** Response from update/reply activity calls. */
export type ActivityResponse = {
  id: string;
};

async function getToken(tokenProvider: MSTeamsAccessTokenProvider): Promise<string> {
  return await tokenProvider.getAccessToken(BOT_FRAMEWORK_SCOPE);
}

function buildUrl(serviceUrl: string, path: string): string {
  const base = serviceUrl.endsWith("/") ? serviceUrl.slice(0, -1) : serviceUrl;
  return `${base}${path}`;
}

async function botFetch<T>(params: {
  serviceUrl: string;
  path: string;
  method: "GET" | "PUT" | "POST" | "DELETE";
  token: string;
  body?: unknown;
}): Promise<T> {
  const url = buildUrl(params.serviceUrl, params.path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    "Content-Type": "application/json",
  };
  const init: RequestInit = {
    method: params.method,
    headers,
  };
  if (params.body !== undefined) {
    init.body = JSON.stringify(params.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bot Framework API ${params.method} ${params.path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  // DELETE returns 200 with empty body
  if (params.method === "DELETE" || response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** Create a token provider from credentials (convenience for action handler). */
export async function createTokenProvider(
  creds: MSTeamsCredentials,
): Promise<MSTeamsAccessTokenProvider> {
  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  return new sdk.MsalTokenProvider(authConfig) as MSTeamsAccessTokenProvider;
}

/** List all members of a conversation. */
export async function getConversationMembers(params: {
  serviceUrl: string;
  conversationId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<TeamsChannelAccount[]> {
  const token = await getToken(params.tokenProvider);
  return await botFetch<TeamsChannelAccount[]>({
    serviceUrl: params.serviceUrl,
    path: `/v3/conversations/${encodeURIComponent(params.conversationId)}/members`,
    method: "GET",
    token,
  });
}

/** Get a single member of a conversation. */
export async function getConversationMember(params: {
  serviceUrl: string;
  conversationId: string;
  memberId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<TeamsChannelAccount> {
  const token = await getToken(params.tokenProvider);
  return await botFetch<TeamsChannelAccount>({
    serviceUrl: params.serviceUrl,
    path: `/v3/conversations/${encodeURIComponent(params.conversationId)}/members/${encodeURIComponent(params.memberId)}`,
    method: "GET",
    token,
  });
}

/** List channels in a team. */
export async function getTeamChannels(params: {
  serviceUrl: string;
  teamId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<ChannelInfo[]> {
  const token = await getToken(params.tokenProvider);
  const result = await botFetch<{ conversations: ChannelInfo[] }>({
    serviceUrl: params.serviceUrl,
    path: `/v3/teams/${encodeURIComponent(params.teamId)}/conversations`,
    method: "GET",
    token,
  });
  return result.conversations ?? [];
}

/** Get team details. */
export async function getTeamDetails(params: {
  serviceUrl: string;
  teamId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<TeamDetails> {
  const token = await getToken(params.tokenProvider);
  return await botFetch<TeamDetails>({
    serviceUrl: params.serviceUrl,
    path: `/v3/teams/${encodeURIComponent(params.teamId)}`,
    method: "GET",
    token,
  });
}

/** Update (edit) a previously sent activity. */
export async function updateActivity(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  text: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<ActivityResponse> {
  const token = await getToken(params.tokenProvider);
  return await botFetch<ActivityResponse>({
    serviceUrl: params.serviceUrl,
    path: `/v3/conversations/${encodeURIComponent(params.conversationId)}/activities/${encodeURIComponent(params.activityId)}`,
    method: "PUT",
    token,
    body: { type: "message", text: params.text },
  });
}

/** Delete a previously sent activity. */
export async function deleteActivity(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<void> {
  const token = await getToken(params.tokenProvider);
  await botFetch<void>({
    serviceUrl: params.serviceUrl,
    path: `/v3/conversations/${encodeURIComponent(params.conversationId)}/activities/${encodeURIComponent(params.activityId)}`,
    method: "DELETE",
    token,
  });
}

/** Reply to a specific activity in a thread. */
export async function replyToActivity(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  text: string;
  tokenProvider: MSTeamsAccessTokenProvider;
}): Promise<ActivityResponse> {
  const token = await getToken(params.tokenProvider);
  return await botFetch<ActivityResponse>({
    serviceUrl: params.serviceUrl,
    path: `/v3/conversations/${encodeURIComponent(params.conversationId)}/activities/${encodeURIComponent(params.activityId)}`,
    method: "POST",
    token,
    body: { type: "message", text: params.text, replyToId: params.activityId },
  });
}
