<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/openai

A client for GPT models reached through a ChatGPT (Codex) subscription, as an
exe.dev LLM integration serves it, written for celld Workers, Durable Objects
and Workflows. It is not a port of the OpenAI SDK. It speaks to one endpoint,
the Responses API behind `https://<integration>.int.exe.xyz/openai/v1`, and
it is shaped around two kinds of work: agentic coding and Blue Team work
(security review, reverse engineering, triage). It has no npm dependency.
The core depends on three `@celld` libraries: schemas are
[`@celld/sieve`](../../sieve), retries, the runtime and server-sent events
[`@celld/http`](../../http), and ids [`@celld/ulid`](../../ulid). Everything else
is in the bridges.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    deps = [
        "root//src/celld/api/openai:openai",
        "root//src/celld/sieve:sieve",  # for your own schemas
    ],
)
```

| Import                     | Target        | What it has                                                                                   | Runtime imports      |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| `@celld/api/openai`            | `:openai`     | `GptClient`, streaming, structured output, conversations, tools, the agent loop, pacer, chunkers, errors | none                 |
| `@celld/api/openai/coding`     | `:openai`     | `apply_patch` (parser, applier, tool), `exec_command`, `shell`, read-only file tools, file systems | none                 |
| `@celld/api/openai/blueteam`   | `:openai`     | finding, RE-notes and triage schemas, prompts, `securityReview`, `reverseEngineer`, `triage`  | none                 |
| `@celld/api/openai/durable`    | `:openai`     | the `GptPacer` and `GptConversations` Durable Objects                                          | `cloudflare:workers` |
| `@celld/api/openai/workflow`   | `:openai`     | `respondStep`, `runAgentWorkflow`, `workflowSteps`, `waitForUsageReset`                       | none                 |
| `@celld/api/openai/testing`    | `:openai`     | `FakeResponses` (a scripted SSE server), `turnEvents`, `scriptedShell`, and `@celld/http/testing`'s `virtualRuntime` and `fakeStep` | none                 |
| `@celld/api/openai/jev`        | `:jev-bridge` | Jev-gated approvals, effort routing, escalation, output scoring                                | none                 |
| `@celld/api/openai/reflection` | `:reflection` | finding the LLM integration through exe.dev's reflection service                               | none                 |
| `@celld/api/openai/sandbox`    | `:sandbox-bridge` | the coding tools over a `@celld/sandbox` sandbox, staged `apply_patch`, `disassemble`, `reviewCheckout` | none                 |

The bridges are separate targets, so depending on `:openai` never pulls in
`@celld/api/jev`, `@celld/api/exedev` or `@celld/sandbox`. Only `./durable` imports
`cloudflare:workers`; a test that imports it needs `fake_runtime = True`.

## The path a request takes

A VM (or a celld node on one) with the integration attached sends
`POST https://llm.int.exe.xyz/openai/v1/responses`. exe.dev adds the ChatGPT
account's credentials at its edge and forwards to ChatGPT's Codex backend, the
same one the Codex CLI talks to. The VM holds no key and this client sends no
`authorization` header. The integration is set up once, outside the VM:

```
exe.dev ▶ integrations setup chatgpt --name work
exe.dev ▶ integrations add llm --name llm --openai=chatgpt --openai-account=work --attach auto:all
```

The client defaults to the `/openai/v1` prefix, which always routes to the
OpenAI provider; `route: "auto"` uses `/v1`, which routes by model id. A team
integration lives at `.team.exe.xyz`. The hostnames only resolve on attached
VMs, so nothing in this package's tests touches them.

## Asking

```typescript
import { GptClient } from "@celld/api/openai";

const gpt = GptClient.fromEnv(env); // https://llm.int.exe.xyz/openai/v1

const answer = await gpt.ask("Why does this panic?\n\n" + trace);

const turn = await gpt.respond({
  input: "Summarise the change in two sentences.\n\n" + diff,
  reasoning: { effort: "low" },
  verbosity: "low",
});
turn.finalText; // the answer
turn.usage; // { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens }
turn.meta; // { attempts, latencyMs, requestId, promptCacheKey, encoding, rateLimits }
```

`fromEnv` reads `OPENAI_BASE_URL` (a full API root, which wins), else
`EXE_LLM_INTEGRATION` (default `llm`) and `EXE_LLM_TEAM` (`1` or `true`), and
`OPENAI_MODEL`. Explicit options win over all of them.

### Streaming

```typescript
const stream = gpt.stream({ input: task });
for await (const event of stream) {
  switch (event.type) {
    case "text.delta": write(event.delta); break;
    case "reasoning.delta": thinking(event.delta); break;
    case "tool.delta": progress(event.name, event.delta); break;
    case "retry": discardPartial(); break;
  }
}
const turn = await stream.result; // also works without iterating
```

Events: `created`, `model`, `rate_limits`, `item.added`, `text.delta`,
`refusal.delta`, `reasoning.delta`, `reasoning.done`, `tool.delta`,
`item.done`, `retry` and `completed` (which carries the `Turn`). Breaking out
of the loop cancels the HTTP request. An `AbortSignal` passed as
`{ signal }` cancels the request, a pacer wait or a retry sleep.

