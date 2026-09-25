// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { ExeError } from "@celld/api/exedev";
import {
  fakeFetch,
  jsonResponse,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/exedev/testing";
import {
  deliveredTo,
  gcpProviderResource,
  parseEmailHeaders,
  ReflectionClient,
  ReflectionIndex,
  VmIntegrations,
} from "@celld/api/exedev/vm";

/** Routes requests by URL to handlers, recording them. */
function routes(table: Record<string, (call: RecordedRequest) => Response>) {
  return fakeFetch((call) => {
    const handler = table[call.url] ?? table[`${call.method} ${call.url}`];
    if (handler === undefined) {
      return jsonResponse({ error: `no route ${call.method} ${call.url}` }, {
        status: 404,
      });
    }
    return handler(call);
  });
}

async function failure(promise: Promise<unknown>): Promise<ExeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExeError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

const INDEX = {
  name: "my-vm",
  emoji: "🚀",
  paths: [
    { description: "owner email address", path: "/email" },
    { description: "integrations available to this VM", path: "/integrations" },
  ],
};

const INTEGRATIONS = {
  integrations: [
    {
      comment: "",
      help: "curl https://reflection.int.exe.xyz/",
      name: "reflection",
      type: "reflection",
    },
    {
      comment: "",
      help: "curl https://llm.int.exe.xyz/v1/models",
      name: "llm",
      type: "llm",
    },
    {
      comment: "backend repo",
      help: "git clone https://github.int.exe.xyz/org/repo.git",
      name: "github-example",
      type: "github",
    },
  ],
};

Deno.test("reflection: the documented index and integrations", async () => {
  const fetch = routes({
    "https://reflection.int.exe.xyz/": () => jsonResponse(INDEX),
    "https://reflection.int.exe.xyz/integrations": () =>
      jsonResponse(INTEGRATIONS),
  });
  const reflection = new ReflectionClient({ fetch });
  const index = await reflection.index();
  assertEquals(
    [index.name, index.emoji, index.paths.map((path) => path.path)],
    ["my-vm", "🚀", ["/email", "/integrations"]],
  );
  const list = await reflection.integrations();
  assertEquals(list.map((item) => [item.name, item.type]), [
    ["reflection", "reflection"],
    ["llm", "llm"],
    ["github-example", "github"],
  ]);
  assertEquals(
    (await reflection.findIntegration({ type: "github" }))?.comment,
    "backend repo",
  );
  assertEquals(
    await reflection.findIntegration({ type: "llm", name: "other" }),
    null,
  );
});

Deno.test("reflection: undocumented fields accept JSON objects, bare values or text", async () => {
  const shapes: Record<string, [unknown, unknown][]> = {
    email: [[{ email: "a@b.c" }, "a@b.c"], ["a@b.c", "a@b.c"], [
      "text:a@b.c\n",
      "a@b.c",
    ]],
    tags: [[{ tags: ["x", "y"] }, ["x", "y"]], [["x"], ["x"]], [
      "text:x, y\nz",
      ["x", "y", "z"],
    ]],
    comment: [[{ comment: "hi" }, "hi"], [{ comment: null }, ""], [
      "text:hello there",
      "hello there",
    ]],
    default_port: [[{ default_port: 8000 }, 8000], [3000, 3000], [
      "text:8080",
      8080,
    ], [{ default_port: null }, null]],
  };
  for (const [field, cases] of Object.entries(shapes)) {
    for (const [body, expected] of cases) {
      const fetch = fakeFetch(() =>
        typeof body === "string" && body.startsWith("text:")
          ? new Response(body.slice(5))
          : jsonResponse(body)
      );
      const reflection = new ReflectionClient({
        fetch,
        reflectionUrl: "https://refl.test",
      });
      const read = {
        email: () => reflection.email(),
        tags: () => reflection.tags(),
        comment: () => reflection.comment(),
        default_port: () => reflection.defaultPort(),
      }[field]!;
      assertEquals(await read(), expected, `${field} ${JSON.stringify(body)}`);
      assertEquals(fetch.calls[0].url, `https://refl.test/${field}`);
    }
  }
  const bad = fakeFetch(() => jsonResponse({ default_port: 99999 }));
  assertEquals(
    (await failure(new ReflectionClient({ fetch: bad }).defaultPort())).kind,
    "decode",
  );
  const hidden = fakeFetch(() =>
    jsonResponse({ error: "field not exposed" }, { status: 403 })
  );
  assertEquals(
    (await failure(new ReflectionClient({ fetch: hidden }).email())).kind,
    "permission",
  );
});

Deno.test("reflection reads are retried on 5xx", async () => {
  let calls = 0;
  const fetch = fakeFetch(
    () => (++calls === 1
      ? jsonResponse({}, { status: 502 })
      : jsonResponse(INDEX)),
  );
  const reflection = new ReflectionClient({ fetch, runtime: virtualRuntime() });
  assertEquals((await reflection.index()).name, "my-vm");
  assertEquals(fetch.calls.length, 2);
});

Deno.test("integration origins and URLs", () => {
  const vm = new VmIntegrations();
  assertEquals(vm.origin("llm"), "https://llm.int.exe.xyz");
  assertEquals(
    vm.origin("shared", { team: true }),
    "https://shared.team.exe.xyz",
  );
  assertEquals(
    vm.url("mirror", "/anything"),
    "https://mirror.int.exe.xyz/anything",
  );
  assertEquals(
    new VmIntegrations({ scheme: "http", domain: "int.test" }).origin("x"),
    "http://x.int.test",
  );
  for (
    const build of [() => vm.origin("bad name"), () => vm.url("x", "no-slash")]
  ) {
    try {
      build();
      throw new Error("accepted");
    } catch (error) {
      assert(
        error instanceof ExeError && error.kind === "invalid_request",
        String(error),
      );
    }
  }
});

Deno.test("LLM helpers call the documented endpoints", async () => {
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const vm = new VmIntegrations({ fetch });
  await vm.llmModels();
  await vm.llmResponses({ model: "gpt-5.5", input: "hi" });
  await vm.llmMessages(
    { model: "claude-sonnet-4-6", max_tokens: 256, messages: [] },
    "team-llm",
    { team: true },
  );
  await vm.llmChatCompletions({ model: "m", messages: [] }, "custom");
  assertEquals(fetch.calls.map((call) => `${call.method} ${call.url}`), [
    "GET https://llm.int.exe.xyz/v1/models",
    "POST https://llm.int.exe.xyz/v1/responses",
    "POST https://team-llm.team.exe.xyz/v1/messages",
    "POST https://custom.int.exe.xyz/v1/chat/completions",
  ]);
  assertEquals(fetch.calls[2].headers.get("anthropic-version"), "2023-06-01");
  assertEquals(JSON.parse(fetch.calls[1].body!), {
    model: "gpt-5.5",
    input: "hi",
  });
  assertEquals(
    vm.llmProviderBase("fireworks"),
    "https://llm.int.exe.xyz/fireworks/inference/v1",
  );
  assertEquals(
    vm.llmProviderBase("openai", "chatgpt-llm"),
    "https://chatgpt-llm.int.exe.xyz/openai/v1",
  );
});

Deno.test("GitHub, Slack and Discord helpers", async () => {
  const fetch = fakeFetch((call) => {
    if (call.url.endsWith("/api/apps.connections.open")) {
      return jsonResponse({
        ok: true,
        url: "wss://wss.slack.test/link/?ticket=1",
      });
    }
    if (call.url.includes("discord-hook")) {
      return call.url.includes("wait=true")
        ? new Response('{"id":"1"}')
        : new Response(null, { status: 204 });
    }
    if (call.url.includes("slack-hook")) return new Response("ok");
    return jsonResponse({ ok: true });
  });
  const vm = new VmIntegrations({ fetch });
  assertEquals(
    vm.githubCloneUrl("ghuser/blog"),
    "https://github.int.exe.xyz/ghuser/blog.git",
  );
  assertEquals(vm.githubHost(), "github.int.exe.xyz");
  assertEquals(
    await vm.slackPost("slack-hook", { text: "build finished" }),
    "ok",
  );
  await vm.slackCall("mybot", "chat.postMessage", {
    channel: "C0123",
    text: "hi",
  });
  assertEquals(
    await vm.slackSocketUrl("mybot"),
    "wss://wss.slack.test/link/?ticket=1",
  );
  assertEquals(
    vm.slackFileUrl(
      "mybot",
      "https://files.slack.com/files-pri/T0123-F0456/report.txt?t=1",
    ),
    "https://mybot.int.exe.xyz/files-pri/T0123-F0456/report.txt?t=1",
  );
  assertEquals(await vm.discordPost("discord-hook", { content: "hi" }), null);
  assertEquals(
    await vm.discordPost("discord-hook", { content: "hi" }, {
      wait: true,
      threadId: "42",
    }),
    { id: "1" },
  );
  const bot = await vm.discordBot("dbot", "GET", "/api/v10/users/@me");
  assertEquals(bot.status, 200);
  assertEquals(
    fetch.calls.map((call) => `${call.method} ${call.url}`).slice(1),
    [
      "POST https://mybot.int.exe.xyz/api/chat.postMessage",
      "POST https://mybot.int.exe.xyz/api/apps.connections.open",
      "POST https://discord-hook.int.exe.xyz/",
      "POST https://discord-hook.int.exe.xyz/?wait=true&thread_id=42",
      "GET https://dbot.int.exe.xyz/api/v10/users/@me",
    ],
  );
  const bads: (() => unknown)[] = [
    () => vm.githubCloneUrl("nope"),
    () => vm.slackCall("mybot", "not a method"),
    () => vm.slackFileUrl("mybot", "https://files.slack.com/other/x"),
    () => vm.discordPost("d", { content: "x", username: "admin" }),
    () => vm.discordPost("d", { content: "x".repeat(300 * 1024) }),
    () => vm.discordBot("d", "GET", "/users/@me"),
  ];
  for (const bad of bads) {
    const error = await failure(Promise.resolve().then(bad));
    assertEquals(error.kind, "invalid_request");
  }
});

Deno.test("a missing Slack app token is Slack's error, not a URL", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ ok: false, error: "missing app token" })
  );
  const error = await failure(
    new VmIntegrations({ fetch }).slackSocketUrl("mybot"),
  );
  assert(error.message.includes("missing app token"), error.message);
});

