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
[`@celld/http`](../../http), and ids [`@celld/core/ulid`](../../core/README.md#celldcoreulid). Everything else
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
| `@celld/api/openai/sandbox`    | `:sandbox-bridge` | the coding tools over a `@celld/box/sandbox` sandbox, staged `apply_patch`, `disassemble`, `reviewCheckout` | none                 |

The bridges are separate targets, so depending on `:openai` never pulls in
`@celld/api/jev`, `@celld/api/exedev` or `@celld/box/sandbox`. Only `./durable` imports
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

The API root must be `https:` without credentials. A fake integration on
a loopback host (`http://127.0.0.1:...`, as the examples use) needs
`allowLoopbackForDevelopment: true` (`OPENAI_LOOPBACK_FOR_DEVELOPMENT=true`
for `fromEnv`); `http:` to any other host is a `TypeError`. The client
itself sends no credential, but headers you add (`headers`) would travel
in the clear. `integrationBaseUrl` always builds `https:` URLs.

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
`{ signal }` cancels the request, a pacer wait or a retry sleep; a call
cancelled before it is sent is never sent, and a lease the pacer grants it
afterwards is released.

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

await store.save(thread.toJSON(), { expectedItems: null }); // plain JSON, new
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

Stores: `memoryConversationStore({maxEntries})` (at most 10,000
conversations by default), `kvConversationStore(kv, {ttlSeconds})`
(one KV key per conversation, kept for 30 days after its last save by
default; `ttlSeconds: null` keeps it until it is deleted), and `durableConversationStore(env.GPT_CONVERSATIONS, name)` for
the `GptConversations` Durable Object, which keeps one SQLite row per item so
a long conversation never meets the row size limit.

`save(data, options)` says what it replaces. A conversation only grows, and
a conditional save checks that: `{expectedItems: n}` saves only over the `n`
items you loaded, and only when they are the first `n` items saved
(`null`: only when none is stored), and otherwise throws
`ConversationConflictError` and changes nothing, so two requests that each
load, take a turn and save cannot lose one of the turns; the loser loads
again and redoes its turn. The item comparison also refuses a stale writer
whose conversation was removed and made again with as many items.
`{overwrite: true}` replaces whatever is there, for a conversation with one
writer. `maxConversations: n` refuses (`ConversationLimitError`) a save that
would add a conversation to a store already holding `n`. The Durable Object
checks all of it and writes in one transaction, so racing creates cannot
pass the cap together; Workers KV has no compare-and-set, so the KV store
takes `{overwrite: true}` only, without `maxConversations`. A conversation
holds at most `MAX_CONVERSATION_ITEMS` (20,000) items, and the object's
`list(limit)` answers at most `limit` ids (default 1,000, at most 10,000).

```typescript
const stored = await store.load(id);
const thread = stored === null ? new Conversation({ id }) : Conversation.fromJSON(stored);
thread.user(message);
thread.record(await gpt.respond(thread.request()));
await store.save(thread.toJSON(), { expectedItems: stored?.items.length ?? null });
```

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
- Read-only calls run concurrently, four at a time by default. Mutating
  calls run one at a time per workspace (see "Mutation serialization"
  below). Outputs keep call order, and outputs longer than 20,000
  characters are cut in the middle.
- Numbers are checked where they are given: a tool's `timeoutMs` when
  the tool is made (or registered, for a hand-built object) and
  `execute`'s `timeoutMs` (at most `MAX_TOOL_TIMEOUT_MS`, the longest
  timer), `maxOutputChars` (`MIN_OUTPUT_CHARS` 100 to `MAX_OUTPUT_CHARS`
  10,000,000), `concurrency` and `cancelGraceMs` before any call runs; the
  shell tools' `maxTimeoutMs` is 1 ms to `MAX_SHELL_TIMEOUT_MS` (one day).
  A bad value is a `RangeError`, never a timer that fires at once. Should
  the registry itself fail mid-batch, it starts no further call and waits
  for the started ones before rethrowing.
- Every call gets an `AbortSignal` that fires on its timeout or when the
  caller cancels. See "Tool cancellation" below.