`stream()` retries a transient failure only while no output has reached the
caller, and says so with a `retry` event. Once text has been handed out, the
error is thrown instead: the caller has seen half an answer, and silently
starting over would hand out a different one. `respond()` has nothing to hand
out until the end, so it retries at any point.

### Structured output

```typescript
import { type Infer, v } from "@celld/sieve";

const Verdict = v.object({
  vulnerable: v.boolean(),
  cwe: v.string().regex(/^CWE-[0-9]+$/).nullable(),
  confidence: v.number().min(0).max(1),
});
const { value } = await gpt.structured({ input: code, schema: Verdict, name: "verdict" });
value.cwe; // string | null
type Verdict = Infer<typeof Verdict>;
```

The schema is a [`@celld/sieve`](../../sieve) schema. One definition gives the
JSON Schema sent as a strict `json_schema` format (sieve's `openai-strict`
target, `strictSchema(schema)`), the TypeScript type, and the parse of the
answer, so `value` is the schema's output: transforms, `.trim()` and
conversions such as `.toPlainDate()` apply.

Strict mode needs every key present and objects closed, and the target
enforces it when the request is built: an `.optional()` or `.default()` key,
a loose object, a record or an intersection is a `GptInvalidRequestError`
before anything is sent. Use `.nullable()` for a value that may be absent;
the model sends `null`. Every object is sent with `additionalProperties:
false`, but the parse is the schema's own: a `v.object` strips a key the
model added anyway, and a `v.strictObject` (as the Blue Team schemas are)
refuses it. A wrong type, a missing key, a key a strict object does not
declare, or text that is not JSON is a `GptOutputError` of kind `output`
whose `issues` are sieve's, with every path; a model refusal is kind
`refusal`.

A `format.schema` written by hand still goes through `requestIssues`, which
checks it is JSON and, in strict mode, that every object lists all its
properties as `required` and sets `additionalProperties: false`.

### Models

```typescript
await gpt.models.list(); // GET /models
await gpt.models.pick(["gpt-6", "gpt-5.5"]); // exact id, else "gpt-6-*"
```

The default model is `gpt-6-astra`. The Codex client's bundled model catalog
(read on 2026-09-25) lists the GPT-6 family as `gpt-6-astra`, `gpt-6-sol` and
`gpt-6-luna`, with no bare `gpt-6`, and puts `gpt-6-astra` first. All three
are served through a ChatGPT-backed integration and pass the live smoke test;
pass `model: "gpt-6-sol"` or `"gpt-6-luna"` to use the others.
`models.pick` finds what an integration serves at startup. `KNOWN_MODELS`
keeps a few facts from that catalog per model (context window, accepted
efforts, default effort, request encoding); any other id can still be sent.

## Conversations

With `store: false` the backend keeps nothing, so a conversation is its items,
replayed in full every turn.

```typescript
import { Conversation } from "@celld/api/openai";

const thread = new Conversation({ id: caseId, instructions: "You are reviewing a Rust crate." });
thread.user("Is this unsafe block sound?\n\n" + code);
thread.record(await gpt.respond(thread.request({ reasoning: { effort: "high" } })));
thread.user("What about under a panic?");
thread.record(await gpt.respond(thread.request()));

await store.save(thread.toJSON()); // plain JSON
const resumed = Conversation.fromJSON(await store.load(caseId));
```

- Reasoning items go back with their `encrypted_content`; that is the only
  way the model sees its earlier reasoning when nothing is stored. Reasoning
  without it is left out of the replay, since the server could not resolve it.
- Items are stored in the shape Codex replays: output-only fields such as
  `status` and `annotations` are dropped, server ids are kept.
- The conversation id (a new ULID unless given) is its `prompt_cache_key`,
  and the client sends it as a
  `session-id` header too (Codex does, because ChatGPT derives cache affinity
  from it). Every turn of one conversation therefore shares a cache, and the
  replayed prefix is billed at cached rates. Calls without a conversation get
  a key hashed from model, instructions and tools, so calls that share a
  prompt share a cache.
- `fromJSON` checks what it is given and reports every problem with its path.
- A request with a tool call that has no output is refused before sending,
  because the backend refuses it too.

Stores: `memoryConversationStore()`, `kvConversationStore(kv)` (one KV key per
conversation), and `durableConversationStore(env.GPT_CONVERSATIONS, name)` for
the `GptConversations` Durable Object, which keeps one SQLite row per item so
a long conversation never meets the row size limit.

## Tools and the agent loop