Deno.test("token mint and registry token helpers", async () => {
  const fetch = fakeFetch((call) => {
    if (call.url.includes("/v2/auth") || call.url.includes("/auth/token")) {
      return jsonResponse({
        token: "reg",
        access_token: "reg",
        expires_in: 45,
      });
    }
    return jsonResponse({
      access_token: "ya29",
      expires_in: 3599,
      token_type: "Bearer",
      refresh_token_echo: "x",
    });
  });
  const vm = new VmIntegrations({ fetch });
  const google = await vm.mintToken("gsa", "googlesa");
  assertEquals([google.access_token, google.expires_in, google.token_type], [
    "ya29",
    3599,
    "Bearer",
  ]);
  await vm.mintToken("kc", VmIntegrations.keycloakTokenPath("my realm"));
  await vm.mintToken("tw", "twitch");
  await vm.mintToken("ads", "reddit-ads");
  const quay = await vm.registryToken("quay", "quay", [
    "repository:org/repo:pull",
    "repository:org/other:pull",
  ]);
  assertEquals([quay.token, quay.expires_in], ["reg", 45]);
  await vm.registryToken("atcr", "atcr", ["repository:me/img:pull"]);
  assertEquals(fetch.calls.map((call) => `${call.method} ${call.url}`), [
    "POST https://gsa.int.exe.xyz/token",
    "POST https://kc.int.exe.xyz/realms/my%20realm/protocol/openid-connect/token",
    "POST https://tw.int.exe.xyz/oauth2/token",
    "POST https://ads.int.exe.xyz/api/v1/access_token",
    "GET https://quay.int.exe.xyz/v2/auth?service=quay.io&scope=repository%3Aorg%2Frepo%3Apull&scope=repository%3Aorg%2Fother%3Apull",
    "GET https://atcr.int.exe.xyz/auth/token?service=atcr.io&scope=repository%3Ame%2Fimg%3Apull",
  ]);
  assertEquals(fetch.calls[0].body, undefined);
  assertEquals(VmIntegrations.dockerConfig("quay.io", "reg"), {
    auths: { "quay.io": { registrytoken: "reg" } },
  });
  const noToken = fakeFetch(() => jsonResponse({ nope: 1 }));
  assertEquals(
    (await failure(
      new VmIntegrations({ fetch: noToken }).mintToken("x", "googlesa"),
    )).kind,
    "decode",
  );
});

