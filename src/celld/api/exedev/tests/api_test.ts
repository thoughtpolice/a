// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  attachTag,
  attachVm,
  Checks,
  encodeSetupScript,
  ExeClient,
  ExeError,
  ExeInvalidRequestError,
  HttpsUrl,
  Month,
  Port,
  Region,
  Size,
  VmName,
  Word,
} from "@celld/api/exedev";
import { fakeFetch, jsonResponse } from "@celld/api/exedev/testing";

/** A client whose every call answers `answer`, and the lines it sent. */
function recorder(answer: unknown = { ok: true }) {
  const fetch = fakeFetch(() => jsonResponse(answer));
  const client = new ExeClient({ token: "exe1.t", fetch });
  return { client, lines: () => fetch.calls.map((call) => call.body) };
}

async function refusal(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExeInvalidRequestError) {
      return error.issues.map((issue) => issue.path.join("."));
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

Deno.test("share subcommands", async () => {
  const { client, lines } = recorder();
  await client.share.show("web-0");
  await client.share.port("web-0", 8080);
  await client.share.port("web-0");
  await client.share.setPublic("web-0");
  await client.share.setPrivate("web-0");
  await client.share.add("web-0", "a@example.com", {
    root: true,
    message: "Check this out",
  });
  await client.share.add("web-0", "team");
  await client.share.remove("web-0", "team", { root: true });
  await client.share.remove("web-0", "a@example.com");
  await client.share.addLink("web-0");
  await client.share.removeLink("web-0", "tok123");
  await client.share.receiveEmail("web-0", {
    enabled: true,
    replyPolicy: "known",
  });
  await client.share.receiveEmail("web-0");
  assertEquals(lines(), [
    "share show web-0",
    "share port web-0 8080",
    "share port web-0",
    "share set-public web-0",
    "share set-private web-0",
    "share add --root '--message=Check this out' web-0 a@example.com",
    "share add web-0 team",
    "share remove --root web-0 team",
    "share remove web-0 a@example.com",
    "share add-link web-0",
    "share remove-link web-0 tok123",
    "share receive-email --reply-policy=known web-0 on",
    "share receive-email web-0",
  ]);
  assertEquals(await refusal(client.share.add("web-0", "not-an-email")), [
    "target",
  ]);
  assertEquals(await refusal(client.share.port("web-0", 70000)), ["port"]);
  assertEquals(
    await refusal(
      client.share.receiveEmail("web-0", { replyPolicy: "some" as never }),
    ),
    ["replyPolicy"],
  );
});

Deno.test("reads among share commands are retried, changes are not", async () => {
  let calls = 0;
  const fetch = fakeFetch(
    () => (++calls % 2 === 1
      ? jsonResponse({}, { status: 503 })
      : jsonResponse({})),
  );
  const client = new ExeClient({
    token: "exe1.t",
    fetch,
    retry: { backoffInitialMs: 0 },
  });
  await client.share.port("web-0");
  assertEquals(fetch.calls.length, 2);
  await client.share.receiveEmail("web-0");
  assertEquals(fetch.calls.length, 4);
  try {
    await client.share.port("web-0", 80);
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeError, String(error));
  }
  assertEquals(fetch.calls.length, 5);
});

Deno.test("ssh-key subcommands", async () => {
  const { client, lines } = recorder({ ssh_keys: [] });
  await client.sshKey.list();
  await client.sshKey.add("ssh-ed25519 AAAAC3Nz my laptop", { tag: "prod" });
  await client.sshKey.remove("SHA256:abc");
  await client.sshKey.rename("old", "new");
  assertEquals(lines(), [
    "ssh-key list",
    "ssh-key add --tag=prod 'ssh-ed25519 AAAAC3Nz my laptop'",
    "ssh-key remove SHA256:abc",
    "ssh-key rename old new",
  ]);
  assertEquals(await refusal(client.sshKey.add("not a key")), ["publicKey"]);
  assertEquals(await refusal(client.sshKey.remove("  ")), ["key"]);
});