```typescript
import { Conversation, functionTool, runAgent, ToolRegistry } from "@celld/api/openai";
import { v } from "@celld/sieve";

const lookupCve = functionTool({
  name: "lookup_cve",
  description: "Fetch a CVE record by id.",
  parameters: v.strictObject({ id: v.string().regex(/^CVE-\d{4}-\d+$/) }),
  risk: "network",
  timeoutMs: 10_000,
  run: async ({ id }) => await nvd(id), // id: string
});

const result = await runAgent({
  client: gpt,
  conversation: new Conversation().user(question),
  tools: new ToolRegistry([lookupCve]),
  maxTurns: 20,
  budget: { tokens: 1_000_000, timeMs: 15 * 60_000 },
  approve: approveByRisk({ allow: ["read"] }),
});
result.stopReason; // "completed" | "max_turns" | "token_budget" | "time_budget"
```

- Function tools declare their parameters as a sieve schema, and the
  handler gets what it parsed, typed. The model sees `tool.jsonSchema`:
  sieve's `openai-strict` target for a strict tool (the default), so
  `functionTool` throws on parameters strict mode would refuse, or the
  input schema without `$schema` for `strict: false`, where `.optional()`
  keys are allowed. There a `v.strictObject` keeps `additionalProperties:
  false`; a stripping `v.object` is sent open. Arguments that fail the
  schema never reach the handler; the model gets `error: invalid
  arguments: ...` with the paths and can try again. Refinements must be
  synchronous.
- Custom (freeform) tools get the model's text, optionally constrained by a
  Lark or regex grammar.
- Unknown tools, denials, handler exceptions and timeouts all become the
  call's output text. Nothing a tool does throws out of the loop.
- Parallel calls run concurrently, four at a time by default, and their
  outputs keep call order. Outputs longer than 20,000 characters are cut in
  the middle.
- Every call gets an `AbortSignal` that fires on its timeout.
- Budgets are checked between steps. When one runs out with calls pending,
  those calls are answered with "not run", so the conversation stays valid
  to resume. A model failure throws `GptError` and leaves the conversation as
  it was before the failed turn.
- `approve` sees each call as plain data (`call`, `tool.risk`, the `args`
  as the model sent them, already validated, and `turn`) and returns `true`
  or `{ allow: false, reason }`. The reason goes back to the model.

## Coding

```typescript
import { runAgent, Conversation, ToolRegistry } from "@celld/api/openai";
import { CODING_INSTRUCTIONS, codingTools, MemoryFileSystem } from "@celld/api/openai/coding";

const fs = new MemoryFileSystem(await loadRepo()); // path -> text
const result = await runAgent({
  client: gpt,
  conversation: new Conversation({ instructions: CODING_INSTRUCTIONS })
    .user("Make parseDate reject February 30th, and add a test."),
  tools: new ToolRegistry(codingTools({ fs, shell: vmShell })),
  request: { reasoning: { effort: "high" } },
});
await writeBack(fs.snapshot());
```

`applyPatchTool(fs)` is Codex's `apply_patch`: a custom tool with Codex's
description and its Lark grammar copied verbatim, so the model writes the
format it was trained on. The parser and applier follow Codex's
`codex-rs/apply-patch` rule for rule: the lenient marker checks and heredoc
unwrapping, every error message and line number, context search that falls
back from exact to trailing-whitespace to trimmed to punctuation-normalised
matching, `@@` anchors, `*** End of File`, and per-line endings (Codex's
`PreserveLineEndings` mode). All 25 of Codex's portable apply-patch scenarios
run as tests. One difference is deliberate: a patch here applies all or
nothing. Codex keeps the hunks that succeeded before a failing one.

The file system is an interface (`read`, `write`, `remove`, `kind`, `list`)
with an in-memory implementation and a `readOnly` wrapper. Paths are
workspace-relative; absolute paths, `~` and `..` past the root are refused.
Nothing touches the host.