- Budgets are checked between steps. When one runs out with calls pending,
  those calls are answered with "not run", so the conversation stays valid
  to resume. A model failure throws `GptError` and leaves the conversation as
  it was before the failed turn.
- An abort mid-batch records every call of the batch first: `execute`
  throws `ToolBatchAbortedError` (a `GptAbortError`) carrying one execution
  per call, and `runAgent` pushes them before rethrowing, so a finished
  call is never left pending and run again. A conversation resumed with
  pending calls anyway (its run died before their results were saved)
  answers the mutating ones `error: not run: interrupted before its result
  was recorded; it may have run; check before repeating it`
  (`INTERRUPTED_CALL`) and runs only the read-only ones;
  `unsafeRerunPendingMutations: true` reruns them, for idempotent tools.
  `ExecuteOptions.skipMutating` is the registry's knob for this.
- `approve` sees each call as plain data (`call`, `tool.risk`, the `args`
  as the model sent them, already validated, and `turn`) and returns `true`
  or `{ allow: false, reason }`. The reason goes back to the model.

### Mutation serialization

Every tool declares `mutates` (default `true`; only a tool proven
read-only should say `false`; a hand-built tool object without the field
counts as mutating everywhere, and one whose field is not a boolean is
refused by the registry) and optionally a `workspace`, an object
standing for what it changes. The registry runs mutating calls with the
same `workspace` one at a time, in call order, and this holds across
executions and registries that share the object. A call takes its place
before `approve` is asked about it, so approvals may finish in any order
(and run concurrently) while the calls still run in theirs; a denied or
cancelled call gives its place up. Read-only calls overlap
with anything, up to `concurrency`. Tools that name no workspace share the
registry's own key (kept by `with()`, or set with `new ToolRegistry(tools,
{ workspace })`), so undeclared mutating tools never overlap each other.

The coding tools follow this: `read_file`, `list_dir` and `grep_files` are
read-only, while `apply_patch`, `exec_command` and `shell` mutate. Their
workspace is the file system's `workspace` (default the file system
itself), and `codingTools` puts the shell on the same one. Over a sandbox,
`sandboxFileSystem`, `sandboxShellRunner` and `sandboxApplyPatchTool` all
use the sandbox object as the key, so pass one client object per sandbox.
The lanes live in one isolate; across Workers, the sandbox's lease
`workspace` serializes the mutations (see "Sandboxes"). The sandbox
enforces it: every writer in `@celld/api/openai/sandbox` passes the
lease's token as `lease`, and while the lease is held the sandbox refuses
a mutating call without that token (`lease_held`, a 409), refuses one
naming a lease that is no longer held (`lease_lost`), and stops the
mutating commands, file helpers and default-mutating background processes,
awaiting their cleanup before it grants the lease to someone else. So
code that writes through the sandbox directly without the lease fails
while another caller holds it. `mutates: false` on commands and background
processes remains a trusted declaration the sandbox cannot check. Guest code
can also alter its own supervision files. This is not isolation between
mutually hostile callers: give each trust domain its own keyed sandbox ID.

The registry serializes regardless of what the model is told.
`registry.readOnly` is true when no tool mutates, and `runAgent` sends
`parallelToolCalls: registry.readOnly` unless `request.parallelToolCalls`
says otherwise. The model is asked for one call at a time only when some
tool could conflict with another.

The lanes are in memory, keyed by the workspace object itself: they order
the calls of one isolate that share that object, and nothing else. Two
client objects for the same sandbox (two `getSandbox` calls, say) get two
lanes, and a call in another isolate or another Worker is not ordered
against this one at all. Something that must never overlap across
isolates needs its own serialization, such as a Durable Object that runs
the change.

If a mutating call is abandoned (see below), its workspace refuses further
mutating calls (`skipped`, "an earlier call on this workspace was abandoned
and may still be running") until the abandoned handler settles.

### Tool cancellation

Cancellation is cooperative. When a call times out, or its execution is
aborted, the registry aborts the call's `context.signal`, waits up to
`cancelGraceMs` for the handler to settle, and then reports `timeout` (or,
for an aborted execution, throws `ToolBatchAbortedError`, a
`GptAbortError`). A handler that finished anyway is reported with its
result (`error: timed out after N ms, but the call finished:` and the
output, so the model does not redo it); one that stopped on a caller's
abort keeps its own error (`error: aborted` and, say, a
`PartialPatchError`'s message). JavaScript cannot stop a
handler that ignores the signal: it keeps running, and is reported as
`abandoned` (below). A handler that changes anything must therefore stop
when the signal fires and settle only once it has stopped. The built-in
tools do:

- `exec_command` and `shell` hand the signal to the `ShellRunner`. Over a
  sandbox, `sandboxShellRunner` passes it to `exec`/`execShell`, which kill
  the command's process group, and the call settles only after the kill.
- `apply_patch` checks the signal before each file it changes. An abort
  between two files stops the patch with a `PartialPatchError` listing
  `committed` and `pending` paths, and its message reaches the model after
  `error: timed out after N ms`.

If the handler has not settled `cancelGraceMs` (default 5 s,
`toolCancelGraceMs` in `runAgent`) after the signal fired, the execution is
reported with `abandoned: true` and passed to `onAbandoned` (default
`console.warn`). Such a handler may still be running.

`reviewCheckout` hands its clone a signal too (the caller's
`options.call.signal`, or the workspace lease being lost), so a cancelled
review kills the clone's process group; the clone may leave a partial
checkout behind.

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
nothing. Codex keeps the hunks that succeeded before a failing one. Every
change is planned against the tree the earlier hunks leave, directories
above each written file included, before the first write, so a file added
below a file (`parent`, then `parent/child`) fails with nothing written. A
write the file system refuses anyway (a full disk, another writer) stops
the patch with a `PartialPatchError` naming the `committed` and `pending`
paths.

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

`grep_files` finds lines containing its `pattern` as literal text. With
`regex: true` the pattern is a POSIX extended regular expression of at most
256 bytes, and it runs only where a deadline can stop it: the file
system's optional `search` (a sandbox runs `grep -E` in its container,
through its `searchFiles`, under the call's signal, over regular files
only and never through a symbolic link). A file system without `search`, such as
`MemoryFileSystem`, refuses it: a regular expression evaluated in the
isolate cannot be interrupted, and a backtracking one would stop the
Worker. Globs (`include`, and `reviewCheckout`'s `include`/`exclude`) are
matched by `globMatcher(glob)`, which never builds a regular expression
either: `*` is anything but `/`, `**` anything, `**/` no directory or
several, `?` one character but `/`.

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

`@celld/api/openai/sandbox` (`:sandbox-bridge`, which depends on `@celld/box/sandbox`)
puts the coding tools and the Blue Team helpers in a per-id container:

```typescript
import { getSandbox } from "@celld/box/sandbox";
import { reverseEngineerFile, reviewCheckout, sandboxCodingTools } from "@celld/api/openai/sandbox";