Deno.test("integrations add: every documented type", async () => {
  const { client, lines } = recorder();
  await client.integrations.add({
    type: "http-proxy",
    name: "myapi",
    target: "https://api.example.com",
    bearer: "sk-1",
    headers: ["X-A:b"],
    stripPrefix: "/api/v3",
    attach: [attachTag("prod"), "auto:all"],
    for: "2h",
    comment: "the api",
  });
  await client.integrations.add({
    type: "http-proxy",
    name: "talk-to-bob",
    target: "https://bob.exe.xyz/",
    peer: true,
    attach: [attachVm("alice")],
  });
  await client.integrations.add({
    type: "github",
    name: "blog",
    repository: "ghuser/blog",
    readonly: true,
    actAsUser: true,
  });
  await client.integrations.add({
    type: "llm",
    name: "keys",
    openai: "byok",
    openaiKey: "sk-o",
    anthropic: "disabled",
    fireworks: "disabled",
  });
  await client.integrations.add({
    type: "llm",
    name: "chat",
    openai: "chatgpt",
    openaiAccount: "work",
  });
  await client.integrations.add({
    type: "llm",
    name: "custom",
    customProviders: ["acme=https://api.acme.example/v1"],
    customProviderApis: ["openai_responses"],
    bearer: "t",
  });
  await client.integrations.add({
    type: "slack",
    name: "hook",
    webhookUrl: "https://hooks.slack.com/services/T/B/X",
  });
  await client.integrations.add({
    type: "slack",
    name: "bot",
    botToken: "xoxb-1",
    appToken: "xapp-1",
  });
  await client.integrations.add({
    type: "discord",
    name: "dbot",
    botToken: "d1",
  });
  await client.integrations.add({
    type: "s3",
    name: "objects",
    endpoint: "https://t3.storage.dev",
    region: "auto",
    bucket: "b",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    attach: ["auto:all"],
  });
  await client.integrations.add({
    type: "reflection",
    name: "reflection",
    fields: "all",
    attach: ["auto:all"],
  });
  await client.integrations.add({
    type: "reflection",
    name: "r2",
    fields: ["email", "tags"],
  });
  await client.integrations.add({
    type: "wif",
    name: "gcpwif",
    audience:
      "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x",
    consumer: "gcp",
    metadata: { project_id: "p", pool_id: "pool" },
    attach: ["vm:example-vm"],
  });
  await client.integrations.add({
    type: "stripe",
    catalog: true,
    name: "pay",
    extraFlags: { "--base-url": "https://api.stripe.com" },
  });
  await client.integrations.add({
    type: "db:neon",
    catalog: true,
    name: "db",
    team: true,
  });
  assertEquals(lines(), [
    "integrations add --name=myapi --attach=tag:prod --attach=auto:all --for=2h '--comment=the api' --target=https://api.example.com --header=X-A:b --bearer=sk-1 --strip-prefix=/api/v3 http-proxy",
    "integrations add --name=talk-to-bob --attach=vm:alice --target=https://bob.exe.xyz/ --peer http-proxy",
    "integrations add --name=blog --repository=ghuser/blog --readonly --act-as-user github",
    "integrations add --name=keys --openai=byok --openai-key=sk-o --anthropic=disabled --fireworks=disabled llm",
    "integrations add --name=chat --openai=chatgpt --openai-account=work llm",
    "integrations add --name=custom --custom-provider=acme=https://api.acme.example/v1 --custom-provider-api=openai_responses --bearer=t llm",
    "integrations add --name=hook --webhook-url=https://hooks.slack.com/services/T/B/X slack",
    "integrations add --name=bot --bot-token=xoxb-1 --app-token=xapp-1 slack",
    "integrations add --name=dbot --bot-token=d1 discord",
    "integrations add --name=objects --attach=auto:all --endpoint=https://t3.storage.dev --region=auto --bucket=b --access-key-id=AK --secret-access-key=SK s3",
    "integrations add --name=reflection --attach=auto:all --fields=all reflection",
    "integrations add --name=r2 --fields=email,tags reflection",
    "integrations add --name=gcpwif --attach=vm:example-vm --audience=https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x --consumer=gcp --metadata=project_id=p --metadata=pool_id=pool wif",
    "integrations add --name=pay --base-url=https://api.stripe.com stripe",
    "integrations add --name=db --team db:neon",
  ]);
});

