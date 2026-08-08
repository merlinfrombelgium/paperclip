import { redactKnownSecretValues, registerSecretValueSource } from "./secret-value-registry.js";

export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

const SECRET_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

// Captured stdout routinely carries secrets through several layers of shell
// quoting, so a value can be wrapped in escape soup like `KEY='"'"'value'"'"'`
// rather than a single balanced quote pair. Match any run of quote/backslash
// characters as an opaque wrapper, keep it verbatim, and redact the first
// unquoted run after it. Matching a closing quote is deliberately not required:
// the old balanced-pair form failed closed on the escaped shape and let the
// value through in clear.
const QUOTE_WRAPPER_PATTERN = String.raw`(?:\\*["'])*`;
const SECRET_VALUE_PATTERN = String.raw`[^\s"'\\` + "`" + String.raw`]+`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=))(${QUOTE_WRAPPER_PATTERN})(${SECRET_VALUE_PATTERN})`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(${QUOTE_WRAPPER_PATTERN})(${SECRET_VALUE_PATTERN})`,
  "gi",
);
// Every rule above anchors on a separator (`=`, `--opt`, `Bearer`). Reporters
// that print a secret as prose do not use one: our own `paperclip env` emits
// `NAME set [environment] Set in process environment => 'value'`, where the name
// and the value are ~45 characters and an arrow apart. Anchor on proximity to a
// secret-named token instead of on the operator, so the whole class is covered
// rather than one separator at a time. The value has to open with a quote or a
// bracket, sit within a bounded same-line window, and look high-entropy; paths
// and URLs near a secret name are excluded so diagnostics stay readable.
const SECRET_PROXIMITY_WINDOW = 160;
const SECRET_PROXIMITY_VALUE_CHAR = String.raw`[A-Za-z0-9+/=_.\-]`;
const COMMAND_SECRET_PROXIMITY_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\b[^\r\n"'` +
    "`" +
    String.raw`]{0,${SECRET_PROXIMITY_WINDOW}}?["'\[])` +
    String.raw`(?![~./])(?![A-Za-z][A-Za-z0-9+.\-]*://)` +
    String.raw`(?=${SECRET_PROXIMITY_VALUE_CHAR}*[0-9+/=])` +
    String.raw`(${SECRET_PROXIMITY_VALUE_CHAR}{16,})`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

const SECRET_ENV_VAR_NAME_RE = new RegExp(String.raw`^${SECRET_NAME_PATTERN}$`, "i");

/**
 * True when an environment variable name is secret-shaped. Reporters that print
 * env inventories use this to mask the value at the source instead of relying on
 * the downstream redactor, which is defence in depth rather than the control.
 */
export function isSecretEnvVarName(name: string): boolean {
  return SECRET_ENV_VAR_NAME_RE.test(name);
}

function* processEnvSecretValues(): Iterable<string> {
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !isSecretEnvVarName(name)) continue;
    yield value;
  }
}

/**
 * Feed the secret-bearing entries of the process environment into the value
 * candidate set. Read through on every rebuild rather than snapshotted, so a
 * variable set after boot is still covered. Idempotent — the registry keys
 * sources by identity — so tests call it again after resetting the registry.
 */
export function installProcessEnvSecretValueSource(): void {
  registerSecretValueSource(processEnvSecretValues);
}

installProcessEnvSecretValueSource();

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) || command.includes(".");
}

export function redactCommandText(command: string, redactedValue = REDACTED_COMMAND_TEXT_VALUE): string {
  // Value-based redaction runs first and unconditionally (ZIM-2174). It must not
  // sit behind `maybeContainsSecretText`: an unanchored emission — a bare value
  // under a file header, a value echoed inside a fenced block — carries none of
  // the hints that gate looks for, so gating it would reintroduce the blind spot
  // this pass exists to close.
  const withoutKnownValues = redactKnownSecretValues(command, redactedValue);
  if (!maybeContainsSecretText(withoutKnownValues)) return withoutKnownValues;
  return withoutKnownValues
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1$2${redactedValue}`)
    .replace(COMMAND_ENV_SECRET_ASSIGNMENT_RE, `$1$2${redactedValue}`)
    .replace(COMMAND_SECRET_PROXIMITY_RE, `$1${redactedValue}`)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue);
}