// The id comes from the authenticated caller (a keyed hash of
// `principal.key`, as the `sandbox` example does), never from a request
// field, or one caller could open another's sandbox.
const box = getSandbox(env.SANDBOX, sandboxIdFor(principal));
await runAgent({ client: gpt, conversation, tools: new ToolRegistry(sandboxCodingTools(box)) });

const { result: notes, disassembly } = await reverseEngineerFile(gpt, box, "upload/sample", { tool: "objdump" });
const review = await reviewCheckout(gpt, box, "https://github.com/acme/api", { include: ["src/**"] });
```

`sandboxFileSystem(box, {maxEntries?})` and `sandboxShellRunner(box)` are
this library's `FileSystem` and `ShellRunner` over a `SandboxClient` or
`SandboxCore`. The file system is for reading: its `write` and `remove`
throw, because every change to the workspace holds the workspace lease
(below) and a patch planned from reads and written file by file cannot, so
`codingTools({ fs: sandboxFileSystem(box) })` gets an `apply_patch` that
refuses. Use `sandboxCodingTools`, and `sandboxWriteFile(box, path,
content, {signal?, ...WriteFileOptions})` for one file (an upload route).
`read` answers null for missing, directory and non-UTF-8
paths. `list` is recursive and includes dotfiles; it pages through the
sandbox's listing cursor and never returns part of a directory: one with
more than `maxEntries` entries (default 20,000, at most 100,000) throws
`TruncatedListingError`, which names the directory and the limit, and one
that changed between two pages throws `ListingChangedError`: the
sandbox's cursor names the last entry of its page, and the sandbox
refuses the next page (`listing_changed`) when the walk no longer lines
up, so a dropped or added entry is caught, not only a repeated one.
`read` and `list` take `{signal}`; `list` checks it between pages. With
the sandbox's `searchFiles`, `stat` and `exec`, `search` gives
`grep_files` its regular expressions (`grep -E` in the container, 30 s at
most, killed with the call's signal). `searchFiles` walks with `find
-type f` inside the directory it entered, so grep reads regular files
only and never a link. It does follow links on the way to the directory
(within the workspace), so the bridge first checks the directory with
`stat` and `noFollow` and refuses one reached through a link; that check
and the search are two sandbox calls. The pattern is checked first, on
one line, with a read-only `exec` (`mutates: false`): busybox's grep
compiles a pattern only once it has a line, so the sandbox's own check
over an empty file lets a bad pattern through, and the search would answer
"no matches". A pattern grep refuses is an error saying "bad pattern".
The shell runs strings with `sh -c` and argv lists directly, with stderr
interleaved and the tool's timeout as the deadline.
`sandboxCodingTools(box, {readOnly?, shell?, maxEntries?})` is `codingTools`
over them.
Its `apply_patch` and `exec_command` share the sandbox's mutation lane, so
a command never runs in the middle of a patch. Both also hold the
sandbox's lease `workspace` (`withWorkspaceLease`, over `@celld/box/sandbox`'s
`acquireLease`) while they run: the lane covers one isolate, the lease
every Worker that uses the sandbox, so a patch planned from reads is never
interleaved with another isolate's patch or command. A caller waits for
the lease until its signal aborts (60 s without one, then
`WorkspaceLeaseError`); the lease is renewed every 10 s while the work
runs, and the work is aborted when a renewal says the lease is gone, when
no renewal has succeeded 5 s before the last grant would run out (counted
from when it was asked for, so a stalled renewal is given up before anyone
else can take the lease), and after `maxHoldMs` (default 10 minutes; a
shell command's own timeout plus `LEASE_KILL_GRACE_MS`, 30 s), after which
the lease is no longer renewed: a mutation stuck on a call that never
settles fences other Workers for a bounded time. `withWorkspaceLease(box,
signal, work, {ttlMs?, maxHoldMs?})` is exported for callers' own writers:
`work(signal, lease)` gets the lease's token and passes it as `lease` to
every mutating sandbox call.

The sandbox enforces the lease. Every writer here (`sandboxApplyPatch`,
the shell, `sandboxWriteFile`, `reviewCheckout`'s clone) passes the token
to each mutating call it makes (`exec`/`execShell`, `writeFile`,
`renameFile`, `deleteFile`, `remove`, `gitCheckout`); while the lease is
held, the sandbox refuses a mutation without the token (`lease_held`)
and one whose lease was lost (`lease_lost`), and granting the lease kills and
awaits earlier mutations, including file helpers and default-mutating background
processes. A refusal that reaches
`withWorkspaceLease` is a `WorkspaceLeaseError` naming it; nothing is
retried. Read-only commands declare `mutates: false` (`disassemble`, the
search's pattern check) and run during another caller's lease. What the
sandbox cannot enforce: `mutates: false` is the caller's word, and commands
share guest-writable supervision state. A server intended to survive handoff
must explicitly use `mutates: false`. Mutually hostile callers must use separate
containers. `withWorkspaceLease` is now provided by `@celld/box/sandbox` and
re-exported here unchanged. `SandboxClient.withWorkspaceLease` additionally
offers a file-only, automatically token-injecting scoped facade; it deliberately
does not expose arbitrary execution, shared settings, or the raw stub.

Its `apply_patch` is `sandboxApplyPatch`, which narrows the window in which
a patch is half applied. The patch is planned against the workspace first
(a bad patch changes nothing), every new file is written beside its target
under a temporary name with the target's permissions, and then each is
renamed into place and deleted files are removed. Each rename is atomic; the
patch is not. A failure or a concurrent writer during the renames leaves some
files changed, and the error, `PartialPatchError`, lists which were
(`committed`) and which were not (`pending`). A symbolic link that a patch
updates becomes a regular file. `sandboxApplyPatch(box, patch, {signal})`
checks the signal before every write, rename and removal. After an abort,
the only thing it changes is deleting its own temporary files and the
directories it created for them (it needs the sandbox's `remove` for that).

`disassemble(box, path, {tool, args?, timeoutMs?, maxOutputBytes?, signal?})` runs
`objdump`, `strings`, `readelf`, `nm` or `hexdump` (default flags in
`DISASSEMBLERS`) on a workspace file as an argv list, with the path after
`--`, a 60 s deadline and a 1 MiB output cap. A non-zero exit or a timeout
throws with the tool's stderr; a cut output is returned with `truncated`.
`reverseEngineerFile(gpt, box, path, options)` passes the output to
`reverseEngineer`. The pinned busybox image has `strings` and `hexdump`;
objdump, readelf and nm need binutils (or LLVM's tools) in the image.

`reviewCheckout(gpt, box, url, options)` clones with `gitCheckout` (https
only, cancelled by `options.call.signal`, symbolic links checked out as
plain files by the sandbox's default; `unsafeSymlinks` is never passed),
reads the checkout's regular
text files (skipping `.git/`, binaries, files past `maxFileChars` (default
200,000, at most 10,000,000) or `maxFiles` (default 200, at most 10,000),
and anything outside `include`/inside `exclude`), and runs
`securityReview` over them. The clone and the reads hold the workspace
lease; the model's review runs after it is given back. Finding paths are
relative to the checkout. The result carries the checkout as `fs`, a
`sandboxDirectoryView(box, dir)`, so `readOnlyTools(review.fs)` lets an
agent follow up on the findings without being able to change anything.

A repository chooses its own symbolic links, and the sandbox confines
links to the workspace, not to the checkout: a committed `up -> ..` would
otherwise read every other file in the workspace (the clone already
writes links as plain files, so this matters for checkouts made some other
way). `sandboxDirectoryView` refuses any path with a link among its
components, from the workspace root down, and lists regular files only.
Its `read`, `kind` and `list` are one sandbox call each with `noFollow`:
the sandbox checks every step where it landed and the file it opened
(`is_symlink`), so the check and the read are one step, and a link a
writer swaps in is refused by the read itself. The review reads the same
way. A regular-expression search checks its directory with `stat`
(`noFollow`) and then calls `searchFiles`, which reads regular files only
but follows links on the way to its directory: a directory swapped for a
link between those two calls is searched, though never anything outside
the workspace.

**Run untrusted binaries and repositories on the `hostile` tier.**
Analyzers parse hostile input and have had parser bugs; a cloned repository
can hold anything. Under runc a container shares the host kernel, so it is
no boundary against hostile code. Give the sandbox class
`settings = { tier: "hostile" }` and its container `"runtime": "runsc"`
(gVisor), so an exploited analyzer lands in gVisor's user-space kernel
rather than the host's. The runtime declaration is not an independent
runtime check. Omitting it can select the default runc; an unavailable
explicitly selected runsc fails startup rather than falling back to runc.
The `hostile` tier additionally requires a successful trusted-image gVisor
probe and refuses when it cannot verify gVisor. Require
`root//src/celld/box/sandbox:integration-runsc-test` to pass on the intended
image/runtime before admitting hostile workloads; runc refusal tests do
not replace this positive acceptance lane. See `@celld/box/sandbox`'s README,
"Threat tiers".