Deno.test("integrations add refuses what the docs rule out", async () => {
  const { client, lines } = recorder();
  const cases: [Promise<unknown>, string[]][] = [
    [
      client.integrations.add({
        type: "http-proxy",
        name: "x",
        target: "ftp://x",
        noAuth: true,
        peer: true,
      }),
      ["target", "noAuth"],
    ],
    [
      client.integrations.add({
        type: "http-proxy",
        name: "x",
        target: "https://x",
        stripPrefix: "api/v3",
      }),
      ["stripPrefix"],
    ],
    [
      client.integrations.add({
        type: "github",
        name: "x",
        repository: "no-slash",
        team: true,
        actAsUser: true,
      }),
      ["repository", "actAsUser"],
    ],
    [
      client.integrations.add({
        type: "llm",
        name: "x",
        openai: "chatgpt",
        team: true,
      }),
      ["openai", "openaiAccount"],
    ],
    [client.integrations.add({ type: "llm", name: "x", anthropic: "byok" }), [
      "anthropicKey",
    ]],
    [client.integrations.add({ type: "slack", name: "x" }), ["webhookUrl"]],
    [
      client.integrations.add({
        type: "discord",
        name: "x",
        webhookUrl: "https://d",
        botToken: "t",
      }),
      ["webhookUrl"],
    ],
    [
      client.integrations.add({
        type: "http-proxy",
        name: "has space",
        target: "https://x",
        attach: ["vm:Bad" as never, "everything" as never],
        for: "later",
      }),
      ["name", "attach.0", "attach.1", "for"],
    ],
    [client.integrations.add({ type: "Bad Type", catalog: true, name: "x" }), [
      "type",
    ]],
    [
      client.integrations.add({
        type: "http-proxy",
        name: "x",
        target: "https://x",
        bearer: "-",
      }),
      ["flags.--bearer"],
    ],
  ];
  for (const [promise, paths] of cases) {
    assertEquals(await refusal(promise), paths);
  }
  assertEquals(lines(), []);
});

