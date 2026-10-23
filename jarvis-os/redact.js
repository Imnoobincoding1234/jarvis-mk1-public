'use strict';
// ---------------------------------------------------------------------------
// redact.js — mask credentials before text is written down or sent anywhere.
//
// WHY THIS EXISTS. recall.js journals EVERY exchange to state/episodes.json —
// what was asked, what ran, what came back — and library.js indexes documents
// off disk. Neither had any notion of a secret. So an API key pasted into chat,
// a Bearer header read off a page by browser_page, or a tool result carrying a
// token was written to disk verbatim and then became retrievable: passive()
// pulls episodes into the prompt on later turns, and llm() will send a prompt to
// OpenRouter whenever the hosted tier is in play. That is a straight path from
// "he pasted a key once" to "the key left the machine weeks later".
//
// The existing guards do NOT cover this and are easy to mistake for cover:
//   - browser.js sanitise() fences page text against prompt INJECTION. It does
//     not mask anything; the secret survives it intact.
//   - system_control.js "redact" is macOS hiding a Wi-Fi SSID from us.
//   - The secrets guard blocks READING .env. It says nothing about text that has
//     already reached a prompt by another route.
//
// STRUCTURAL, NOT A WORD LIST. Every rule matches the SHAPE of a credential —
// a vendor prefix, a JWT's three base64 segments, a long hex run, a keyword
// followed by an assignment. No rule needs to know which service is in use, so a
// vendor nobody has heard of yet is still caught by the generic rules.
//
// ORDER MATTERS. Specific vendor shapes are matched before the generic catches
// so the more informative label wins: an AWS key should read [REDACTED_AWS_KEY]
// rather than [REDACTED_HEX].
//
// DELIBERATELY NOT REVERSIBLE. There is no keystore of what was masked. A
// redaction that can be undone is a second copy of the secret.
//
// Zero dependencies, per this project's standing rule.
// ---------------------------------------------------------------------------

// Each rule is [pattern, replacement]. Patterns are global so every occurrence
// in a long transcript is masked, not just the first.
const RULES = [
  // Vendor-shaped access keys first — these are unambiguous.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_LLM_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  // A JWT is three base64url segments separated by dots, opening with the
  // encoded {"alg" header — which is always eyJ.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Authorisation headers carry the credential inline. The scheme is kept
  // because "there was a Bearer token here" is useful context; the value is not.
  [/\b(Authorization|Proxy-Authorization)\s*:\s*(Bearer|Basic|Token)\s+\S+/gi, '$1: $2 [REDACTED]'],
  // This project's own token header, which /api routes require.
  [/\b(x-jarvis-token)\s*[:=]\s*\S+/gi, '$1: [REDACTED]'],
  // Keyword-anchored assignments: password=…, api_key: …, refresh_token=…
  [/\b(pass(?:word|wd|phrase)?|secret|token|api[_-]?key|(?:refresh|access|id|oauth|bearer)[_-]?token|session(?:[_-]?id)?|client[_-]?secret)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
    '$1=[REDACTED]'],
  // Private key blocks — mask the body, keep the marker so the shape is legible.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'],
  // Payment cards: 13-19 digits, optionally spaced or hyphened. Written so the
  // separator sits BETWEEN digits rather than after each one — `(?:\d[ -]?){13,}`
  // lets the final repetition swallow the trailing space, which turned
  // "card 4111 1111 1111 1111 please" into "[REDACTED_CARD]please".
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[REDACTED_CARD]'],
  // A long hex run is a digest, a session id or a raw key. Last, so anything
  // recognisable above has already claimed it.
  [/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED_HEX]'],
];

// A one-time code is only a secret next to the words that make it one — a bare
// six-digit number is a year range, a price or a house number far more often.
// Checked separately because it needs the CONTEXT, not just the shape.
const OTP_NEARBY = /\b(otp|2fa|one[- ]time|verification|passcode|auth code|security code)\b/i;
const SIX_DIGITS = /\b\d{6}\b/g;

// Mask credentials in `text`. Returns the text unchanged when there is nothing
// to mask, so callers can cheaply test whether anything happened.
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  if (OTP_NEARBY.test(out)) out = out.replace(SIX_DIGITS, '[REDACTED_OTP]');
  return out;
}

// Did this text contain anything worth masking? Used for logging that a
// redaction happened without logging WHAT was redacted.
function hadSecrets(text) {
  return typeof text === 'string' && text !== redact(text);
}

// IN STRUCTURED DATA THE KEY NAMES THE SECRET, and the value stands alone. The
// rules above all look for a keyword and its value in ONE string, which is how
// text arrives — but a tool result arrives as { authorization: "Bearer zzz" } or
// { apiKey: "abc123" }, where nothing in the value itself says what it is. Those
// went through completely unmasked until this: "Bearer zzz" matches no pattern,
// and a short opaque token matches nothing either.
//
// So in an object, a credential-shaped KEY masks its whole value.
const SECRET_KEY_RE = /^(?:auth(?:orization)?|proxy-authorization|pass(?:word|wd|phrase)?|secret|client[_-]?secret|token|[a-z]*[_-]?api[_-]?key|apikey|(?:refresh|access|id|oauth|bearer)[_-]?token|session(?:[_-]?id)?|cookie|set-cookie|private[_-]?key|credentials?)$/i;

// Walk an object/array and redact every string in it, so a whole episode or tool
// result can be passed in one call. Depth-capped because these come from tool
// output, and a cyclic or absurdly nested value must not take the process down.
function redactDeep(value, depth) {
  const d = typeof depth === 'number' ? depth : 0;
  if (d > 12) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, d + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      // A credential-named key masks its value outright — but only a PRIMITIVE
      // one. A key called "credentials" holding an object is a container, and
      // flattening it to a string would lose structure other code may read.
      if (SECRET_KEY_RE.test(String(k)) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactDeep(v, d + 1);
      }
    }
    return out;
  }
  return value;
}

module.exports = { redact, redactDeep, hadSecrets, RULES };
