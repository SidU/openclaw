/**
 * Network egress policy — domain-level allowlist for outbound network commands.
 *
 * Two layers:
 * - Global allowlist: admin-configured via config (`tools.egress.allowedDomains`) or
 *   `ALLOWED_DOMAINS` env var.
 * - Per-session allowlist: approved interactively by the user via `/approve-domain`.
 *
 * `curl` and `wget` are domain-checked. `ssh`, `scp`, and `nc` remain blanket-blocked.
 */

/** Per-session domain allowlist (in-memory, cleared on /reset). */
const sessionDomains = new Map<string, Set<string>>();

/** Commands that are always blanket-blocked (not HTTP-based). */
const BLANKET_BLOCKED_COMMANDS = new Set(["ssh", "scp", "nc", "netcat", "ncat"]);

/** Commands that require domain-level validation. */
const DOMAIN_CHECKED_COMMANDS = new Set(["curl", "wget"]);

// URL pattern: match common URL formats in command strings.
// Handles http(s)://, ftp://, and bare domain patterns after curl/wget flags.
const URL_REGEX = /(?:https?|ftp):\/\/([^\s/:@"'\\]+)/gi;

/**
 * Extract unique domains from a shell command string.
 * Parses URLs from curl, wget, git clone, and similar commands.
 */
export function extractDomains(command: string): string[] {
  const domains = new Set<string>();
  const matches = command.matchAll(URL_REGEX);
  for (const match of matches) {
    const host = match[1]?.toLowerCase().trim();
    if (host) {
      domains.add(host);
    }
  }
  return [...domains];
}

/**
 * Check whether a command uses a blanket-blocked network tool.
 * Returns the blocked command name or null.
 */
export function findBlanketBlockedCommand(command: string): string | null {
  const trimmed = command.trim();
  // Split on shell operators to find individual commands in pipelines.
  const segments = trimmed.split(/[|;&]+/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    for (const token of tokens) {
      // Strip leading path (e.g. /usr/bin/ssh -> ssh)
      const base = token.split("/").pop()?.toLowerCase();
      if (base && BLANKET_BLOCKED_COMMANDS.has(base)) {
        return base;
      }
    }
  }
  return null;
}

/**
 * Check whether a command uses a domain-checked network tool (curl/wget).
 */
export function usesDomainCheckedCommand(command: string): boolean {
  const trimmed = command.trim();
  const segments = trimmed.split(/[|;&]+/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    for (const token of tokens) {
      const base = token.split("/").pop()?.toLowerCase();
      if (base && DOMAIN_CHECKED_COMMANDS.has(base)) {
        return true;
      }
    }
  }
  return false;
}

/** Add a domain to a session's allowlist. */
export function approveDomain(sessionKey: string, domain: string): void {
  const normalized = domain.toLowerCase().trim();
  if (!normalized) {
    return;
  }
  let set = sessionDomains.get(sessionKey);
  if (!set) {
    set = new Set();
    sessionDomains.set(sessionKey, set);
  }
  set.add(normalized);
}

/** Remove a domain from a session's allowlist. Returns true if it was present. */
export function revokeDomain(sessionKey: string, domain: string): boolean {
  const normalized = domain.toLowerCase().trim();
  const set = sessionDomains.get(sessionKey);
  if (!set) {
    return false;
  }
  const deleted = set.delete(normalized);
  if (set.size === 0) {
    sessionDomains.delete(sessionKey);
  }
  return deleted;
}

/** Get all approved domains for a session. */
export function getApprovedDomains(sessionKey: string): string[] {
  const set = sessionDomains.get(sessionKey);
  return set ? [...set] : [];
}

/** Clear all session-approved domains for a session (called on /reset). */
export function clearSessionDomains(sessionKey: string): void {
  sessionDomains.delete(sessionKey);
}

/**
 * Check if a domain is allowed by either the global allowlist or the session allowlist.
 */
export function isAllowedDomain(
  domain: string,
  sessionKey: string,
  globalAllowlist: string[],
): boolean {
  const normalized = domain.toLowerCase().trim();
  if (!normalized) {
    return false;
  }
  // Check global allowlist first.
  for (const allowed of globalAllowlist) {
    if (allowed.toLowerCase().trim() === normalized) {
      return true;
    }
  }
  // Check session allowlist.
  const set = sessionDomains.get(sessionKey);
  return set?.has(normalized) ?? false;
}

export type NetworkValidationResult =
  | { ok: true }
  | { ok: false; reason: "blanket-blocked"; command: string }
  | { ok: false; reason: "domain-blocked"; domains: string[] };

/**
 * Validate network access for a command.
 *
 * - `ssh`, `scp`, `nc` are blanket-blocked.
 * - `curl`, `wget` are domain-checked against global + session allowlists.
 * - Other commands pass through.
 */
export function validateNetworkAccess(
  command: string,
  sessionKey: string,
  globalAllowlist: string[],
): NetworkValidationResult {
  // Check blanket-blocked commands first.
  const blocked = findBlanketBlockedCommand(command);
  if (blocked) {
    return { ok: false, reason: "blanket-blocked", command: blocked };
  }

  // Check domain-checked commands.
  if (!usesDomainCheckedCommand(command)) {
    return { ok: true };
  }

  const domains = extractDomains(command);
  if (domains.length === 0) {
    // curl/wget without a URL — let it through (it will fail on its own).
    return { ok: true };
  }

  const blockedDomains: string[] = [];
  for (const domain of domains) {
    if (!isAllowedDomain(domain, sessionKey, globalAllowlist)) {
      blockedDomains.push(domain);
    }
  }

  if (blockedDomains.length > 0) {
    return { ok: false, reason: "domain-blocked", domains: blockedDomains };
  }

  return { ok: true };
}

/**
 * Format an error message for a blocked network access attempt.
 */
export function formatNetworkBlockedError(result: NetworkValidationResult & { ok: false }): string {
  if (result.reason === "blanket-blocked") {
    return `Network command '${result.command}' is not allowed. This command is blocked by security policy.`;
  }
  const domainList = result.domains.join(", ");
  const approveHints = result.domains.map((d) => `/approve-domain ${d}`).join("\n");
  return (
    `Network access to ${domainList} is not approved.\n` +
    `Ask the user to approve the domain(s) by running:\n${approveHints}`
  );
}

/** Reset all session domains (for testing). */
export function _resetAllDomains(): void {
  sessionDomains.clear();
}