Deno.test("integrations: list, remove, test, edit, attach, detach, rename, catalog, setup", async () => {
  const { client, lines } = recorder([{
    name: "llm",
    type: "llm",
    config: {},
  }]);
  const list = await client.integrations.list({ usage: true });
  assertEquals(list.map((item) => item.name), ["llm"]);
  await client.integrations.remove("x", { team: true });
  await client.integrations.test("x");
  await client.integrations.edit("x", {
    target: "https://y",
    headers: ["A:b"],
    stripPrefix: "",
    comment: "c",
    fields: "none",
  });
  await client.integrations.edit("x", {
    webhookUrl: "https://hooks.slack.com/x",
    readonly: true,
    extraFlags: { "--anthropic": "byok" },
  });
  await client.integrations.attach("gmail", "vm:dev1", { for: "2h" });
  await client.integrations.attach("shared", "tag:production", {
    team: true,
    until: Temporal.Instant.from("2026-08-03T20:00:00Z"),
  });
  await client.integrations.attach("shared", "tag:staging", {
    team: true,
    until: "2026-08-03T22:00:00.5+02:00",
  });
  await client.integrations.detach("blog", "vm:my-vm");
  await client.integrations.rename("a", "b");
  await client.integrations.catalog("stripe");
  await client.integrations.catalog();
  await client.integrations.setupGithub("verify");
  await client.integrations.setupChatgpt("connect", "work");
  await client.integrations.setupChatgpt("delete", "work");
  await client.integrations.setupWebhook("slack");
  assertEquals(lines(), [
    "integrations list --usage",
    "integrations remove --team x",
    "integrations test x",
    "integrations edit --target=https://y --header=A:b --strip-prefix= --comment=c --fields=none x",
    "integrations edit --readonly --webhook-url=https://hooks.slack.com/x --anthropic=byok x",
    "integrations attach --for=2h gmail vm:dev1",
    "integrations attach --team --until=2026-08-03T20:00:00Z shared tag:production",
    "integrations attach --team --until=2026-08-03T20:00:00.5Z shared tag:staging",
    "integrations detach blog vm:my-vm",
    "integrations rename a b",
    "integrations catalog stripe",
    "integrations catalog",
    "integrations setup github --verify",
    "integrations setup chatgpt --name=work",
    "integrations setup chatgpt --name=work --delete",
    "integrations setup slack",
  ]);
  assertEquals(
    await refusal(client.integrations.attach("x", "vm:a", { team: true })),
    ["spec"],
  );
  assertEquals(
    await refusal(
      client.integrations.attach("x", "tag:a", {
        for: "1h",
        until: "2026-01-01T00:00:00Z",
      }),
    ),
    ["for"],
  );
  assertEquals(
    await refusal(
      client.integrations.attach("x", "tag:a", { until: "whenever" }),
    ),
    ["until"],
  );
  assertEquals(
    await refusal(
      client.integrations.attach("x", "tag:a", { until: "2026-08-03 20:00Z" }),
    ),
    ["until"],
  );
  assertEquals(
    await refusal(client.integrations.edit("x", { stripPrefix: "nope" })),
    ["stripPrefix"],
  );
  assertEquals(
    await refusal(client.integrations.setupGithub("wipe" as never)),
    ["action"],
  );
});

Deno.test("domain subcommands", async () => {
  const { client, lines } = recorder([]);
  await client.domain.add("temp-vm", "temp.example.com", { wildcard: true });
  await client.domain.rm("my-vm", "app.example.com");
  await client.domain.ls("my-vm");
  await client.domain.ls();
  assertEquals(lines(), [
    "domain add --wildcard temp-vm temp.example.com",
    "domain rm my-vm app.example.com",
    "domain ls my-vm",
    "domain ls -a",
  ]);
  assertEquals(await refusal(client.domain.add("vm", "not a domain")), [
    "domain",
  ]);
});