The [`sandbox`](examples/sandbox.ts) example runs the staged `apply_patch`
and `strings` into `reverseEngineer` in the pinned busybox container
(`needs-docker`). Each caller authenticates with a bearer JWT. The sandbox
is named by a keyed hash of the caller's principal key, never by a request
header, and an unexpected failure is an opaque 500 that names only the
request id. Its `Analyzer` is on the `hostile` tier. The development spec
deliberately exercises runc by opting into `UnsafeTrustedAnalyzer` through
a development-only variable; every answer says `"tier": "trusted (unsafe)"`.
The separate `:sandbox-hostile-test` shows the hostile class refusing runc.
Neither fixture is a production deployment or positive runsc acceptance.

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
  `onError: "allow"`. Jev always sees the whole call: arguments longer than
  `maxCallChars` (default 8,000 characters) are never clipped to fit, but
  denied or handed whole to `onTooLarge` (another approver).
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
  saying a window is at 100%. No hold lasts longer than `maxBlockMs` (8
  days) from when it is set, whatever a response claimed. A wait read from
  a server's text is cut to `MAX_SERVER_WAIT_MS` (8 days), and a reset time
  that is not a date (negative, not finite, past the year 9999) is dropped.
- The pacer keeps the latest windows of at most `MAX_RATE_LIMIT_FAMILIES`
  (16) limit families, the most recently reported, with checked ids (1-64
  of `a-z 0-9 _`), and forgets a family once all its windows have reset;
  responses and streams are parsed with the same cap.
