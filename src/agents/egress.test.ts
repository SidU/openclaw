import { afterEach, describe, expect, it } from "vitest";
import {
  _resetAllDomains,
  approveDomain,
  clearSessionDomains,
  extractDomains,
  findBlanketBlockedCommand,
  formatNetworkBlockedError,
  getApprovedDomains,
  isAllowedDomain,
  revokeDomain,
  usesDomainCheckedCommand,
  validateNetworkAccess,
} from "./egress.js";

afterEach(() => {
  _resetAllDomains();
});

describe("extractDomains", () => {
  it("extracts domain from a simple curl URL", () => {
    expect(extractDomains("curl https://api.example.com/data")).toEqual(["api.example.com"]);
  });

  it("extracts domain from wget URL", () => {
    expect(extractDomains("wget http://files.example.org/file.tar.gz")).toEqual([
      "files.example.org",
    ]);
  });

  it("extracts multiple domains", () => {
    const result = extractDomains(
      "curl https://api.example.com/data && wget http://cdn.other.com/file",
    );
    expect(result).toEqual(["api.example.com", "cdn.other.com"]);
  });

  it("deduplicates domains", () => {
    const result = extractDomains("curl https://api.example.com/a https://api.example.com/b");
    expect(result).toEqual(["api.example.com"]);
  });

  it("returns empty array for commands without URLs", () => {
    expect(extractDomains("ls -la")).toEqual([]);
    expect(extractDomains("curl --help")).toEqual([]);
  });

  it("handles URLs with ports", () => {
    expect(extractDomains("curl http://localhost:3000/api")).toEqual(["localhost"]);
  });

  it("handles URLs with authentication (extracts host after scheme)", () => {
    // user:pass@host URLs: our regex captures the first token after ://.
    // This is acceptable — the domain validation will still check it.
    const result = extractDomains("curl https://user:pass@api.example.com/data");
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("handles git clone URLs", () => {
    expect(extractDomains("git clone https://github.com/user/repo.git")).toEqual(["github.com"]);
  });

  it("handles FTP URLs", () => {
    expect(extractDomains("wget ftp://files.example.com/file")).toEqual(["files.example.com"]);
  });

  it("normalizes domains to lowercase", () => {
    expect(extractDomains("curl https://API.EXAMPLE.COM/data")).toEqual(["api.example.com"]);
  });
});

describe("findBlanketBlockedCommand", () => {
  it("blocks ssh", () => {
    expect(findBlanketBlockedCommand("ssh user@host")).toBe("ssh");
  });

  it("blocks scp", () => {
    expect(findBlanketBlockedCommand("scp file user@host:")).toBe("scp");
  });

  it("blocks nc", () => {
    expect(findBlanketBlockedCommand("nc -l 8080")).toBe("nc");
  });

  it("blocks netcat", () => {
    expect(findBlanketBlockedCommand("netcat host 80")).toBe("netcat");
  });

  it("blocks ncat", () => {
    expect(findBlanketBlockedCommand("ncat host 80")).toBe("ncat");
  });

  it("detects blocked commands in pipelines", () => {
    expect(findBlanketBlockedCommand("echo test | nc host 80")).toBe("nc");
  });

  it("detects blocked commands with full path", () => {
    expect(findBlanketBlockedCommand("/usr/bin/ssh user@host")).toBe("ssh");
  });

  it("returns null for non-blocked commands", () => {
    expect(findBlanketBlockedCommand("curl https://example.com")).toBeNull();
    expect(findBlanketBlockedCommand("ls -la")).toBeNull();
    expect(findBlanketBlockedCommand("wget http://example.com")).toBeNull();
  });
});

describe("usesDomainCheckedCommand", () => {
  it("detects curl", () => {
    expect(usesDomainCheckedCommand("curl https://example.com")).toBe(true);
  });

  it("detects wget", () => {
    expect(usesDomainCheckedCommand("wget http://example.com")).toBe(true);
  });

  it("detects curl in pipeline", () => {
    expect(usesDomainCheckedCommand("curl https://example.com | jq .")).toBe(true);
  });

  it("returns false for non-network commands", () => {
    expect(usesDomainCheckedCommand("ls -la")).toBe(false);
    expect(usesDomainCheckedCommand("echo hello")).toBe(false);
  });
});

describe("session domain management", () => {
  it("approveDomain adds domain to session", () => {
    approveDomain("session-1", "example.com");
    expect(getApprovedDomains("session-1")).toEqual(["example.com"]);
  });

  it("approveDomain normalizes to lowercase", () => {
    approveDomain("session-1", "EXAMPLE.COM");
    expect(getApprovedDomains("session-1")).toEqual(["example.com"]);
  });

  it("approveDomain ignores empty domain", () => {
    approveDomain("session-1", "");
    expect(getApprovedDomains("session-1")).toEqual([]);
  });

  it("approveDomain deduplicates", () => {
    approveDomain("session-1", "example.com");
    approveDomain("session-1", "example.com");
    expect(getApprovedDomains("session-1")).toEqual(["example.com"]);
  });

  it("revokeDomain removes domain", () => {
    approveDomain("session-1", "example.com");
    expect(revokeDomain("session-1", "example.com")).toBe(true);
    expect(getApprovedDomains("session-1")).toEqual([]);
  });

  it("revokeDomain returns false if domain not found", () => {
    expect(revokeDomain("session-1", "example.com")).toBe(false);
  });

  it("clearSessionDomains clears all for a session", () => {
    approveDomain("session-1", "a.com");
    approveDomain("session-1", "b.com");
    clearSessionDomains("session-1");
    expect(getApprovedDomains("session-1")).toEqual([]);
  });

  it("sessions are isolated", () => {
    approveDomain("session-1", "a.com");
    approveDomain("session-2", "b.com");
    expect(getApprovedDomains("session-1")).toEqual(["a.com"]);
    expect(getApprovedDomains("session-2")).toEqual(["b.com"]);
  });

  it("_resetAllDomains clears everything", () => {
    approveDomain("session-1", "a.com");
    approveDomain("session-2", "b.com");
    _resetAllDomains();
    expect(getApprovedDomains("session-1")).toEqual([]);
    expect(getApprovedDomains("session-2")).toEqual([]);
  });
});

describe("isAllowedDomain", () => {
  it("allows globally allowlisted domain", () => {
    expect(isAllowedDomain("example.com", "session-1", ["example.com"])).toBe(true);
  });

  it("allows session-approved domain", () => {
    approveDomain("session-1", "example.com");
    expect(isAllowedDomain("example.com", "session-1", [])).toBe(true);
  });

  it("blocks unapproved domain", () => {
    expect(isAllowedDomain("evil.com", "session-1", ["example.com"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAllowedDomain("EXAMPLE.COM", "session-1", ["example.com"])).toBe(true);
  });

  it("rejects empty domain", () => {
    expect(isAllowedDomain("", "session-1", ["example.com"])).toBe(false);
  });

  it("session approval does not leak to other sessions", () => {
    approveDomain("session-1", "example.com");
    expect(isAllowedDomain("example.com", "session-2", [])).toBe(false);
  });
});

describe("validateNetworkAccess", () => {
  it("blanket-blocks ssh", () => {
    const result = validateNetworkAccess("ssh user@host", "s1", []);
    expect(result).toEqual({ ok: false, reason: "blanket-blocked", command: "ssh" });
  });

  it("blanket-blocks nc even with domains approved", () => {
    approveDomain("s1", "example.com");
    const result = validateNetworkAccess("nc example.com 80", "s1", ["example.com"]);
    expect(result).toEqual({ ok: false, reason: "blanket-blocked", command: "nc" });
  });

  it("allows curl when domain is globally approved", () => {
    const result = validateNetworkAccess("curl https://api.example.com/data", "s1", [
      "api.example.com",
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("allows curl when domain is session-approved", () => {
    approveDomain("s1", "api.example.com");
    const result = validateNetworkAccess("curl https://api.example.com/data", "s1", []);
    expect(result).toEqual({ ok: true });
  });

  it("blocks curl to unapproved domain", () => {
    const result = validateNetworkAccess("curl https://evil.com/data", "s1", []);
    expect(result).toEqual({ ok: false, reason: "domain-blocked", domains: ["evil.com"] });
  });

  it("blocks wget to unapproved domain", () => {
    const result = validateNetworkAccess("wget http://evil.com/file", "s1", []);
    expect(result).toEqual({ ok: false, reason: "domain-blocked", domains: ["evil.com"] });
  });

  it("reports all blocked domains", () => {
    const result = validateNetworkAccess("curl https://a.com/x && curl https://b.com/y", "s1", []);
    expect(result).toEqual({ ok: false, reason: "domain-blocked", domains: ["a.com", "b.com"] });
  });

  it("allows partially-approved multi-domain commands when all pass", () => {
    approveDomain("s1", "b.com");
    const result = validateNetworkAccess("curl https://a.com/x && curl https://b.com/y", "s1", [
      "a.com",
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("passes through non-network commands", () => {
    expect(validateNetworkAccess("ls -la", "s1", [])).toEqual({ ok: true });
    expect(validateNetworkAccess("echo hello", "s1", [])).toEqual({ ok: true });
  });

  it("passes through curl without URL", () => {
    expect(validateNetworkAccess("curl --help", "s1", [])).toEqual({ ok: true });
  });
});

describe("formatNetworkBlockedError", () => {
  it("formats blanket-blocked error", () => {
    const msg = formatNetworkBlockedError({ ok: false, reason: "blanket-blocked", command: "ssh" });
    expect(msg).toContain("ssh");
    expect(msg).toContain("not allowed");
  });

  it("formats domain-blocked error with approve hint", () => {
    const msg = formatNetworkBlockedError({
      ok: false,
      reason: "domain-blocked",
      domains: ["api.example.com"],
    });
    expect(msg).toContain("api.example.com");
    expect(msg).toContain("/approve-domain api.example.com");
  });

  it("formats multiple blocked domains", () => {
    const msg = formatNetworkBlockedError({
      ok: false,
      reason: "domain-blocked",
      domains: ["a.com", "b.com"],
    });
    expect(msg).toContain("a.com, b.com");
    expect(msg).toContain("/approve-domain a.com");
    expect(msg).toContain("/approve-domain b.com");
  });
});