Deno.test("workload identity helpers for AWS and GCP", async () => {
  const fetch = fakeFetch((call) => {
    if (call.url.endsWith("/token")) return jsonResponse({ token: "oidc.jwt" });
    if (call.url.startsWith("https://awswif")) {
      return jsonResponse({ role_arn: "arn:aws:iam::1:role/r" });
    }
    return jsonResponse({
      project_id: "p",
      project_number: 123,
      pool_id: "pool",
      provider_id: "prov",
      service_account: "sa@p.iam.gserviceaccount.com",
    });
  });
  const vm = new VmIntegrations({ fetch });
  assertEquals(await vm.awsWebIdentity("awswif"), {
    roleArn: "arn:aws:iam::1:role/r",
    token: "oidc.jwt",
  });
  const metadata = await vm.gcpWifMetadata("gcpwif", { team: true });
  assertEquals([metadata.project_number, metadata.pool_id], ["123", "pool"]);
  assertEquals(
    gcpProviderResource(metadata),
    "projects/123/locations/global/workloadIdentityPools/pool/providers/prov",
  );
  const config = vm.gcpCredentialConfig("gcpwif", metadata, { team: true });
  assertEquals(
    config.audience,
    "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov",
  );
  assertEquals(config.credential_source, {
    url: "https://gcpwif.team.exe.xyz/token",
    format: { type: "json", subject_token_field_name: "token" },
  });
  const forbidden = fakeFetch(() =>
    jsonResponse({ error: "not attached" }, { status: 403 })
  );
  assertEquals(
    (await failure(new VmIntegrations({ fetch: forbidden }).wifToken("gcpwif")))
      .kind,
    "permission",
  );
});

