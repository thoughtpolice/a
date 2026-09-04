// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time contracts for the celld toolchain's 0.5.1 platform boundary.
 *
 * Deno checks these function bodies but never invokes them: only celld supplies
 * the actual bindings and builtin modules. Positive assertions check inference;
 * expect-error directives ensure unsupported runtime operations stay untyped.
 * This module is test-only and is not included in application Worker bundles.
 * `celld.test` supplies the toolchain's shared ambient declarations.
 *
 * @module
 */

import type {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import type { NonRetryableError } from "cloudflare:workflows";
import type { connect, Socket as ImportedSocket } from "cloudflare:sockets";
import type { RpcStub } from "cloudflare:workers";

/** Checks assignability without casting away the source expression's type. */
function expectType<Type>(_value: Type): void {}

/** Public/private shapes used only to check class-instance RPC projections. */
export class RPCContract {
  /** Ordinary own data must never become a remote property promise. */
  label = "counter";
  /** DO RPC accepts own function fields; service RPC requires prototype methods. */
  ownMethod = (value: number): number => value + 1;
  /** JavaScript private state does not appear in a public type's keys. */
  #secret = 2;
  /** Runtime-private helper used by the public method. */
  #helper(value: number): number {
    return value + this.#secret;
  }
  /** TypeScript privacy is only a compile-time restriction. */
  private erasedHelper(value: number): number {
    return this.#helper(value);
  }
  /** Protected methods also stay out of the caller's static contract. */
  protected inheritedHelper(): void {}
  /** Sync methods become asynchronous on the wire. */
  add(value: number, increment = 1): number {
    return this.erasedHelper(value) + increment;
  }
  /** Async nullable results must not lose their null branch or nest promises. */
  lookup(_key: string): Promise<{ count: number } | null> {
    return Promise.resolve(null);
  }
  /** Method results remain plain data, not pipelined RPC properties. */
  snapshot(): { nested: { count: number } } {
    return { nested: { count: 1 } };
  }
  /** DO lifecycle methods are callable in celld 0.5.0, unlike service entrypoints. */
  alarm(): void {}
  /** DO scheduled methods are not the service binding's scheduled helper. */
  scheduled(value: number): number {
    return value;
  }
  /** Native fetch transport must retain Fetcher's signature. */
  fetch(_request: Request): Response {
    return new Response();
  }
  /** Stub identity is local even if an application declares a same-named method. */
  id(): string {
    return "application id";
  }
  /** Symbols never dispatch through a remote method lookup. */
  [Symbol.iterator](): number {
    return 1;
  }
}

/** Checks namespace propagation and native DO method/transport visibility. */
export async function checkDurableObjectRPC(
  namespace: DurableObjectNamespace<RPCContract>,
): Promise<void> {
  const stub = namespace.getByName("one");
  expectType<DurableObjectStub<RPCContract>>(
    namespace.get(namespace.idFromName("one")),
  );
  expectType<DurableObjectStub<RPCContract>>(
    namespace.jurisdiction(null).getByName("one"),
  );
  expectType<Promise<number>>(stub.add(2));
  expectType<number>(await stub.add(2, 3));
  expectType<{ count: number } | null>(await stub.lookup("one"));
  expectType<Promise<void>>(stub.alarm());
  expectType<Promise<number>>(stub.scheduled(1));
  expectType<Promise<number>>(stub.ownMethod(1));
  expectType<DurableObjectId>(stub.id);
  expectType<Response>(
    await stub.fetch("https://example.invalid/", { method: "POST" }),
  );
  expectType<DurableObjectNamespace>(namespace);
  // @ts-expect-error Method arguments are checked against the declared API.
  stub.add("2");
  // @ts-expect-error Required method arguments cannot be omitted.
  stub.lookup();
  // @ts-expect-error Remote synchronous methods still return a promise.
  expectType<number>(stub.add(2));
  // @ts-expect-error Nullable results must be checked before use.
  expectType<{ count: number }>(await stub.lookup("one"));
  // @ts-expect-error Plain result promises do not advertise property pipelining.
  stub.snapshot().nested.count;
  // @ts-expect-error Non-function instance fields are not callable remote methods.
  stub.label;
  // @ts-expect-error JavaScript private names cannot be looked up through a stub.
  stub["#helper"](1);
  // @ts-expect-error TypeScript-private members are omitted from the public contract.
  stub.erasedHelper(1);
  // @ts-expect-error Protected members are omitted from the public contract.
  stub.inheritedHelper();
  // @ts-expect-error Symbol methods are not transported.
  stub[Symbol.iterator]();
  // @ts-expect-error Stub identity is not the application's id method.
  stub.id();
  // @ts-expect-error Stubs are not thenable RPC objects.
  stub.then();
  // @ts-expect-error An omitted generic cannot invent application methods.
  (namespace as DurableObjectNamespace).getByName("one").add(1);
}