`execCommandTool(runner)` is Codex's `exec_command` with its parameter names
and descriptions, and `legacyShellTool(runner)` is the older `shell` tool
with an argv list. Both are non-strict tools, as Codex declares them, with
`.optional()` parameters in a `v.strictObject`; the read-only tools are
strict, with `.nullable()` ones. Their JSON Schemas are recorded in
`tests/golden/model-schemas.json`, and a test keeps them from changing by
accident. Both call a `ShellRunner` you supply (an exe.dev VM through
`@celld/api/exedev`'s `runOnVm`, a container, a test double). `readOnlyTools(fs)`
adds `read_file`, `list_dir` and `grep_files`.

## Blue Team

```typescript
import { atLeast, securityReview, triage } from "@celld/api/openai/blueteam";

const review = await securityReview(gpt, {
  diff: pullRequestDiff,
  context: "payment service, internet facing, handles card data",
});
for (const finding of atLeast(review.findings, "high")) {
  finding.cwe; // "CWE-89" | null
  finding.location; // { path, startLine, endLine, symbol }
  finding.evidence;
  finding.confidence; // 0 to 1
  finding.remediation;
}

const { triage: verdict } = await triage(gpt, { alert: siemAlert, context: "DC01 is tier 0" });
verdict.priority; // "P0" ... "P4"
```

`Finding`, `SecurityReview`, `ReNotes` and `Triage` are `@celld/sieve`
strict objects, so each is a strict JSON Schema (through the `openai-strict`
target), a TypeScript type and a parse that refuses extra keys. What the
model sees is pinned by `tests/golden/model-schemas.json`.
`securityReview` numbers source lines so findings can cite them, splits large
inputs with `chunkDiff`/`chunkLines`, reviews chunks two at a time, and merges
the findings, dropping duplicates by path, line, CWE and title and keeping the
most confident. `reverseEngineer` splits disassembly at function boundaries
(objdump, IDA and Ghidra banners, `sub_XXXX:` labels) and merges the notes.
The prompts (`SECURITY_REVIEW_INSTRUCTIONS` and the rest) are short and meant
to be replaced; pass `instructions`.

The chunkers (`chunkLines`, `chunkLog`, `chunkDiff`, `chunkDisassembly`) are
in the core, with `mapChunks` and `contextBudgetChars(model)` to size chunks.
Sizes are in characters, at roughly four to a token.

Expect the backend to refuse some security work: that arrives as kind
`policy`, code `cyber_policy`, and is not retried.

For security work, `gpt-daybreak-blue-latest` (Daybreak Blue) is served
through a ChatGPT subscription even though `/models` does not list it; it
passed the live smoke test on 2026-09-25. Its responses carry
`access_programs: {cyber: "daybreak_blue"}`, which a turn exposes as
`turn.accessPrograms`, so code can check the cyber program was applied. The
alias moves: the response reports only `gpt-daybreak-blue-latest`, never the
model behind it (said to be `gpt-5.6-sol` at the time). Daybreak Red
(`gpt-daybreak-red-latest`) is refused with a 400, kind `bad_request`: "The
'gpt-daybreak-red-latest' model is not supported when using Codex with a
ChatGPT account."

## Sandboxes

`@celld/api/openai/sandbox` (`:sandbox-bridge`, which depends on `@celld/sandbox`)
puts the coding tools and the Blue Team helpers in a per-id container:

```typescript
import { getSandbox } from "@celld/sandbox";
import { reverseEngineerFile, reviewCheckout, sandboxCodingTools } from "@celld/api/openai/sandbox";

const box = getSandbox(env.SANDBOX, conversationId);
await runAgent({ client: gpt, conversation, tools: new ToolRegistry(sandboxCodingTools(box)) });

const { result: notes, disassembly } = await reverseEngineerFile(gpt, box, "upload/sample", { tool: "objdump" });
const review = await reviewCheckout(gpt, box, "https://github.com/acme/api", { include: ["src/**"] });
```

`sandboxFileSystem(box)` and `sandboxShellRunner(box)` are this library's
`FileSystem` and `ShellRunner` over a `SandboxClient` or `SandboxCore`. `read`
answers null for missing, directory and non-UTF-8 paths; `list` is recursive
and includes dotfiles; the shell runs strings with `sh -c` and argv lists
directly, with stderr interleaved and the tool's timeout as the deadline.
`sandboxCodingTools(box, {readOnly?, shell?})` is `codingTools` over them.

Its `apply_patch` is `sandboxApplyPatch`, which narrows the window in which
a patch is half applied. The patch is planned against the workspace first
(a bad patch changes nothing), every new file is written beside its target
under a temporary name with the target's permissions, and then each is
renamed into place and deleted files are removed. Each rename is atomic; the
patch is not. A failure or a concurrent writer during the renames leaves some
files changed, and the error, `PartialPatchError`, lists which were
(`committed`) and which were not (`pending`). A symbolic link that a patch
updates becomes a regular file.

`disassemble(box, path, {tool, args?, timeoutMs?, maxOutputBytes?})` runs
`objdump`, `strings`, `readelf`, `nm` or `hexdump` (default flags in
`DISASSEMBLERS`) on a workspace file as an argv list, with the path after
`--`, a 60 s deadline and a 1 MiB output cap. A non-zero exit or a timeout
throws with the tool's stderr; a cut output is returned with `truncated`.
`reverseEngineerFile(gpt, box, path, options)` passes the output to
`reverseEngineer`. The pinned busybox image has `strings` and `hexdump`;
objdump, readelf and nm need binutils (or LLVM's tools) in the image.

`reviewCheckout(gpt, box, url, options)` clones with `gitCheckout` (https
only), reads the checkout's text files through a read-only view (skipping
`.git/`, binaries, files past `maxFileChars` or `maxFiles`, and anything
outside `include`/inside `exclude`), and runs `securityReview` over them.
Finding paths are relative to the checkout. The result carries that view as
`fs`, so `readOnlyTools(review.fs)` lets an agent follow up on the findings
without being able to change anything.

**Run untrusted binaries and repositories under `runsc`.** Analyzers parse
hostile input and have had parser bugs; a cloned repository can hold
anything. Give the sandbox's container `"runtime": "runsc"` (gVisor), so an
exploited analyzer lands in gVisor's user-space kernel rather than the
host's. See `@celld/sandbox`'s README for the runtime and its caveats.

The [`sandbox`](examples/sandbox.ts) example runs the staged `apply_patch`
and `strings` into `reverseEngineer` in the pinned busybox container
(`needs-docker`).

## Jev as the control plane

```typescript
import { JevClient } from "@celld/api/jev";
import { jevApprover, needsEscalation, routeEffort, scoreOutput } from "@celld/api/openai/jev";

const jev = JevClient.fromEnv(env);
const { effort } = await routeEffort(jev, task); // Jev picks low/medium/high/xhigh

const result = await runAgent({
  client: gpt,
  conversation: new Conversation({ instructions: CODING_INSTRUCTIONS }).user(task),
  tools: new ToolRegistry(codingTools({ fs, shell })),
  request: { reasoning: { effort } },
  approve: jevApprover(jev, { task, onUncertain: askOnCall }),
});

const graded = await scoreOutput(jev, { task, output: result.text }); // score 0 to 1
const { escalate } = await needsEscalation(jev, finding); // "yes" | "no" | "uncertain"
```

- `jevApprover` lets `read` calls through without asking. For everything else
  it asks Jev whether the call is safe to run without review, with the task,
  tool and arguments as state. At `p >= 0.8` it allows, at `p <= 0.3` it
  denies, and the middle goes to `onUncertain` (deny by default, or another
  approver such as a human). If Jev fails, it denies unless
  `onError: "allow"`.
- `routeEffort` is a Jev choice gated by confidence; under the floor it
  returns the fallback and `decided: false`.
- Every helper returns the probability or confidence it acted on, and every
  threshold is a parameter.

## celld wiring

```typescript
import { durablePacer, GptClient } from "@celld/api/openai";
export { GptConversations, GptPacer } from "@celld/api/openai/durable";

const gpt = GptClient.fromEnv(env, { pacer: durablePacer(env.GPT_PACER, "work") });
```

```python
celld.project(..., bindings = {"GPT_PACER": "GptPacer", "GPT_CONVERSATIONS": "GptConversations"})
```

### The pacer

A subscription is metered in usage windows, not per request. The `x-codex-*`
headers show a short window of about five hours and a weekly one, and when a
window is spent every call fails with `usage_limit_reached` until it resets.
One `GptPacer` per subscription paces every Worker sharing it:

- At most `maxConcurrent` calls in flight (default 4, a guess; OpenAI
  publishes no number) and optionally `minIntervalMs` between starts. A
  caller holds a lease per attempt; a lease a crashed caller never released
  expires.
- When any caller gets a usage limit, the pacer holds everyone until
  `resets_at` (15 minutes if no reset time came with it). A `retry-after` on
  a rate limit or overload holds everyone for that long, and so do headers
  saying a window is at 100%.
- A client whose wait would pass `maxPacerWaitMs` (one minute) fails at once
  with kind `usage_limit` and the reset time. It does not send a request it
  knows will fail.
- Leases live in memory. The block, the configuration and the usage totals
  are in the object's SQLite, and a new block waits for `storage.sync()`, so
  a usage limit keeps holding across restarts. `snapshot()` shows the
  latest rate-limit windows and totals; `configure`, `block` and `unblock`
  are there for operators.
- If the object cannot be reached, the call goes ahead and `onPacerError`
  hears about it.

`memoryPacer()` is the same logic inside one isolate.

### Workflows

```typescript
import { runAgentWorkflow, waitForUsageReset } from "@celld/api/openai/workflow";

const result = await runAgentWorkflow(step, "fix", {
  client: gpt,
  conversation: new Conversation({ id: event.instanceId }).user(event.payload.task),
  tools,
});
```

Each model turn and each batch of tool calls is its own step (`fix:turn-0`,
`fix:tools-0`, ...). A replayed Workflow gets the stored results back and
records them into a conversation built the same way, so no turn is paid for
twice and no tool call runs twice. Transient model failures are thrown so the
step's retries apply; permanent ones are stored and end the run.
`waitForUsageReset(step, name, error)` sleeps the Workflow until a usage limit
resets. `respondStep` wraps a single call. Step results are capped at 1 MiB;
a turn carries its encrypted reasoning, usually a few kilobytes.

## Errors

Every failure is a `GptError` with a `kind`:

| kind              | When                                                                             | Retried |
| ----------------- | -------------------------------------------------------------------------------- | ------- |
| `invalid_request` | refused before sending; `issues` has the paths                                   | no      |
| `bad_request`     | 400 without a more specific code                                                 | no      |
| `authentication`  | 401                                                                              | no      |
| `permission`      | 403 without a policy code                                                        | no      |
| `not_found`       | 404                                                                              | no      |
| `rate_limited`    | 429, or `rate_limit_exceeded` / `slow_down` (also as 503 bodies and in-stream)   | yes     |
| `usage_limit`     | 429 `usage_limit_reached`; `resetsAt` says when it clears                        | no      |
| `quota`           | `insufficient_quota`, `usage_not_included`, spend and credit limits              | no      |
| `overloaded`      | `server_is_overloaded`, 529, `flex_unavailable`                                  | yes     |
| `server`          | other 5xx, or `response.failed` with no specific code                            | yes     |
| `http`            | any other status                                                                 | no      |
| `context_window`  | `context_length_exceeded`                                                        | no      |
| `policy`          | `cyber_policy`, `bio_policy`, `invalid_prompt`, `misalignment_policy_violation`  | no      |
| `incomplete`      | `response.incomplete`; `code` is the reason                                      | no      |
| `stream`          | the stream ended or broke before `response.completed`                            | yes     |
| `connection`      | no response                                                                      | yes     |
| `timeout`         | no headers within `connectTimeoutMs`, no event within `idleTimeoutMs`, or budget | yes     |
| `aborted`         | the caller's signal fired                                                        | never   |
| `decode`          | a 2xx body or item without the documented shape                                  | no      |
| `output`          | a structured answer that fails its schema                                        | no      |
| `refusal`         | the model refused                                                                | no      |

Errors carry `status`, `code`, `retryAfterMs`, `resetsAt`, `requestId`
(`x-request-id`, else `x-oai-request-id`, else `cf-ray`), `body` (JSON, or
text cut to 4 KiB), `issues`, `rateLimits`, `attempts` and `retryable`.
Durable Object RPC and Workflow steps keep only an error's name and message,
so code that crosses them uses `tryRespond`, `tryStructured` or `tryRunAgent`,
which return `{ ok: false, error }` with plain `GptErrorData`.
`gptErrorFromData` rebuilds the class.

## Retries and timeouts

| Setting                                | Default                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| `maxRetries`                           | 4, Codex's `request_max_retries`                             |
| `backoffInitialMs`, `backoffMaxMs`     | 500 ms doubling to 20 s, with up to 20% subtracted at random |
| `retryOn`                              | the kinds marked "yes" above                                 |
| `respectRetryAfter`, `maxRetryAfterMs` | yes, capped at 120 s                                         |
| `budgetMs`                             | none                                                         |
| `connectTimeoutMs`                     | 60 s until response headers                                  |
| `idleTimeoutMs`                        | 300 s between stream events, Codex's default                 |

A `store: false` call leaves nothing on the server, so repeating it costs
usage and nothing else; that is why stream breaks and timeouts are retried.
The server's wait comes from `retry-after-ms`, `retry-after`, or, for
in-stream rate limits, the "try again in 1.5s" text Codex also reads. There
is no default overall budget because a high-effort answer can stream for many
minutes; the idle timeout catches a stalled stream. All of it can be set per
client and per call.

The policy is a `GptRetryPolicy`: `@celld/http`'s `RetryPolicy` (backoff,
budget, `retry-after`) plus `retryOn`, the kinds to retry.
`resolveGptRetryPolicy(options, base)` fills and checks a partial one;
`retryOn` may be any iterable, and an option set to `undefined` keeps the
default. The backoff arithmetic, `retry-after` parsing, the injectable
`Runtime`, and the SSE parser are `@celld/http`'s.