Deno.test("team subcommands", async () => {
  const { client, lines } = recorder();
  await client.team.show();
  await client.team.members();
  await client.team.usage();
  await client.team.add("alice@example.com", "admin");
  await client.team.add("bob@example.com");
  await client.team.remove("alice@example.com", {
    transferVmsTo: "bob@example.com",
  });
  await client.team.role("bob@example.com", "billing_owner");
  await client.team.rename("Acme Corp");
  await client.team.transfer("mybox", "alice@example.com");
  await client.team.disable();
  await client.team.billing.show();
  await client.team.billing.plan({ all: true });
  await client.team.billing.update({
    businessName: "Acme",
    taxIdType: "eu_vat",
    taxIdValue: "X1",
  });
  await client.team.auth.show();
  await client.team.auth.requireOidc("web");
  await client.team.auth.set("oidc", {
    issuerUrl: "https://acme.okta.com",
    clientId: "id",
    clientSecret: "s3cret",
    displayName: "Acme SSO",
  });
  await client.team.auth.set("google");
  await client.team.settings.show();
  await client.team.settings.vmPlacement();
  await client.team.settings.vmPlacementDefault();
  await client.team.settings.vmPlacementPool("shared");
  await client.team.settings.vmPlacementMemberPool({
    cpus: 8,
    maxVms: 10,
    host: "h1",
  });
  await client.team.settings.vmPlacementPoolless();
  await client.team.settings.standalone("admins-only");
  await client.team.settings.llmGateway(false);
  await client.team.settings.vmSharing("all-members");
  await client.team.settings.autoJoin(true);
  await client.team.vm.show();
  await client.team.vm.ls({ long: true, group: "user", pattern: "web-*" });
  assertEquals(lines(), [
    "team",
    "team members",
    "team usage",
    "team add alice@example.com admin",
    "team add bob@example.com",
    "team remove --transfer-vms-to=bob@example.com alice@example.com",
    "team role bob@example.com billing_owner",
    "team rename 'Acme Corp'",
    "team transfer mybox alice@example.com",
    "team disable --yes",
    "team billing",
    "team billing plan --all",
    "team billing update --business-name=Acme --tax-id-type=eu_vat --tax-id-value=X1",
    "team auth",
    "team auth require-oidc web",
    "team auth set --issuer-url=https://acme.okta.com --client-id=id --client-secret=s3cret '--display-name=Acme SSO' oidc",
    "team auth set google",
    "team settings",
    "team settings vm-placement",
    "team settings vm-placement default",
    "team settings vm-placement pool shared",
    "team settings vm-placement member-pool --cpus=8 --max-vms=10 --host=h1",
    "team settings vm-placement poolless",
    "team settings standalone admins-only",
    "team settings llm-gateway off",
    "team settings vm-sharing all-members",
    "team settings auto-join on",
    "team vm",
    "team vm ls -l --group=user 'web-*'",
  ]);
  const cases: [Promise<unknown>, string[]][] = [
    [client.team.add("x"), ["email"]],
    [client.team.add("a@b.c", "owner" as never), ["role"]],
    [client.team.remove("a@b.c", { transferVmsTo: "a@b.c" }), [
      "transferVmsTo",
    ]],
    [client.team.billing.update({}), [""]],
    [client.team.auth.set("oidc"), ["oidc"]],
    [
      client.team.auth.set("google", {
        issuerUrl: "https://x",
        clientId: "a",
        clientSecret: "b",
      }),
      ["oidc"],
    ],
    [client.team.settings.vmPlacementMemberPool({ cpus: 5 }), ["cpus"]],
    [client.team.settings.standalone("maybe" as never), ["value"]],
    [client.team.vm.ls({ group: "owner" as never }), ["group"]],
  ];
  for (const [promise, paths] of cases) {
    assertEquals(await refusal(promise), paths);
  }
});

Deno.test("an OIDC client secret is redacted from errors", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ error: "bad issuer" }, { status: 422 })
  );
  const client = new ExeClient({ token: "exe1.t", fetch });
  try {
    await client.team.auth.set("oidc", {
      issuerUrl: "https://x",
      clientId: "id",
      clientSecret: "s3cret",
    });
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeError, String(error));
    assert(
      !error.message.includes("s3cret") &&
        error.command!.includes("--client-secret=***"),
      error.message,
    );
  }
});

Deno.test("pool subcommands", async () => {
  const { client, lines } = recorder();
  await client.pool.new("compile", { cpus: 16, region: "lax", maxVms: 20 });
  await client.pool.new("dedicated", { cpus: 64, host: "h1" });
  await client.pool.hosts();
  await client.pool.list({ name: "compile", usage: true, range: "7d" });
  await client.pool.list();
  await client.pool.adopt("builder", "compile");
  await client.pool.detach("builder");
  await client.pool.resize("compile", { cpus: 32 });
  await client.pool.resize("compile", { maxVms: 5, force: true });
  await client.pool.delete("compile", { force: true });
  assertEquals(lines(), [
    "pool new --cpus=16 --region=lax --max-vms=20 compile",
    "pool new --cpus=64 --host=h1 dedicated",
    "pool hosts",
    "pool list --usage --range=7d compile",
    "pool list",
    "pool adopt --vm=builder --pool=compile",
    "pool detach --vm=builder",
    "pool resize --cpus=32 compile",
    "pool resize --max-vms=5 --force compile",
    "pool delete --force compile",
  ]);
  assertEquals(
    await refusal(client.pool.new("p", { cpus: 3, region: "lax", host: "h" })),
    ["cpus", "cpus", "region"],
  );
  assertEquals(await refusal(client.pool.new("p", { cpus: 514 })), [
    "cpus",
    "region",
  ]);
  assertEquals(await refusal(client.pool.list({ range: "7d" })), ["range"]);
});