/** Checks service entrypoint restrictions without promising same-isolate features. */
export async function checkServiceRPC(
  service: ServiceBinding<RPCContract>,
): Promise<void> {
  expectType<Promise<number>>(service.add(1));
  expectType<{ count: number } | null>(await service.lookup("one"));
  expectType<Response>(await service.fetch("https://example.invalid/"));
  expectType<Promise<string>>(service.id());
  expectType<ServiceBinding>(service);
  // @ts-expect-error Service methods retain their argument types.
  service.add("1");
  // @ts-expect-error Service entrypoint lifecycle methods are reserved at runtime.
  service.alarm();
  // @ts-expect-error Scheduled is the optional native helper, not application RPC.
  service.scheduled!(1);
  // @ts-expect-error Service own data is not part of the typed method subset.
  service.label;
  // @ts-expect-error Service method results do not advertise property pipelining.
  service.snapshot().nested.count;
  // @ts-expect-error The ordinary default retains only the Fetcher surface.
  (service as ServiceBinding).add(1);
}

/** Removed bindings must not silently remain available in the platform boundary. */
export function checkRemovedAI(): void {
  // @ts-expect-error 0.5.0 removed Workers AI; applications supply their own HTTP clients.
  expectType<Ai>({});
  // @ts-expect-error Ai is not a global constructor either.
  new Ai();
}

/** Checks same-isolate RPC projection, including function targets and property pipelines. */
export async function checkRPC(
  Stub: typeof RpcStub,
  namespace: DurableObjectNamespace,
): Promise<void> {
  const stub = new Stub({
    add(value: number) {
      return value + 1;
    },
    label: "counter",
    nested: { answer: 42 },
  });
  expectType<number>(await stub.add(1));
  expectType<Promise<number>>(stub.add(1));
  expectType<string>(await stub.label);
  expectType<number>(await stub.nested.answer);
  expectType<number>(await stub.dup().add(2));
  stub[Symbol.dispose]();
  const callable = new Stub((value: number) => value + 1);
  expectType<number>(await callable(2));
  // @ts-expect-error RPC does not synchronously return a target method's result.
  expectType<number>(stub.add(1));
  // @ts-expect-error RPC method parameter types are retained.
  await stub.add("1");
  // @ts-expect-error Callable RPC targets retain their parameter types.
  await callable("2");
  expectType<DurableObjectNamespace>(namespace.jurisdiction(null));
  namespace.newUniqueId({ jurisdiction: null });
  // @ts-expect-error celld rejects actual jurisdiction restrictions.
  namespace.jurisdiction("eu");
  // @ts-expect-error New IDs cannot request restricted jurisdictions either.
  namespace.newUniqueId({ jurisdiction: "eu" });
}