## What the backend accepts, and where that comes from

The exe.dev docs cover the integration. They say nothing about the ChatGPT
backend's rules, so those come from the open-source Codex client
(github.com/openai/codex, main branch, read 2026-09-25), which is the one
client the backend is built for.

| Constraint | Source |
| --- | --- |
| Integration at `https://<name>.int.exe.xyz`, team ones at `.team.exe.xyz`; default name `llm` | exe.dev `integrations-llm.md` |
| `/v1/responses`, `/v1/models`; the `/openai` prefix forces the OpenAI provider | exe.dev `integrations-llm.md` |
| No key on the VM; the proxy injects ChatGPT credentials | exe.dev `integrations-llm.md`, `integrations.md` |
| ChatGPT subscriptions do not provide transcription | exe.dev `integrations-llm.md` (not offered here) |
| Codex works with `base_url = https://llm.int.exe.xyz/v1` | exe.dev `integrations-llm.md` |
| Integration discovery through reflection, `help` line with the host | exe.dev `integrations-reflection.md` |
| `stream: true`, `store: false`, always | Codex `core/src/client.rs` `build_responses_request` |
| `include: ["reasoning.encrypted_content"]`, always | same |
| `instructions` always set in the standard encoding | same; `codex-api/src/common.rs` skips it only when empty (lite) |
| No `previous_response_id` over HTTP, no `max_output_tokens`, `temperature`, `top_p` | `ResponsesApiRequest` in `codex-api/src/common.rs` has no such fields; `previous_response_id` appears only on the websocket request, always `None` when converted |
| Fields sent: `model`, `instructions`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning{effort,summary,context}`, `store`, `stream`, `include`, `service_tier`, `prompt_cache_key`, `text{verbosity,format}` | `ResponsesApiRequest` |
| `tool_choice` is always `"auto"` | `build_responses_request` |
| `text.format` is `{type: "json_schema", strict, schema, name}` | `create_text_param_for_request` |
| Function tools `{type: "function", name, description, strict, parameters}`; freeform tools `{type: "custom", name, description, format: {type: "grammar", syntax: "lark", definition}}` | `tools/src/tool_spec.rs`, `tools/src/responses_api.rs` |
| `apply_patch` grammar and description | `core/assets/tools/apply_patch.lark`, `core/src/tools/handlers/apply_patch_spec.rs` |
| `exec_command` parameters; `shell_command` shell type in the catalog | `core/src/tools/handlers/shell_spec.rs`, `models-manager/models.json` |
| Item shapes kept on replay (messages with `phase`, reasoning with `encrypted_content`, calls and outputs) | `protocol/src/models.rs` `ResponseItem` |
| Images as `input_image` with `image_url` or `file_id` and `detail` | `protocol/src/models.rs` `ContentItem`, `ImageReference` |
| "Lite" encoding for GPT-6-era models: tools in an `additional_tools` input item, instructions as a developer message, `reasoning.context: "all_turns"`, no parallel tool calls, no image `detail` | `build_responses_request` and `use_responses_lite` in `models.json` |
| `prompt_cache_key` = session id; `session-id` header carries it for cache affinity | `core/src/client.rs` `prompt_cache_key`, `responses_session_id`; `codex-api/src/requests/headers.rs` |
| Efforts `none` ... `max`; `ultra` is rewritten client-side | `protocol/src/openai_models.rs`, `openai_models/reasoning_effort.rs` |
| SSE events handled, terminal on `response.completed`, stream end without it is an error, `error` events remembered, non-JSON data skipped | `codex-api/src/sse/responses.rs` |
| Usage fields `input_tokens(_details.cached_tokens)`, `output_tokens(_details.reasoning_tokens)`, `total_tokens`, and `end_turn` | same |
| `response.failed` codes and their meaning; "try again in Ns" parsing | same |
| 429 `usage_limit_reached` with `resets_at`, `plan_type`; `usage_not_included`; quota codes; 503 `server_is_overloaded` / `slow_down`; 400 policy codes | `codex-api/src/api_bridge.rs` |
| `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`, credits headers, other limit families, `x-codex-active-limit`, `codex.rate_limits` events | `codex-api/src/rate_limits.rs` |
| Request id headers, `openai-model` header | `api_bridge.rs`, `sse/responses.rs` |
| Stream idle timeout of 300 s, 4 request retries | `model-provider-info/src/lib.rs` (`DEFAULT_STREAM_IDLE_TIMEOUT_MS`, `DEFAULT_REQUEST_MAX_RETRIES`) |
| Event and item shapes for `refusal.delta`, `function_call_arguments.delta`, `custom_tool_call_input.delta`, `CustomToolCall`, `ResponseUsage`, `error` | OpenAI's public OpenAPI spec (`openai/openai-openapi`) |

## Judgment calls

- **The default route is `/openai/v1`.** exe.dev's Codex example uses `/v1`,
  which routes by model id. The explicit prefix avoids depending on the
  router knowing new ids like `gpt-6-astra`. `route: "auto"` goes back to
  `/v1`.
- **The default model is `gpt-6-astra`**, the first GPT-6 entry in Codex's
  catalog. `models.pick(["gpt-6"])` finds whatever the integration lists.
- **The lite encoding is used for models the catalog marks lite.** Codex
  sends the GPT-6 family that encoding. Whether the backend also accepts the
  standard encoding for them is unknown, so this library does what Codex
  does. `encoding` overrides it per client or request.
- **Only what Codex sends is sendable.** There is no escape hatch for extra
  fields. `previousResponseId`, `maxOutputTokens`, `temperature`, `store` and
  `stream` are refused by name.
- **`toolChoice` values other than `"auto"`** (`none`, `required`, a named
  tool) are passed through. Codex never sends them.
- **`session-id` is sent** as Codex does. Whether exe.dev forwards it is
  unknown; `prompt_cache_key` goes in the body either way.
- **Retries.** `server_is_overloaded` is retried with backoff; Codex does not
  retry it and shows the user a message instead. `response.incomplete` is not
  retried; Codex does retry it. A cut-off answer repeats the same way more
  often than not, and a content filter certainly does.
- **Usage limits are never retried by the client.** The pacer holds callers
  instead, and `waitForUsageReset` sleeps a Workflow.
- **Patches apply atomically**, unlike Codex, which keeps earlier hunks when a
  later one fails.
- **Paths never leave the workspace.** Codex resolves absolute paths against
  the machine; here they are refused.
- **`exec_command` runs to completion.** Codex's version can return a session
  id for a still-running process plus `write_stdin`. That needs a long-lived
  process host, which a `ShellRunner` may not be, so the description says
  "returning its output and exit code" and the sandbox and approval
  parameters, which belong to Codex's own sandbox, are left out. The output
  format follows Codex's (`Exit code`, `Wall time`, `Output:`).
- **Tool output is cut at 20,000 characters.** Codex's catalog uses a
  10,000-token policy; characters are cheaper to count than tokens.
- **The pacer's `maxConcurrent` of 4** is a guess. So is the 15-minute hold
  after a usage limit that came without a reset time.
- **`stream()` does not retry after output.** It emits `retry` events only
  before any output.
- **Reasoning without `encrypted_content` is dropped from replay** rather
  than sent with an id the server cannot resolve.
- **Item ids from the server are kept on replay**, as current Codex does
  (older Codex versions stripped them).
- **The reflection bridge prefers** an LLM integration whose name or comment
  mentions ChatGPT or Codex, then one named `llm`. Reflection does not say
  which provider source an integration uses.

## Verified live, and what is still unverified

`tests/live/smoke.ts` (see "Live smoke test" below) ran on 2026-09-25 on an
exe.dev VM against a `--openai=chatgpt` integration. It passed on
`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.5`, `gpt-5.6-sol` and
`gpt-daybreak-blue-latest`, and the Jev bridge passed through a TypeSafe HTTP
proxy integration. That settled:

- `/models` lists all three GPT-6 models (bare and `openai/`-prefixed ids)
  and answers under the served id. The GPT-6 models accept the lite encoding
  and `gpt-5.5` the standard one, as the Codex catalog says.
- The proxy streams the SSE through unchanged, and passes the `x-codex-*`
  rate-limit headers (a `codex` limit with a 10,080-minute window) and
  `x-request-id` back.
- Encrypted-reasoning replay, strict structured output, function tools,
  `apply_patch` as a freeform custom tool, and the Blue Team schemas all
  work on every model tried.
- Replayed conversations hit the prompt cache (2,800 to 3,700 of about
  3,900 input tokens cached), so the `prompt_cache_key` and `session-id`
  affinity reach the backend. A hit is not guaranteed on every turn.

Still unverified:

- that the backend's error bodies (usage limits, policy refusals, overload)
  match what Codex parses today; none were provoked;
- that a JSON (non-streaming) answer, which the client accepts, never
  happens in practice;
- the size of the subscription's concurrency tolerance;
- which model a `-latest` alias such as `gpt-daybreak-blue-latest` points
  at; responses name only the alias.

## Live smoke test

```
buck2 run root//src/celld/api/openai:live-smoke-run -- my-vm.exe.xyz \
  --integration chatgpt [--models gpt-6-astra,gpt-6-sol,gpt-6-luna] [--jev typesafe]