Deno.test("billing subcommands", async () => {
  const { client, lines } = recorder();
  await client.billing.show();
  await client.billing.plan({ all: true });
  await client.billing.usage({ range: "7d", group: "vm" });
  await client.billing.credits.show();
  await client.billing.credits.usage({
    month: "2026-05",
    group: "box",
    detail: true,
  });
  await client.billing.credits.transactions({ limit: 50 });
  await client.billing.credits.buy(25, { idempotencyKey: "order-1" });
  await client.billing.rewards();
  await client.billing.capacity(4);
  await client.billing.capacity();
  await client.billing.payment.show();
  await client.billing.payment.list();
  await client.billing.payment.remove("4f1c2a9b8d3e");
  await client.billing.payment.setDefault("4f1c2a9b8d3e");
  await client.billing.manage();
  await client.billing.update({
    email: "billing@example.com",
    addressCountry: "US",
  });
  await client.billing.invoices();
  await client.billing.receipts({ from: "2026-01-01", to: "2026-06-30" });
  await client.billing.statement({ from: "2026-01-01" });
  await client.billing.providerLink("azure", {
    token: "mpl_x",
    size: "large",
    teamName: "Acme Engineering",
  });
  assertEquals(lines(), [
    "billing",
    "billing plan --all",
    "billing usage --range=7d --group=vm",
    "billing credits",
    "billing credits usage --month=2026-05 --group=box --detail",
    "billing credits transactions --limit=50",
    "billing credits buy --yes --idempotency-key=order-1 25",
    "billing rewards",
    "billing capacity --cpu=4 --yes",
    "billing capacity",
    "billing payment",
    "billing payment list",
    "billing payment remove 4f1c2a9b8d3e",
    "billing payment default 4f1c2a9b8d3e",
    "billing manage",
    "billing update --email=billing@example.com --address-country=US",
    "billing invoices",
    "billing receipts --from=2026-01-01 --to=2026-06-30",
    "billing statement --from=2026-01-01",
    "billing provider link --token=mpl_x --size=large '--team-name=Acme Engineering' azure",
  ]);
  const cases: [Promise<unknown>, string[]][] = [
    [client.billing.credits.usage({ month: "2026-13" }), ["month"]],
    [client.billing.credits.transactions({ limit: 101 }), ["limit"]],
    [client.billing.credits.buy(0), ["dollars"]],
    [client.billing.capacity(3 as never), ["cpu"]],
    [client.billing.receipts({ from: "2026-06-30", to: "2026-01-01" }), ["to"]],
    [client.billing.receipts({ from: "yesterday" }), ["from"]],
    [client.billing.receipts({ from: "2026-02-30" }), ["from"]],
    [client.billing.usage({ range: "1y" as never }), ["range"]],
  ];
  for (const [promise, paths] of cases) {
    assertEquals(await refusal(promise), paths);
  }
});

Deno.test("a credit purchase is retried only with an idempotency key", async () => {
  const flaky = () => {
    let calls = 0;
    return fakeFetch(
      () => (++calls === 1
        ? jsonResponse({}, { status: 503 })
        : jsonResponse({})),
    );
  };
  const keyed = flaky();
  await new ExeClient({
    token: "exe1.t",
    fetch: keyed,
    retry: { backoffInitialMs: 0 },
  }).billing.credits.buy(5, { idempotencyKey: "k" });
  assertEquals(keyed.calls.length, 2);
  const bare = flaky();
  try {
    await new ExeClient({ token: "exe1.t", fetch: bare }).billing.credits.buy(
      5,
    );
  } catch {
    // Expected: sent once, failed.
  }
  assertEquals(bare.calls.length, 1);
});