- Leases and blocks arrive over RPC and are checked: a `leaseMs` or
  `until` that is not a time is a `RangeError`, and a wait the pacer
  answers that is not a number counts as a pacer failure (below).
- A client whose wait would pass `maxPacerWaitMs` (one minute) fails at once
  with kind `usage_limit` and the reset time. It does not send a request it
  knows will fail.
- Leases live in memory. The block, the configuration and the usage totals
  are in the object's SQLite, and a new block waits for `storage.sync()`, so
  a usage limit keeps holding across restarts. `snapshot()` shows the
  latest rate-limit windows and totals; `configure`, `block` and `unblock`
  are there for operators.
- If the object cannot be reached or answers nonsense, the call goes ahead
  and `onPacerError` hears about it.

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
`fix:tools-0`, ...). A replayed Workflow gets the stored results of
finished steps back and records them into a conversation built the same
way, so a finished turn is not paid for again and a finished batch does
not run again. A batch whose step failed is different: a retry runs the
whole batch again, every call in it, even one that had finished. So a
tool batch with a mutating call gets `DEFAULT_MUTATING_TOOLS_STEP`, which
does not retry: the run fails rather than repeat changes that may have
happened. Batches of read-only calls keep `DEFAULT_TOOLS_STEP` (two
retries), since repeating a read is harmless.