```

This bundles `tests/live/smoke.ts` (`:live-smoke`), copies it to the VM,
and runs it there with Deno. Deno is fetched once into `~/.cache/celld-live`
on the VM, at the version and digest pinned in `buck/bin/deno`. Per model it
checks listing, `respond`, `stream`, structured output, a two-turn
conversation, the prompt cache, the agent loop with a function tool,
`apply_patch` and a security review. With `--jev <integration>` it also runs
`routeEffort` and `scoreOutput` through that TypeSafe HTTP proxy
integration. It prints a JSON report and exits non-zero on any failure. It
spends subscription quota (about a dozen small turns per model), so no test
target runs it.

## Testing code that uses it

```typescript
import { FakeResponses, virtualRuntime } from "@celld/api/openai/testing";

const fake = new FakeResponses([
  { reasoning: "plan", toolCalls: [{ name: "lookup", arguments: { key: "a" } }] },
  (request) => ({ text: `saw ${request.body.input.length} items`, chunkSize: 7 }),
  new Response("{}", { status: 503 }),
  new TypeError("connection reset"),
]);
const gpt = new GptClient({ fetch: fake.fetch, runtime: virtualRuntime() });
fake.requests; // every POST /responses, body parsed
```

A script step is a `TurnSpec` (text, reasoning, tool calls, usage, headers,
`status: "failed" | "incomplete"`, `cutAfter` to break the stream,
`chunkSize` to split it into small byte chunks), a ready `Response`, an
`Error` to throw as a connection failure, or a function of the request.
`virtualRuntime` sleeps instantly; `fakeStep` is a Workflow step with replay
(both are `@celld/http/testing`'s, re-exported; `fakeStep()` returns the step,
with `.log` and `.stored` on it); `scriptedShell` answers `exec_command`.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev` against a fake upstream
(`buck2 test root//src/celld/api/openai/examples/...`) and runnable with
`buck2 run root//src/celld/api/openai/examples:<name>-dev`.

## This package's tests

`buck2 test root//src/celld/api/openai/...` runs one Deno suite per concern
(events, requests, client, errors and retries, schemas and the golden file
of model-facing schemas,
conversations, tools, agent loop, pacer and rate limits, apply_patch with
Codex's 25 scenarios, coding tools, chunking, Blue Team, workflows, the Jev,
reflection and sandbox bridges), about 220 cases, plus `:runtime-test`. That
test starts `tests/runtime/` under `celld dev` against a Python fake of the
Codex backend on loopback. The fake refuses any request that breaks the
backend's rules above and streams its events in split writes. The runtime
test covers streaming over real `fetch`, a stream cut off mid-event and
retried, the idle timeout, the pacer serialising calls and holding every
caller after a usage limit across a supervisor restart, an agent whose
encrypted reasoning is replayed and whose conversation survives a restart in
`GptConversations`, structured output, model listing, and an agent run as a
Workflow.

`tests/apply_patch_scenarios.ts` is data from Codex's
`codex-rs/apply-patch/tests/fixtures/scenarios` (Apache-2.0).