/** Exercises scalar/bulk KV decoding, metadata, pagination, and accepted writes. */
export async function checkKV(kv: KVNamespace): Promise<void> {
  expectType<string | null>(await kv.get("text"));
  expectType<string | null>(await kv.get("text", { cacheTtl: 60 }));
  expectType<{ ok: boolean } | null>(
    await kv.get<{ ok: boolean }>("json", "json"),
  );
  expectType<ArrayBuffer | null>(
    await kv.get("bytes", { type: "arrayBuffer" }),
  );
  expectType<ReadableStream<Uint8Array> | null>(
    await kv.get("stream", "stream"),
  );
  expectType<Map<string, string | null>>(await kv.get(["a", "b"]));
  expectType<Map<string, number | null>>(
    await kv.get<number>(["a"], { type: "json" }),
  );
  expectType<Map<string, ArrayBuffer | null>>(
    await kv.get(["a"], "arrayBuffer"),
  );
  expectType<Map<string, ReadableStream<Uint8Array> | null>>(
    await kv.get(["a"], "stream"),
  );
  const single = await kv.getWithMetadata<{ version: number }>("a");
  expectType<string | null>(single.value);
  expectType<{ version: number } | null>(single.metadata);
  expectType<null>(single.cacheStatus);
  const bulk = await kv.getWithMetadata<number, { version: number }>(
    ["a"],
    "json",
  );
  expectType<number | null | undefined>(bulk.get("a")?.value);
  // @ts-expect-error Bulk metadata entries do not carry cacheStatus.
  bulk.get("a")?.cacheStatus;
  const page = await kv.list<{ version: number }>({ prefix: "a", limit: 2 });
  if (!page.list_complete) expectType<string>(page.cursor);
  await kv.put("a", new Uint8Array([1]), {
    metadata: { version: 1 },
    expirationTtl: 60,
  });
  await kv.delete("a");
  await kv.deleteBulk(["a", "b"]);
  await kv.put("a", new ReadableStream<Uint8Array>());
  await kv.put("a", new ReadableStream<ArrayBuffer>());
  // @ts-expect-error KV.put accepts byte streams, not streams of strings.
  await kv.put("a", new ReadableStream<string>());
  // @ts-expect-error KV.put does not accept Blobs; use blob.stream() instead.
  await kv.put("a", new Blob(["text"]));
  // @ts-expect-error JSON decoding requires an explicit type, even with a generic.
  await kv.get<number>("a", { cacheTtl: 60 });
}

/** Checks Queue producer metadata, typed consumer messages, and dispatch-only APIs. */
export async function checkQueues(
  queue: Queue<{ id: string }>,
  batch: MessageBatch<{ id: string }>,
): Promise<void> {
  const sent = await queue.send({ id: "a" }, {
    contentType: "json",
    delaySeconds: 1,
  });
  expectType<number>(sent.metadata.metrics.backlogCount);
  expectType<Date | undefined>(sent.metadata.metrics.oldestMessageTimestamp);
  const sentBatch = await queue.sendBatch(new Set([{ body: { id: "b" } }]));
  expectType<number>(sentBatch.metadata.metrics.backlogBytes);
  expectType<QueueMetrics>(await queue.metrics());
  expectType<string>(batch.queue);
  expectType<number>(batch.metadata.metrics.backlogCount);
  for (const message of batch.messages) {
    expectType<string>(message.body.id);
    expectType<Date>(message.timestamp);
    expectType<number>(message.attempts);
    message.ack();
    message.retry({ delaySeconds: 1 });
  }
  batch.ackAll();
  batch.retryAll();
  const consumer: ExportedHandler<
    unknown,
    Record<string, unknown>,
    unknown,
    { id: string }
  > = {
    queue(incoming, _env, ctx) {
      expectType<string>(incoming.messages[0].body.id);
      ctx.waitUntil(Promise.resolve());
    },
  };
  expectType<typeof consumer>(consumer);
  // @ts-expect-error celld has no pull-consumer binding API.
  await queue.receive();
  // @ts-expect-error The producer body must match its generic parameter.
  await queue.send({ id: 42 });
}

