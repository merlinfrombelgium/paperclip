#!/usr/bin/env node
import crypto from "node:crypto";

const DIMENSIONS = 768;
const DEFAULT_K = 5;
const MAX_K = 20;
const DEFAULT_TTL_MINUTES = 15;
const FUSION_K = 60;

main().catch((error) => {
  console.error(`agentmem: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});

async function main() {
  const [operation, ...argv] = process.argv.slice(2);
  if (operation !== "recall" && operation !== "write") {
    throw new Error("expected exactly one operation: recall or write");
  }

  const args = parseArgs(argv);
  const binding = readBinding();
  const sql = await importPostgres();

  const credential = await issueCredential(sql, binding);
  try {
    const agentDb = sql({
      host: binding.host,
      port: binding.port,
      database: binding.database,
      username: credential.roleName,
      password: credential.password,
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
    });
    try {
      if (operation === "recall") {
        const query = requireString(args.query, "query");
        const k = parseBoundedInt(args.k ?? String(DEFAULT_K), "k", 1, MAX_K);
        const rows = await recall(agentDb, query, k);
        process.stdout.write(`${JSON.stringify({ operation, rows }, null, 2)}\n`);
        return;
      }

      const fact = requireString(args.fact, "fact");
      const category = requireString(args.category, "category");
      const row = await write(agentDb, binding.agent, fact, category);
      process.stdout.write(`${JSON.stringify({ operation, row }, null, 2)}\n`);
    } finally {
      await agentDb.end({ timeout: 5 });
    }
  } finally {
    credential.password = "";
  }
}

async function importPostgres() {
  try {
    const imported = await import("postgres");
    return imported.default;
  } catch {
    throw new Error("missing runtime dependency: install the postgres npm package in the secured agent runtime");
  }
}

function readBinding() {
  const agent = requireEnv("AGENTMEM_AGENT").toLowerCase();
  if (agent === "plainsight") {
    throw new Error("credential issuance for agent=plainsight is prohibited");
  }

  return {
    agent,
    host: requireEnv("AGENTMEM_HOST"),
    port: parseBoundedInt(process.env.AGENTMEM_PORT ?? "5432", "AGENTMEM_PORT", 1, 65535),
    database: process.env.AGENTMEM_DB || "agentmem",
    brokerPassword: requireEnv("AGENTMEM_BROKER_PW"),
    ttlMinutes: parseBoundedInt(process.env.AGENTMEM_TTL_MINUTES ?? String(DEFAULT_TTL_MINUTES), "AGENTMEM_TTL_MINUTES", 1, 60),
  };
}

async function issueCredential(sql, binding) {
  const brokerDb = sql({
    host: binding.host,
    port: binding.port,
    database: binding.database,
    username: "mem_broker",
    password: binding.brokerPassword,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  try {
    const rows = await brokerDb`
      SELECT role_name, password, valid_until
      FROM issue_agent_credential(${binding.agent}, ${`${binding.ttlMinutes} minutes`}::interval)
    `;
    const row = rows[0];
    if (!row?.role_name || !row?.password) {
      throw new Error("broker did not issue a credential for the bound agent");
    }
    return {
      roleName: row.role_name,
      password: row.password,
      validUntil: row.valid_until,
    };
  } finally {
    await brokerDb.end({ timeout: 5 });
  }
}

async function recall(db, query, k) {
  const vector = vectorLiteral(embed(query));
  const fanout = Math.max(k * 4, 10);

  const vectorRows = await db`
    SELECT
      id::text,
      agent_id,
      content,
      created_at,
      provenance,
      source,
      1.0 - (embedding <=> ${vector}::vector) AS similarity
    FROM memories
    WHERE valid_to IS NULL
      AND embedding IS NOT NULL
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY embedding <=> ${vector}::vector
    LIMIT ${fanout}
  `;

  const textRows = await db`
    SELECT
      id::text,
      agent_id,
      content,
      created_at,
      provenance,
      source,
      ts_rank(tsv, websearch_to_tsquery('english', ${query})) AS rank
    FROM memories
    WHERE valid_to IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND tsv @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${fanout}
  `;

  const fused = new Map();
  addRankedRows(fused, vectorRows, "vector");
  addRankedRows(fused, textRows, "text");

  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, k)
    .map((row) => ({
      source_agent: row.agent_id,
      timestamp: row.created_at,
      category: provenanceCategory(row.provenance),
      score: Number(row.score.toFixed(6)),
      content: row.content,
      provenance: {
        source: row.source ?? null,
        run_id: isRecord(row.provenance) ? row.provenance.run_id ?? null : null,
      },
    }));
}

async function write(db, agent, fact, category) {
  const now = new Date().toISOString();
  const provenance = {
    source_agent: agent,
    timestamp: now,
    category,
    run_id: process.env.PAPERCLIP_RUN_ID ?? null,
    issue_id: process.env.PAPERCLIP_TASK_ID ?? null,
    writer: "agentmem-skill",
  };

  const rows = await db`
    INSERT INTO memories
      (agent_id, scope, run_id, content, content_norm, embedding, importance, provenance, source)
    VALUES
      (
        ${agent},
        'shared',
        ${process.env.PAPERCLIP_RUN_ID ?? null},
        ${fact},
        ${normalize(fact)},
        ${vectorLiteral(embed(fact))}::vector,
        0,
        ${JSON.stringify(provenance)}::jsonb,
        'agentmem-skill'
      )
    ON CONFLICT (agent_id, scope, content_norm) WHERE valid_to IS NULL
    DO UPDATE SET
      provenance = memories.provenance || EXCLUDED.provenance,
      embedding = EXCLUDED.embedding
    RETURNING id::text, agent_id, created_at, provenance
  `;
  const row = rows[0];
  return {
    id: row.id,
    source_agent: row.agent_id,
    timestamp: row.created_at,
    category: provenanceCategory(row.provenance),
  };
}

function addRankedRows(target, rows, channel) {
  rows.forEach((row, index) => {
    const key = row.id;
    const existing = target.get(key) ?? {
      id: row.id,
      agent_id: row.agent_id,
      content: row.content,
      created_at: row.created_at,
      provenance: row.provenance,
      source: row.source,
      score: 0,
      channels: [],
    };
    existing.score += 1 / (FUSION_K + index + 1);
    existing.channels.push(channel);
    target.set(key, existing);
  });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    if (!["query", "k", "fact", "category"].includes(key)) {
      throw new Error(`unsupported option --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`secured runtime binding is missing ${name}`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseBoundedInt(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return parsed;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function embed(text) {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const hash = crypto.createHash("md5").update(token).digest("hex");
    vector[Number.parseInt(hash, 16) % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function vectorLiteral(vector) {
  return `[${vector.map((value) => value.toFixed(8)).join(",")}]`;
}

function provenanceCategory(provenance) {
  if (!isRecord(provenance)) return null;
  return typeof provenance.category === "string" ? provenance.category : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(message) {
  let redacted = message;
  for (const value of [
    process.env.AGENTMEM_HOST,
    process.env.AGENTMEM_BROKER_PW,
    process.env.PGPASSWORD,
    process.env.DATABASE_URL,
  ]) {
    if (value) redacted = redacted.split(value).join("[redacted]");
  }
  return redacted.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-postgres-url]");
}
