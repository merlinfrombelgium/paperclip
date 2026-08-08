/**
 * Value-based secret redaction (ZIM-2174).
 *
 * Every other rule in this package anchors on a *syntactic shape*: `NAME=value`,
 * `--flag value`, `Bearer <token>`, a known value prefix. That only ever catches
 * emissions whose surrounding punctuation somebody thought of in advance, and the
 * shape space is unbounded — a reporter that prints `VAR set [..] => 'value'`, a
 * bare value under a file header, a value inside a fenced tool-result echo each
 * cost one more pattern, and nothing about the next shape follows from the last.
 *
 * This module inverts the question. Instead of guessing how a secret was framed,
 * it keeps a live candidate set of values that are *already known to be secret on
 * this host* and removes them from the stream wherever they appear, whatever the
 * surrounding syntax. Shape rules stay as a supplement for values that are not in
 * the candidate set (a token pasted in from elsewhere), but they stop being the
 * primary mechanism.
 *
 * The candidate set is rebuilt from its sources on a short TTL rather than
 * snapshotted once, so a secret created mid-run is not invisible to it.
 */

/** Values shorter than this never enter the candidate set: they would over-match. */
export const SECRET_VALUE_MIN_LENGTH = 12;
/** Shannon entropy floor, in bits per character, over the value's own characters. */
export const SECRET_VALUE_MIN_ENTROPY_BITS_PER_CHAR = 2;
/** A value must use at least this many distinct characters to count as secret-like. */
export const SECRET_VALUE_MIN_DISTINCT_CHARS = 6;
/** Values longer than this are almost certainly file bodies, not credentials. */
const SECRET_VALUE_MAX_LENGTH = 8192;
/**
 * Length of the head/tail probes registered for long values. Log lines routinely
 * print a truncated credential (`sk-abc…`), which the full-value candidate would
 * miss; 16 characters of a high-entropy secret is still secret material and long
 * enough not to collide with ordinary text.
 */
const PARTIAL_PROBE_LENGTH = 16;
const PARTIAL_PROBE_MIN_SOURCE_LENGTH = 32;
/** Bound on the rebuilt candidate list so a pathological env cannot stall logging. */
const MAX_CANDIDATES = 1024;
/** Bound on values pinned via {@link registerSecretValues}; oldest are evicted. */
const MAX_PINNED_VALUES = 256;
const CANDIDATE_CACHE_TTL_MS = 5_000;

const NON_SECRET_LITERALS = new Set([
  "undefined",
  "placeholder",
  "changeme",
  "not-set",
  "unset",
  "redacted",
  "***redacted***",
]);

/**
 * A callback that yields values currently known to be secret. Sources are polled
 * on the candidate-set TTL, so a source is free to read live state (the process
 * environment, a key file on disk) rather than a boot-time snapshot.
 */
export type SecretValueSource = () => Iterable<string>;

const sources = new Set<SecretValueSource>();
const pinnedValues = new Set<string>();

let cachedCandidates: string[] = [];
let cachedAtMs = 0;

function shannonEntropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function distinctCharCount(value: string): number {
  return new Set(value).size;
}

function looksLikePathOrUrl(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  if (value.startsWith("~/") || value.startsWith("\\\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return false;
}

/**
 * Gate for admission to the candidate set. Redacting a short or low-entropy value
 * is worse than not redacting it: a 4-character secret would blank half of every
 * log line and destroy the diagnostics the logs exist for. The cost of this gate
 * is that genuinely short secrets stay uncovered here and fall back to the shape
 * rules — a deliberate trade, not an oversight.
 */
export function isRedactableSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < SECRET_VALUE_MIN_LENGTH) return false;
  if (trimmed.length > SECRET_VALUE_MAX_LENGTH) return false;
  // Whitespace-bearing values are excluded: they are usually rendered config or
  // prose, and splitting on them across a log stream over-matches badly.
  if (/\s/.test(trimmed)) return false;
  if (NON_SECRET_LITERALS.has(trimmed.toLowerCase())) return false;
  if (looksLikePathOrUrl(trimmed)) return false;
  if (distinctCharCount(trimmed) < SECRET_VALUE_MIN_DISTINCT_CHARS) return false;
  if (shannonEntropyBitsPerChar(trimmed) < SECRET_VALUE_MIN_ENTROPY_BITS_PER_CHAR) return false;
  return true;
}