/** Checks R2 conditions, body consumption, checksums, pagination, and multipart handles. */
export async function checkR2(bucket: R2Bucket): Promise<void> {
  const object = await bucket.get("a", { range: { suffix: 10 } });
  if (object) {
    expectType<ReadableStream<Uint8Array>>(object.body);
    expectType<Uint8Array>(await object.bytes());
    object.writeHttpMetadata(new Headers());
    expectType<Date>(object.uploaded);
  }
  const conditional = await bucket.get("a", { onlyIf: { etagMatches: "tag" } });
  if (conditional) {
    // @ts-expect-error Failed conditions return metadata without a body.
    await conditional.text();
    if ("body" in conditional) expectType<string>(await conditional.text());
  }
  expectType<R2Object | null>(await bucket.head("a"));
  expectType<R2Object>(
    await bucket.put("a", "text", {
      httpMetadata: { contentType: "text/plain", cacheExpiry: new Date() },
      sha256: new Uint8Array(32),
    }),
  );
  expectType<R2Object | null>(
    await bucket.put("a", null, { onlyIf: new Headers() }),
  );
  const page = await bucket.list({
    include: ["httpMetadata", "customMetadata"],
  });
  if (page.truncated) expectType<string>(page.cursor);
  const upload = await bucket.createMultipartUpload("a", {
    storageClass: "Standard",
  });
  expectType<R2MultipartUpload>(
    bucket.resumeMultipartUpload(upload.key, upload.uploadId),
  );
  const part = await upload.uploadPart(1, new Blob(["part"]));
  expectType<R2Object>(await upload.complete([part]));
  await upload.abort();
  await bucket.delete(["a"]);
  // @ts-expect-error Multipart creation cannot verify checksums.
  await bucket.createMultipartUpload("a", { sha256: "hash" });
  // @ts-expect-error Customer-provided encryption keys are unsupported.
  await bucket.get("a", { ssecKey: new Uint8Array(32) });
}

/** Checks Workflow lifecycle, step contexts, dynamic retries, and builtin type imports. */
export async function checkWorkflows(
  workflow: Workflow<{ revision: string }, number>,
  step: WorkflowStep,
  entrypoint: WorkflowEntrypoint<unknown, { revision: string }>,
  event: WorkflowEvent<{ revision: string }>,
  permanent: NonRetryableError,
): Promise<void> {
  expectType<Error>(permanent);
  expectType<string>(event.payload.revision);
  expectType<Promise<unknown>>(entrypoint.run(event, step));
  const instance = await workflow.create({
    id: "a",
    params: { revision: "r1" },
    retention: { successRetention: "1 day", errorRetention: 0 },
    locationHint: "weur",
  });
  expectType<number | undefined>((await instance.status()).output);
  expectType<null>((await instance.status()).rollback);
  expectType<WorkflowInstance<number>>(await workflow.get(instance.id));
  expectType<WorkflowInstance<number>[]>(
    await workflow.createBatch([{ id: "b" }]),
  );
  await instance.sendEvent({ type: "ready", payload: { ok: true } });
  await instance.pause();
  await instance.resume();
  await instance.restart({ from: { name: "calculate", count: 1, type: "do" } });
  await instance.terminate();
  expectType<number>(await step.do("calculate", (ctx) => ctx.attempt));
  expectType<string>(
    await step.do("retry", {
      timeout: "2 minutes",
      retries: {
        limit: 2,
        backoff: "linear",
        delay: ({ ctx, error }) => {
          expectType<unknown>(error);
          expectType<WorkflowDuration | undefined>(ctx.config.retries.delay);
          return ctx.attempt * 1000;
        },
      },
    }, (ctx) => ctx.step.name),
  );
  await step.sleep("sleep", "1 second");
  await step.sleepUntil("deadline", new Date());
  const received = await step.waitForEvent<{ ok: boolean }>("ready", {
    type: "ready",
  });
  expectType<boolean>(received.payload.ok);
  expectType<Date>(received.timestamp);
  expectType<void>(await instance.delete());
  const deleted = await workflow.deleteBatch(["a", "b", "a"]);
  expectType<string>(deleted.deleted[0].id);
  expectType<10400 | 10001>(deleted.errors[0].code);
  expectType<WorkflowDeleteBatchResult>(deleted);
  // @ts-expect-error Retention is a policy object, not a single duration string.
  await workflow.create({ retention: "1 day" });
  // @ts-expect-error Unknown retention fields reject at runtime.
  await workflow.create({ retention: { success: "1 day" } });
  // @ts-expect-error Location hints are a closed set, not arbitrary region names.
  await workflow.create({ locationHint: "us-east-1" });
  // @ts-expect-error Sensitive output is explicitly rejected.
  await step.do("secret", { sensitive: "output" }, () => 1);
  // @ts-expect-error Workflow execution cannot perform rollbacks.
  await instance.terminate({ rollback: true });
}

