/**
 * Privacy boundary for Agentarium's browser-facing data.
 *
 * The observer reads untrusted local state, but the API only ever returns an
 * allowlisted projection.  This module is deliberately independent from the
 * SQLite adapter so it can be used by tests and by any future data source.
 */

import { isIP } from "node:net";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// These patterns are intentionally conservative.  A false positive costs a
// little display detail; a false negative could publish private state.
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk|sess|secret|token|key)-[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:sk|rk|pk|sess|secret|token|key)_[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token|cookie)\s*[:=]\s*["']?[^\s,;"'}`]+/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const EMAIL_PATTERN = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi;

// Absolute paths are not useful to the UI and can expose the user's home or
// another machine's layout.  Handle Unix, Windows, and common URI forms.
const ABSOLUTE_PATH_PATTERNS = [
  /(?:^|[^\p{L}\p{N}.\/\\])(?:~[\\/]|\/(?!\/)|[A-Za-z]:\\)[^\r\n"\s]+(?:[ \t]+(?![A-Za-z_][A-Za-z0-9_.-]*\s*[:=])[^\r\n"\s]+)*/gu,
  /(?:^|[^\p{L}\p{N}.\/\\])file:\/\/[^\r\n"\s]+(?:[ \t]+(?![A-Za-z_][A-Za-z0-9_.-]*\s*[:=])[^\r\n"\s]+)*/giu,
];

// IPv4 is redacted even when it is technically loopback.  The browser does
// not need network identity, and this keeps internal topology out of the
// snapshot contract.
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// Candidate matching is deliberately broader than validation so compressed
// forms such as `fe80::1` can be passed to node:net's complete parser.
const IPV6_PATTERN = /(?<![A-Za-z0-9])[0-9A-F:.]{2,45}(?![A-Za-z0-9])/gi;

function isValidIPv6(value) {
  return isIP(value) === 6;
}

const SENSITIVE_KEY_TERMS = [
  "raw", "transcript", "payload", "argument", "command", "cwd", "path", "secret", "password", "passwd",
  "filepath", "pathname", "email", "address", "ip", "output", "content", "rollout", "origin", "error_json", "first_user",
];

function isSensitiveKey(key) {
  if (typeof key !== "string" || !key) return false;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return SENSITIVE_KEY_TERMS.some((term) => normalized === term
    || normalized.startsWith(`${term}_`)
    || normalized.endsWith(`_${term}`)
    || normalized.includes(`_${term}_`));
}

/**
 * Replace sensitive fragments in a display label.
 *
 * @param {unknown} input
 * @returns {{value: string, redactions: number}}
 */
export function redactText(input) {
  if (input === null || input === undefined) return { value: "", redactions: 0 };
  let value = typeof input === "string" ? input : String(input);
  let redactions = 0;

  const replace = (pattern, replacement, predicate = () => true) => {
    value = value.replace(pattern, (...args) => {
      const match = args[0];
      if (!predicate(match)) return match;
      // The final argument is the complete input for a non-named regexp.  A
      // replacement function gives us an exact count without exposing text.
      redactions += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
  };

  replace(CONTROL_CHARACTERS, " ");
  for (const pattern of SECRET_PATTERNS) replace(pattern, "[redacted]");
  replace(EMAIL_PATTERN, "[redacted-email]");
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    // Preserve the leading delimiter so labels do not accidentally join.
    replace(pattern, (match) => {
      const prefix = match.match(/^[^\p{L}\p{N}.\/\\]/u)?.[0] ?? "";
      return `${prefix}[redacted-path]`;
    });
  }
  replace(IPV6_PATTERN, "[redacted-ip]", isValidIPv6);
  replace(IPV4_PATTERN, "[redacted-ip]");

  value = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return { value, redactions };
}

/**
 * Return a bounded, display-safe label.  Long free-form strings are treated
 * as transcript-like and collapsed to a generic label instead of being sent
 * to the browser.
 */
export function safeLabel(input, fallback = "Unnamed task", maxLength = 96) {
  const result = redactText(input);
  if (!result.value) return { value: fallback, redactions: result.redactions };
  if (result.value.length > maxLength) {
    return { value: `${result.value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`, redactions: result.redactions + 1 };
  }
  return result;
}

/**
 * Scan an arbitrary candidate payload.  This is a fail-closed diagnostic, not
 * the producer's allowlist.  It catches accidental raw fields and common
 * secret/path/network patterns, including nested values.
 */
export function scanPrivacy(value) {
  const findings = [];
  const seen = new WeakSet();

  const visit = (current, path) => {
    if (current === null || current === undefined) return;
    if (typeof current === "string") {
      if (CONTROL_CHARACTERS.test(current)) findings.push(`${path}:control`);
      CONTROL_CHARACTERS.lastIndex = 0;
      for (const [name, pattern, predicate] of [
        ["secret", SECRET_PATTERNS, () => true],
        ["email", [EMAIL_PATTERN], () => true],
        ["path", ABSOLUTE_PATH_PATTERNS, () => true],
        ["ip", [IPV4_PATTERN], () => true],
        ["ip", [IPV6_PATTERN], isValidIPv6],
      ]) {
        for (const candidate of pattern) {
          candidate.lastIndex = 0;
          let match;
          while ((match = candidate.exec(current)) !== null) {
            if (predicate(match[0])) {
              findings.push(`${path}:${name}`);
              break;
            }
            if (match[0] === "") candidate.lastIndex += 1;
          }
          candidate.lastIndex = 0;
        }
      }
      return;
    }
    if (typeof current !== "object") return;
    if (seen.has(current)) {
      findings.push(`${path}:cycle`);
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const childPath = `${path}.${key}`;
      // Numeric token usage is an allowed aggregate, while a key such as
      // rawText, command, or payload is never part of the browser contract.
      if (isSensitiveKey(key) &&
        !(key === "tokenUsage" && typeof child === "number") &&
        !(key === "rawContentExposed" && child === false)) {
        findings.push(`${childPath}:sensitive-key`);
      }
      visit(child, childPath);
    }
  };

  visit(value, "$" );
  return { safe: findings.length === 0, findings };
}

export function assertPrivacySafe(value) {
  const report = scanPrivacy(value);
  if (!report.safe) {
    const error = new Error("Agentarium privacy boundary rejected a browser payload");
    error.code = "PRIVACY_BOUNDARY";
    error.findings = report.findings;
    throw error;
  }
  return value;
}

/**
 * Keep only the explicitly allowed primitive shapes used by warnings and
 * labels.  The observer uses this for source-derived labels before building
 * the final contract object.
 */
export function safeWarning(input) {
  const result = safeLabel(input, "Observer warning", 160);
  return result.value;
}

export const PRIVACY_PATTERNS = Object.freeze({
  secret: SECRET_PATTERNS,
  email: EMAIL_PATTERN,
  path: ABSOLUTE_PATH_PATTERNS,
  ipv4: IPV4_PATTERN,
  ipv6: IPV6_PATTERN,
});