/**
 * The encodings a known secret is realistically emitted in. ZIM-2167's value-match
 * sweep ran exactly these probe forms across the host and they are cheap, so the
 * redactor runs them too rather than assuming the value reaches the log verbatim.
 */
export function secretValueVariants(value: string): string[] {
  const trimmed = value.trim();
  const variants = new Set<string>([trimmed]);

  const base64 = Buffer.from(trimmed, "utf8").toString("base64");
  variants.add(base64);
  variants.add(base64.replace(/=+$/, ""));
  variants.add(base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

  const uriEncoded = encodeURIComponent(trimmed);
  if (uriEncoded !== trimmed) variants.add(uriEncoded);

  const jsonEscaped = JSON.stringify(trimmed).slice(1, -1);
  if (jsonEscaped !== trimmed) variants.add(jsonEscaped);

  if (trimmed.length >= PARTIAL_PROBE_MIN_SOURCE_LENGTH) {
    variants.add(trimmed.slice(0, PARTIAL_PROBE_LENGTH));
    variants.add(trimmed.slice(-PARTIAL_PROBE_LENGTH));
  }

  return [...variants].filter((variant) => variant.length >= SECRET_VALUE_MIN_LENGTH);
}

/**
 * Register a source polled whenever the candidate set is rebuilt. Returns a
 * disposer. Sources that throw are ignored: a broken source must never take the
 * redactor — and therefore the log write path — down with it.
 */
export function registerSecretValueSource(source: SecretValueSource): () => void {
  sources.add(source);
  invalidateSecretValueCandidates();
  return () => {
    sources.delete(source);
    invalidateSecretValueCandidates();
  };
}

/**
 * Pin values that are known secret but are not discoverable by polling — most
 * importantly a secret-binding value the server just resolved for a run, which
 * exists only in flight.
 */
export function registerSecretValues(values: Iterable<string>): void {
  let added = false;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!isRedactableSecretValue(trimmed)) continue;
    if (pinnedValues.has(trimmed)) continue;
    pinnedValues.add(trimmed);
    added = true;
    while (pinnedValues.size > MAX_PINNED_VALUES) {
      const oldest = pinnedValues.values().next().value as string | undefined;
      if (oldest === undefined) break;
      pinnedValues.delete(oldest);
    }
  }
  if (added) invalidateSecretValueCandidates();
}

export function invalidateSecretValueCandidates(): void {
  cachedAtMs = 0;
}

function rebuildCandidates(): string[] {
  const values = new Set<string>(pinnedValues);
  for (const source of sources) {
    try {
      for (const value of source()) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (isRedactableSecretValue(trimmed)) values.add(trimmed);
      }
    } catch {
      // A source that cannot read its backing state contributes nothing; the
      // remaining sources and the shape rules still apply.
    }
  }

  const candidates = new Set<string>();
  for (const value of values) {
    for (const variant of secretValueVariants(value)) candidates.add(variant);
  }

  // Longest first: the full value has to be replaced before its own head/tail
  // probe consumes part of it and leaves the remainder in clear.
  return [...candidates].sort((a, b) => b.length - a.length).slice(0, MAX_CANDIDATES);
}

/** The current candidate set, rebuilt from its sources when the TTL has expired. */
export function getSecretValueCandidates(): string[] {
  const now = Date.now();
  if (cachedAtMs !== 0 && now - cachedAtMs < CANDIDATE_CACHE_TTL_MS) return cachedCandidates;
  cachedCandidates = rebuildCandidates();
  cachedAtMs = now;
  return cachedCandidates;
}

/**
 * Replace every occurrence of a known secret value, regardless of the syntax
 * around it. This is the primary redaction mechanism; the shape rules run after
 * it and only matter for values the candidate set does not know about.
 */
export function redactKnownSecretValues(text: string, redactedValue: string): string {
  if (!text) return text;
  const candidates = getSecretValueCandidates();
  if (candidates.length === 0) return text;

  let result = text;
  for (const candidate of candidates) {
    if (!result.includes(candidate)) continue;
    result = result.split(candidate).join(redactedValue);
  }
  return result;
}

/** Test seam: drops every source, pinned value, and cached candidate. */
export function resetSecretValueRegistryForTests(): void {
  sources.clear();
  pinnedValues.clear();
  cachedCandidates = [];
  cachedAtMs = 0;
}