/** Checks lazy loaded workers, structured-clone props, and isolated persistent facets. */
export async function checkDynamicWorkers(
  loader: WorkerLoader,
  outbound: Fetcher,
  state: DurableObjectState,
): Promise<void> {
  const code: WorkerLoaderCode = {
    mainModule: "main.js",
    modules: {
      "main.js": {
        js: "export default { fetch() { return new Response('ok'); } }",
      },
      "helper.js": "export const answer = 42;",
      "math.wasm": { wasm: new Uint8Array([0, 97, 115, 109]) },
    },
    env: {
      outbound,
      map: new Map([["a", new Date()]]),
      bytes: new Uint8Array(4),
    },
    globalOutbound: outbound,
    limits: { cpuMs: 100, subRequests: 20 },
    tails: [outbound],
  };
  const loaded = loader.get("shared", () => Promise.resolve(code));
  const entrypoint = loaded.getEntrypoint<
    { answer(input: number): number; label: string }
  >("Api", {
    props: { items: new Set(["a"]) },
    limits: { cpuMs: 10, subRequests: 2 },
  });
  expectType<number>(await entrypoint.answer(42));
  expectType<Response>(await entrypoint.fetch("https://example.invalid/"));
  // @ts-expect-error Loaded workers do not expose awaitable properties.
  await entrypoint.label;
  // @ts-expect-error RPC method arguments retain their public type.
  await entrypoint.answer("42");
  const class_ = loaded.getDurableObjectClass<{ increment(): number }>(
    "Counter",
    { props: { count: 1 } },
  );
  const facet = state.facets.get(
    "counter",
    () => ({ class: class_, id: state.id }),
  );
  expectType<number>(await facet.increment());
  expectType<void>(state.facets.abort("counter", new Error("reset")));
  expectType<void>(state.facets.delete("counter"));
  expectType<unknown>(state.props);
  expectType<string[]>(state.getTags(state.getWebSockets()[0]));
  loader.load({ ...code, globalOutbound: null }).dispose();
  loaded[Symbol.dispose]();
  loaded.getEntrypoint("Api", { limits: {} });
  // @ts-expect-error Tails are a WorkerCode option, not an entrypoint option.
  loaded.getEntrypoint("Api", { tails: [outbound] });
  // @ts-expect-error Facet class options do not support invocation limits.
  loaded.getDurableObjectClass("Counter", { limits: { cpuMs: 10 } });
  // @ts-expect-error Only props is a supported facet class option.
  loaded.getDurableObjectClass("Counter", { unsupported: true });
  // @ts-expect-error Facet classes must come from the loader, not arbitrary objects.
  state.facets.get("invalid", () => ({ class: {} }));
  // @ts-expect-error Facet cloning is unavailable.
  state.facets.clone("counter", "copy");
  // @ts-expect-error Modules are required; mainModule alone cannot load.
  loader.load({ mainModule: "main.js" });
  loader.load({
    mainModule: "main.js",
    // @ts-expect-error The old esModule wrapper does not reach the host's ES module parser.
    modules: { "main.js": { esModule: "export default {}" } },
  });
  loader.load({
    ...code,
    // @ts-expect-error Module wrappers must contain exactly one supported kind.
    modules: { "main.js": { js: "", wasm: new Uint8Array() } },
  });
  loader.load({
    ...code,
    // @ts-expect-error CJS wrappers are recognized but rejected by the host parser.
    modules: { "main.js": { cjs: "module.exports = {};" } },
  });
  // @ts-expect-error The host only recognizes cpuMs and subRequests limits.
  loader.load({ ...code, limits: { memoryMb: 128 } });
  // @ts-expect-error Resource budgets must be numeric.
  loader.load({ ...code, limits: { cpuMs: "10" } });
  // @ts-expect-error Tail destinations are Service Binding Fetchers, not names.
  loader.load({ ...code, tails: ["LOGGER"] });
  // @ts-expect-error allowExperimental remains unsupported in 0.5.1.
  loader.load({ ...code, allowExperimental: true });
}