Deno.test("invite, shelley and defaults subcommands", async () => {
  const { client, lines } = recorder();
  await client.invite.show();
  await client.invite.link();
  await client.invite.rewards();
  await client.invite.setReward("extra-disk");
  await client.invite.activity();
  await client.invite.request();
  await client.invite.manage();
  await client.shelley.install("web-0");
  await client.shelley.prompt("web-0", "build me a web app", {
    model: "claude-opus",
    reasoning: "high",
  });
  await client.defaults.read();
  await client.defaults.write(
    "new.setup-script",
    "#!/bin/bash\ntouch /tmp/fine\n",
  );
  await client.defaults.delete();
  assertEquals(lines(), [
    "invite show",
    "invite link",
    "invite rewards",
    "invite set-reward extra-disk",
    "invite activity",
    "invite request",
    "invite manage",
    "shelley install web-0",
    "shelley prompt --model=claude-opus --reasoning=high web-0 'build me a web app'",
    "defaults read dev.exe new.setup-script",
    "defaults write dev.exe new.setup-script '#!/bin/bash\\ntouch /tmp/fine\\n'",
    "defaults delete dev.exe new.setup-script",
  ]);
  assertEquals(await refusal(client.invite.setReward("gold" as never)), [
    "reward",
  ]);
  assertEquals(
    await refusal(
      client.shelley.prompt("web-0", " ", { reasoning: "extreme" as never }),
    ),
    ["prompt", "reasoning"],
  );
  assertEquals(await refusal(client.defaults.read("Bad Key")), ["key"]);
});

Deno.test("setup scripts encode newlines as \\n and refuse ambiguity", async () => {
  assertEquals(encodeSetupScript("one line"), "one line");
  assertEquals(encodeSetupScript("a\r\nb\n"), "a\\nb\\n");
  assertEquals(
    await refusal(Promise.resolve().then(() => encodeSetupScript("a\\nb\nc"))),
    ["setupScript"],
  );
  assertEquals(
    await refusal(Promise.resolve().then(() => encodeSetupScript("a\rb\n"))),
    ["setupScript"],
  );
});

Deno.test("the sieve value types, and Checks.schema locating their issues", () => {
  const accepts: [
    { safeParse(value: unknown): { success: boolean } },
    unknown[],
    unknown[],
  ][] = [
    [VmName, ["web-0", "a"], ["-web", "Web", "a".repeat(64), 3]],
    [Word, ["prod", "a-b"], ["-x", "a b", "a,b", ""]],
    [Size, [8, "8G", "16GiB", "512M"], [0, -1, "big", "8 G"]],
    [Month, ["2026-09"], ["2026-13", "2026-9"]],
    [Port, [1, 8080, 65535], [0, 65536, 1.5, "80"]],
    [Region, ["lax", "fra"], ["LAX", "london"]],
    [HttpsUrl, ["https://a.example/x"], ["http://a.example", "a.example"]],
  ];
  for (const [schema, good, bad] of accepts) {
    for (const value of good) {
      assert(schema.safeParse(value).success, `accepts ${String(value)}`);
    }
    for (const value of bad) {
      assert(!schema.safeParse(value).success, `refuses ${String(value)}`);
    }
  }
  const checks = new Checks();
  assertEquals(checks.schema(Port, ["share", "port"], 8080), 8080);
  assertEquals(checks.schema(VmName, ["vms", 1], "Nope"), undefined);
  checks.schema(Month, ["month"], "2026-13", "custom message");
  assertEquals(checks.issues, [
    {
      path: ["vms", 1],
      message:
        "must be a VM name: 1-63 lowercase letters, digits and hyphens, not starting or ending with a hyphen",
    },
    { path: ["month"], message: "custom message" },
  ]);
  try {
    checks.done();
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeInvalidRequestError, String(error));
  }
});
