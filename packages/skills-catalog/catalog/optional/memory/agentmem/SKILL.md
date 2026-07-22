---
name: agentmem
description: Use ZiMi lane-3 shared agent memory through exactly two brokered operations, recall and write, without exposing database credentials or connection strings.
key: paperclipai/optional/memory/agentmem
recommendedForRoles:
  - engineer
  - operations
  - researcher
tags:
  - memory
  - agentmem
  - recall
  - provenance
requires:
  - node
  - postgres
---

# Agentmem

Use this skill for ZiMi lane-3 shared agent memory. The skill exposes exactly two operations:

- `recall(query, k)` - semantic read through the brokered per-agent RLS read path.
- `write(fact, category)` - write a durable shared fact as the current agent.

Do not use `psql`, direct database clients, raw connection strings, or ad hoc SQL for agentmem work. The helper obtains a short-lived credential through the broker function and then connects as the scoped `mem_<agent>` role, so database RLS enforces read/write boundaries.

## Required Runtime Binding

The runtime must provide the broker binding out of band. Do not ask the user to paste these values, and do not print them:

- `AGENTMEM_AGENT` - agent role suffix, for example `ziara`.
- `AGENTMEM_HOST` - injected by the secured runtime.
- `AGENTMEM_BROKER_PW` - loaded from the secret-store pointer `agentmem/mem_broker`.
- Optional: `AGENTMEM_PORT`, `AGENTMEM_DB`, `AGENTMEM_TTL_MINUTES`.

If any required binding is missing, stop and report that the secured agentmem runtime binding is unavailable. Do not work around that by requesting secrets in issue text, comments, memory files, or chat.

## Operation: recall(query, k)

Run:

```sh
node scripts/agentmem.mjs recall --query "search text" --k 5
```

Rules:

- `query` must be non-empty.
- `k` defaults to `5` and must be from `1` through `20`.
- Use the JSON result as read-only context. Each row includes provenance fields: source agent, timestamp, category, score, and content.
- Do not paste low-confidence recall results into durable memory as fact without checking the provenance.

## Operation: write(fact, category)

Run:

```sh
node scripts/agentmem.mjs write --fact "durable fact" --category "decision"
```

Rules:

- `fact` and `category` must be non-empty.
- Write only durable facts, user preferences, stable decisions, and reusable project context.
- Do not write secrets, credentials, Plainsight/PGS/AI-Lab code or IP, network topology, ingress maps, ACLs, NAT/port-forward details, or raw issue transcripts.
- The helper writes shared memory only. Private-memory or admin operations are intentionally absent from this skill.

## Safety Checks

- The only public commands are `recall` and `write`.
- The helper never prints broker passwords, issued short-lived passwords, hostnames, connection strings, or raw SQL errors.
- `AGENTMEM_AGENT=plainsight` fails before credential issuance.
- Agent identity is not inferred from Paperclip UUIDs. The secured runtime must bind the approved agent role explicitly.