Deno.test("object storage URLs encode keys segment by segment", () => {
  const vm = new VmIntegrations();
  assertEquals(
    vm.objectUrl("objects", "dir/a b.txt"),
    "https://objects.int.exe.xyz/dir/a%20b.txt",
  );
  try {
    vm.objectUrl("objects", "/abs");
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeError, String(error));
  }
});

Deno.test("sendEmail posts the documented body and reports refusals", async () => {
  const fetch = fakeFetch((call) => {
    const body = JSON.parse(call.body!);
    return body.to === "stranger@example.com"
      ? jsonResponse({ error: "recipient not allowed" }, { status: 403 })
      : jsonResponse({ success: true });
  });
  const vm = new VmIntegrations({ fetch });
  assertEquals(
    await vm.sendEmail({
      to: "odysseus@example.com",
      subject: "Report",
      body: "Latest numbers attached.",
      in_reply_to: "<id@x>",
      attachments: [{
        filename: "report.csv",
        content: new TextEncoder().encode("a,b\n"),
        content_type: "text/csv",
      }],
    }),
    { success: true },
  );
  assertEquals(fetch.calls[0].url, "http://169.254.169.254/gateway/email/send");
  assertEquals(JSON.parse(fetch.calls[0].body!), {
    to: "odysseus@example.com",
    subject: "Report",
    body: "Latest numbers attached.",
    in_reply_to: "<id@x>",
    attachments: [{
      filename: "report.csv",
      content: "YSxiCg==",
      content_type: "text/csv",
    }],
  });
  const refused = await failure(
    vm.sendEmail({ to: "stranger@example.com", subject: "s", body: "b" }),
  );
  assertEquals([refused.kind, refused.detail], [
    "permission",
    "recipient not allowed",
  ]);
  const missing = await failure(
    vm.sendEmail({ to: "", subject: " ", body: "b" }),
  );
  assertEquals(missing.issues.map((issue) => issue.path[0]), ["to", "subject"]);
  const soft = fakeFetch(() => jsonResponse({ error: "rate limited" }));
  assertEquals(
    (await failure(
      new VmIntegrations({ fetch: soft }).sendEmail({
        to: "a@b",
        subject: "s",
        body: "b",
      }),
    )).detail,
    "rate limited",
  );
});

Deno.test("received mail: Delivered-To and folded headers", () => {
  const raw =
    "Delivered-To: bot@my-vm.exe.xyz\r\nFrom: A <a@example.com>\r\nSubject: long\r\n  subject line\r\nTo: x@y\r\n\r\nbody: not a header\r\n";
  assertEquals(deliveredTo(raw), "bot@my-vm.exe.xyz");
  assertEquals(
    parseEmailHeaders(new TextEncoder().encode(raw)).map((header) =>
      header.name
    ),
    ["Delivered-To", "From", "Subject", "To"],
  );
  assertEquals(parseEmailHeaders(raw)[2].value, "long subject line");
  assertEquals(deliveredTo("From: a@b\n\nx"), null);
});

Deno.test("reflection: entries are located, and odd optional fields are skipped", async () => {
  const fetch = routes({
    "https://reflection.int.exe.xyz/": () =>
      jsonResponse({
        name: "my-vm",
        emoji: 7,
        paths: [{ path: "/email" }, { description: "no path" }, "junk"],
        future: true,
      }),
    "https://reflection.int.exe.xyz/integrations": () =>
      jsonResponse([{ name: "llm", type: "llm", help: 3 }, { name: "x" }]),
  });
  const reflection = new ReflectionClient({ fetch });
  const index = await reflection.index();
  assertEquals([index.name, index.emoji, index.paths, index.raw.future], [
    "my-vm",
    undefined,
    [{ path: "/email" }],
    true,
  ]);
  const error = await failure(reflection.integrations());
  assertEquals(
    [error.kind, error.issues],
    ["decode", [{
      path: [1, "type"],
      message: "missing required key",
    }]],
  );
  assertEquals(ReflectionIndex.safeParse({ emoji: "x" }).success, false);
});