/** Checks raw TCP/TLS and the optional event-scoped container capability. */
export async function checkContainersAndSockets(
  state: DurableObjectState,
  dial: typeof connect,
): Promise<void> {
  const socket = dial({ hostname: "example.invalid", port: 443 }, {
    secureTransport: "on",
  });
  expectType<ImportedSocket>(socket);
  expectType<string | undefined>((await socket.opened).remoteAddress);
  expectType<ReadableStream<Uint8Array>>(socket.readable);
  await socket.writable.getWriter().write(new Uint8Array([1]));
  await socket.close();
  expectType<void>(await socket.closed);
  const upgraded = dial("example.invalid:25", { secureTransport: "starttls" })
    .startTls({
      expectedServerHostname: "mail.example.invalid",
    });
  expectType<Socket>(upgraded);
  // @ts-expect-error A container exists only for classes explicitly configured with an image.
  state.container.start();
  const container = state.container;
  if (!container) return;
  expectType<boolean>(container.running);
  expectType<void>(
    container.start({
      entrypoint: ["/bin/sh"],
      env: { MODE: "test" },
      enableInternet: false,
    }),
  );
  expectType<void>(await container.monitor());
  expectType<string>(await container.setInactivityTimeout(10_000));
  const process = await container.exec(["/bin/echo", "hello"], {
    stderr: "combined",
    stdin: "pipe",
  });
  expectType<number>(process.pid);
  expectType<WritableStream<ArrayBuffer | ArrayBufferView> | null>(
    process.stdin,
  );
  expectType<number>(await process.exitCode);
  const output = await process.output();
  expectType<ArrayBuffer>(output.stdout);
  expectType<number>(output.exitCode);
  process.kill(15);
  const port = container.getTcpPort(8080);
  expectType<Response>(await port.fetch("http://container/health"));
  expectType<Socket>(port.connect());
  await container.destroy();
  // @ts-expect-error Numeric signals only, unlike a Node process handle.
  process.kill("SIGTERM");
  // @ts-expect-error Immediate TLS on container ports is rejected.
  port.connect("ignored:443", { secureTransport: "on" });
  // @ts-expect-error Container snapshots are placeholders that always reject.
  await container.snapshotContainer();
  // @ts-expect-error Container inspection is not implemented.
  await container.inspect();
  // @ts-expect-error TCP secureTransport is a closed set.
  dial("example.invalid:443", { secureTransport: "tls" });
}

/** Checks useful Worker extensions without inventing unavailable Cloudflare edge metadata. */
export async function checkWebExtensions(): Promise<void> {
  const request = new Request("https://example.invalid", {
    cf: { trace: "a" },
  });
  expectType<unknown>(request.cf?.colo);
  // @ts-expect-error celld cannot promise an edge colo string.
  expectType<string>(request.cf?.colo);
  const response = new Response("ok", { cf: { trace: "a" } });
  expectType<unknown>(response.cf?.trace);
  await caches.default.put(request, response);
  expectType<Response | undefined>(await caches.default.match(request));
}

/** Checks parser tokens against celld's implementation instead of DOM Element methods. */
export function checkHTMLRewriter(input: Response): Response {
  return new HTMLRewriter().on("a", {
    element(element) {
      expectType<IterableIterator<[string, string]>>(element.attributes);
      expectType<string | null>(element.getAttribute("href"));
      element.setAttribute("rel", "nofollow").append(new Response("extra"));
      element.tagName = "span";
      element.onEndTag((tag) => {
        expectType<string>(tag.name);
        tag.before("before end").after("after end");
        // @ts-expect-error End tag names are read-only in celld's current parser facade.
        tag.name = "div";
      });
      // @ts-expect-error Runtime tokens are not browser DOM nodes.
      element.querySelector("a");
    },
    text(text) {
      expectType<boolean>(text.lastInTextNode);
      text.replace("updated");
      // @ts-expect-error Text tokens expose read-only original text.
      text.text = "updated";
    },
    comments(comment) {
      comment.text = "comment";
      // @ts-expect-error Only element mutations consume stream/Response content.
      comment.before(new Response("text"));
    },
  }).onDocument({
    doctype(doctype) {
      expectType<string | null>(doctype.publicId);
    },
    end(end) {
      end.append("<!-- done -->", { html: true });
    },
  }).transform(input);
}