A crash is not a retry, and no retry policy stops it: when the isolate
dies mid-batch, the step has no stored result, and celld reruns `run` on
resume, calling the batch's callback again. So a mutating batch first
records a marker step (`fix:tools-0:start`); a replay that finds the
marker but no batch result answers every mutating call with
`INTERRUPTED_CALL` ("it may have run; check before repeating it") and
reruns only the read-only calls. `unsafeRetryMutatingTools: true` drops
the marker and retries mutating batches too, for tools that are
idempotent; make each mutating tool safe to repeat where it can be.
Transient model failures are thrown so the step's retries apply;
permanent ones are stored and end the run.
`waitForUsageReset(step, name, error, {marginMs})` sleeps the Workflow until a
usage limit resets, plus `marginMs` (default one minute, at most one hour).
The reset time comes from the server: one that is not finite, or more than
`MAX_USAGE_RESET_WAIT_MS` (8 days) away, is not slept on (`false`). `respondStep` wraps a single call. Step results are capped at 1 MiB;
a turn carries its encrypted reasoning, usually a few kilobytes.

## Threat model

What the library protects, and what is left to the Worker:

- **The subscription is the credential.** exe.dev adds the ChatGPT
  account's credentials at its edge, so anything that can make this
  Worker call the model spends the account's quota. The library has no
  notion of callers: authenticating them, deciding who may spend how much,
  and pacing them per caller is the Worker's job. The pacer only paces the
  subscription as a whole, and it fails open when its object cannot be
  reached.
- **Tool calls are the model's choice, and the model reads text an
  attacker may control** (a diff, an alert, a sample's strings, a web
  page). Arguments are checked against the tool's schema and every call
  goes through `approve`, but approval that reads the same text (a Jev
  approver judging a call against the task) can be steered by it. Give the
  agent only the tools the caller may use, and decide approval from the
  authenticated principal, not from the request.
- **Mutations are serialized per workspace object in one isolate**, not
  across isolates (see "Mutation serialization"). A Workflow's tool batch
  can run again after an interruption (see "Workflows").
