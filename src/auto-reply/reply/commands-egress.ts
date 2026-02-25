import type { CommandHandler } from "./commands-types.js";
import { approveDomain, getApprovedDomains, revokeDomain } from "../../agents/egress.js";
import { logVerbose } from "../../globals.js";

/**
 * Handle /approve-domain, /revoke-domain, /domains commands.
 *
 * These manage the per-session domain allowlist for network egress policy.
 */
export const handleEgressCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const body = params.command.commandBodyNormalized;

  // /approve-domain <domain>
  const approveMatch = body.match(/^\/approve-domain(?:\s+(.+))?$/i);
  if (approveMatch) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /approve-domain from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const domain = approveMatch[1]?.trim();
    if (!domain) {
      return {
        shouldContinue: false,
        reply: {
          text: "Usage: /approve-domain <domain>\nExample: /approve-domain api.example.com",
        },
      };
    }
    const sessionKey = params.sessionKey ?? "";
    approveDomain(sessionKey, domain);
    logVerbose(`Domain approved: ${domain} for session ${sessionKey}`);
    return {
      shouldContinue: false,
      reply: {
        text: `✅ Domain approved: ${domain.toLowerCase()}\nThe agent can now use curl/wget to access this domain.`,
      },
    };
  }

  // /revoke-domain <domain>
  const revokeMatch = body.match(/^\/revoke-domain(?:\s+(.+))?$/i);
  if (revokeMatch) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /revoke-domain from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const domain = revokeMatch[1]?.trim();
    if (!domain) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /revoke-domain <domain>" },
      };
    }
    const sessionKey = params.sessionKey ?? "";
    const removed = revokeDomain(sessionKey, domain);
    if (removed) {
      logVerbose(`Domain revoked: ${domain} for session ${sessionKey}`);
      return {
        shouldContinue: false,
        reply: { text: `✅ Domain revoked: ${domain.toLowerCase()}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Domain ${domain.toLowerCase()} was not in the session allowlist.` },
    };
  }

  // /domains
  if (/^\/domains\s*$/i.test(body)) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /domains from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const sessionKey = params.sessionKey ?? "";
    const sessionApproved = getApprovedDomains(sessionKey);

    // Resolve global domains from config + env
    const configDomains = params.cfg.tools?.egress?.allowedDomains ?? [];
    const envRaw = process.env.ALLOWED_DOMAINS?.trim();
    const envDomains = envRaw
      ? envRaw
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : [];
    const globalDomains = new Set<string>();
    for (const d of [...configDomains, ...envDomains]) {
      const trimmed = d.trim().toLowerCase();
      if (trimmed) {
        globalDomains.add(trimmed);
      }
    }

    const lines: string[] = ["🌐 Network Egress Domains"];
    if (globalDomains.size > 0) {
      lines.push(`\nGlobal allowlist: ${[...globalDomains].join(", ")}`);
    } else {
      lines.push("\nGlobal allowlist: (none)");
    }
    if (sessionApproved.length > 0) {
      lines.push(`Session approved: ${sessionApproved.join(", ")}`);
    } else {
      lines.push("Session approved: (none)");
    }
    lines.push("\nCommands: /approve-domain <domain> | /revoke-domain <domain>");
    return {
      shouldContinue: false,
      reply: { text: lines.join("\n") },
    };
  }

  return null;
};