- **Cancellation is cooperative** (see "Tool cancellation"): a handler that
  ignores its signal keeps running. The sandbox bridge passes the call's
  signal to `exec`, `execShell` and `gitCheckout`, which kill the command.
- **Sandboxes contain hostile code only on gVisor**, on the `hostile` tier
  (see "Sandboxes"). Under runc a container shares the host kernel. Name a
  caller's sandbox from its verified principal, never from the request.
- **Not protected:** what the model says. Structured output is checked
  against its schema, not for truth; findings, triage verdicts and
  reverse-engineering notes are advice.

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
| `http`            | any other status, a redirect (never followed)                                    | no      |
| `context_window`  | `context_length_exceeded`                                                        | no      |
| `policy`          | `cyber_policy`, `bio_policy`, `invalid_prompt`, `misalignment_policy_violation`  | no      |
| `incomplete`      | `response.incomplete`; `code` is the reason                                      | no      |
| `stream`          | the stream ended or broke before `response.completed`                            | yes     |
| `connection`      | no response                                                                      | yes     |
| `timeout`         | no headers within `connectTimeoutMs`, no event within `idleTimeoutMs`, an attempt past `maxStreamMs`, or budget | yes     |
| `aborted`         | the caller's signal fired                                                        | never   |
| `decode`          | a 2xx body or item without the documented shape, or a response past `maxResponseBytes` | no      |
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
| `maxStreamMs`                          | 30 min for one attempt, however steadily events arrive       |
| `maxResponseBytes`                     | 32 MiB per response, streamed or not (1 KiB to 1 GiB)        |

Every body is read under a byte cap and cancelled past it: an answer or a
stream past `maxResponseBytes` fails as `decode`, an error body is read to
its first 64 KiB, and the model list to 4 MiB. Requests go out with
`redirect: "manual"`: a 3xx is an `http` failure, so the prompt never
follows a redirect to another origin.

The server's wait comes from `retry-after-ms`, `retry-after`, or, for
in-stream rate limits, the "try again in 1.5s" text Codex also reads. There
is no default overall budget because a high-effort answer can stream for many
minutes; the idle timeout catches a stalled stream. A `budgetMs` that is set
bounds the whole call, pacer waits, attempts and retry waits alike, for
responses and `models.list`: an attempt ends when the budget does, and a
retry whose wait would reach it is not started. All of it can be set per
client and per call.

The policy is a `GptRetryPolicy`: `@celld/http`'s `RetryPolicy` (backoff,
budget, `retry-after`) plus `retryOn`, the kinds to retry.
`resolveGptRetryPolicy(options, base)` fills and checks a partial one;
`retryOn` may be any iterable, and an option set to `undefined` keeps the
default. The backoff arithmetic, `retry-after` parsing, the injectable
`Runtime`, and the SSE parser are `@celld/http`'s.

### Which requests are retried

A request is sent again only if it is declared idempotent, and then only for
the kinds in `retryOn`. `mayRetryGpt(policy, error, { idempotent })` makes
that decision and defers to `@celld/http`'s `mayRetry`.
`requestIdempotency(kind, body)` declares each kind of request the client
sends:

| Request | Kind | Idempotent | Why |
| --- | --- | --- | --- |
| `POST /responses` | `responses` | only when the body has `store: false` | the backend keeps nothing, so a repeat costs usage and nothing else |
| `GET /models` | `models.list` | yes | a read |

The request builder always sends `store: false` and refuses a `store`
field, so every Responses call is retried on a stream break, a timeout or a
5xx. A body without `store: false` would leave a stored response behind. It
counts as not idempotent and is never sent twice once the server may have
seen it, and that includes connection failures, since a rejected `fetch`
does not prove the request never arrived (the same rule `@celld/mcp`
follows). Conversations, items and uploads are not in the table, so an
undeclared kind throws. A new kind of request must be added to the table
before the client will retry it.

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
`buck2 run root//src/celld/api/openai/examples:<name>-dev`. `chat`,
`extract`, `agent`, `review` and `bridge` are deliberately unauthenticated
local demos (anyone who reaches them spends the subscription's quota);
`threads` and `sandbox` authenticate every caller. The
[examples README](examples/README.md) says what each one exposes.

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
