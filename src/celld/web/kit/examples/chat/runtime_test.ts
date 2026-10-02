// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Switchboard's native forms, guest identity and durable rooms under real celld. */
import { assert, assertEquals } from "@celld/core/assert";
import { DevServer } from "@celld/examples/dev-server";
import { RoomClient, RoomClientError } from "@celld/web/realtime/client";
import type { RoomStatus, WebSocketLike } from "@celld/web/realtime/client";
import {
  chatMessage,
  MAX_CHANNELS,
  PageSchema,
  roomMembers,
} from "@celld/web/switchboard/contracts";
import type {
  Channel,
  ChatMessage,
  Member,
  PageData,
  Viewer,
} from "@celld/web/switchboard/contracts";
import spec from "./switchboard.json" with { type: "json" };

// Deno supports request headers; browsers intentionally do not expose them.
interface HeaderWebSocketConstructor {
  new (
    url: string,
    options: { headers: Record<string, string> },
  ): WebSocketLike;
}
const HeaderWebSocket = WebSocket as unknown as HeaderWebSocketConstructor;

async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${what} (${ms}ms)`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function bounded<T>(
  what: string,
  pending: Promise<T>,
  ms = 10_000,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${what} (${ms}ms)`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Preserve the real server's cookie values, including rotation and deletion. */
class CookieJar {
  readonly cookies = new Map<string, string>();

  receive(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const parts = cookie.split(";");
      const pair = parts[0];
      const equals = pair.indexOf("=");
      assert(equals > 0, `Invalid Set-Cookie: ${cookie}`);
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1);
      const expired = parts.slice(1).some((part) => {
        const attribute = part.trim();
        if (/^max-age=0$/i.test(attribute)) return true;
        if (/^expires=/i.test(attribute)) {
          return Date.parse(attribute.slice(8)) <= Date.now();
        }
        return false;
      });
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join(
      "; ",
    );
  }

  copy(): CookieJar {
    const jar = new CookieJar();
    for (const [name, value] of this.cookies) jar.cookies.set(name, value);
    return jar;
  }
}

class Guest {
  readonly jar = new CookieJar();
  csrf = "";
  viewer: Viewer | null = null;

  constructor(
    readonly server: DevServer,
    readonly publicOrigin = server.origin,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.header) headers.set("cookie", this.jar.header);
    const response = await fetch(`${this.server.origin}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.jar.receive(response);
    return response;
  }

  async snapshot(channel = "lobby"): Promise<PageData> {
    const response = await this.request(`/channels/${channel}`, {
      headers: { accept: "application/json" },
    });
    assertEquals(response.status, 200);
    const page = PageSchema.parse(await response.json());
    this.csrf = page.csrf;
    this.viewer = page.viewer;
    return page;
  }

  form(
    path: string,
    fields: Record<string, string>,
    accept = "text/html",
  ): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { accept, origin: this.publicOrigin },
      body: new URLSearchParams(fields),
    });
  }

  async join(nickname: string, channel = "lobby"): Promise<Viewer> {
    await this.snapshot(channel);
    const response = await this.form("/session", {
      nickname,
      channel,
      _csrf: this.csrf,
    });
    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), `/channels/${channel}`);
    await response.text();
    const page = await this.snapshot(channel);
    assert(page.viewer !== null, "Joining must establish a guest identity");
    assertEquals(page.viewer.nickname, nickname);
    return page.viewer;
  }

  async send(
    text: string,
    channel = "lobby",
    extra: Record<string, string> = {},
  ): Promise<PageData> {
    const response = await this.form(`/channels/${channel}/messages`, {
      ...extra,
      text,
      _csrf: this.csrf,
    });
    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), `/channels/${channel}`);
    await response.text();
    return this.snapshot(channel);
  }

  async create(name: string, topic: string): Promise<PageData> {
    const response = await this.form("/channels", {
      name,
      topic,
      _csrf: this.csrf,
    });
    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), `/channels/${name}`);
    await response.text();
    return this.snapshot(name);
  }
}

class Participant {
  readonly client: RoomClient;
  readonly messages: ChatMessage[] = [];
  readonly statuses: RoomStatus[] = [];
  readonly errors: string[] = [];
  members: Member[] = [];
  paused = false;

  constructor(readonly guest: Guest, channel: string) {
    this.client = new RoomClient({
      url: `${guest.server.origin}/channels/${channel}/socket`,
      connect: (url) => {
        // Hold recovery until the native form has written a missed message.
        if (this.paused) throw new Error("Recovery held by the test");
        return new HeaderWebSocket(url, {
          headers: { cookie: guest.jar.header, origin: guest.publicOrigin },
        });
      },
      reconnect: { minMs: 50, maxMs: 100 },
      onStatus: (status) => this.statuses.push(status),
      onPresence: (entries) => this.members = roomMembers(entries),
      onError: (error) => this.errors.push(error.code),
    });
    this.client.subscribe(
      "chat",
      (message) => this.messages.push(chatMessage(message)),
      { after: 0 },
    );
  }

  async ready(): Promise<void> {
    await bounded("guest room welcome", this.client.ready());
  }
}

interface Scenario {
  readonly server: DevServer;
  readonly participants: Participant[];
}

async function withServer(
  run: (scenario: Scenario) => Promise<void>,
  vars: Record<string, string> = {},
): Promise<void> {
  const celld = Deno.env.get("CELLD");
  const project = Deno.env.get("PROJECT");
  assert(celld && project, "Runtime tests require CELLD and PROJECT");
  const server = await DevServer.start(celld, project, {
    ...spec.vars,
    ...vars,
  });
  const participants: Participant[] = [];
  try {
    await run({ server, participants });
  } catch (error) {
    throw new Error(`${String(error)}\n--- celld dev ---\n${server.log}`, {
      cause: error,
    });
  } finally {
    for (const participant of participants) participant.client.close();
    await server.stop();
  }
}

function participant(
  scenario: Scenario,
  guest: Guest,
  channel = "lobby",
): Participant {
  const member = new Participant(guest, channel);
  scenario.participants.push(member);
  return member;
}

function rows(
  messages: readonly ChatMessage[],
): Array<[number, string | null, string]> {
  return messages.map((
    message,
  ) => [message.seq, message.from?.id ?? null, message.text]);
}

async function handshake(
  server: DevServer,
  cookie = "",
  origin = server.origin,
): Promise<Response> {
  return await fetch(`${server.origin}/channels/lobby/socket`, {
    headers: {
      cookie,
      origin,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  assertEquals(response.status, status, await response.text());
}

const options = { sanitizeOps: false, sanitizeResources: false };

Deno.test(
  "switchboard: a public transcript does not grant a guest socket",
  options,
  async () => {
    await withServer(async ({ server }) => {
      const guest = new Guest(server);
      const page = await guest.snapshot();
      assertEquals(page.viewer, null);
      assertEquals(page.messages, []);
      assertEquals(page.members, []);
      await expectStatus(await handshake(server, guest.jar.header), 401);
    });
  },
);

Deno.test(
  "switchboard: identities, tab-grouped presence, typing and ordered chat agree",
  options,
  async () => {
    await withServer(async (scenario) => {
      const ada = new Guest(scenario.server);
      const bob = new Guest(scenario.server);
      const adaIdentity = await ada.join("Ada");
      const bobIdentity = await bob.join("Bob");
      assert(
        adaIdentity.id !== bobIdentity.id,
        "Independent cookie jars must receive independent guest identities",
      );
      const first = participant(scenario, ada);
      const secondTab = participant(scenario, ada);
      const second = participant(scenario, bob);
      await Promise.all([first.ready(), secondTab.ready(), second.ready()]);
      const expectedMembers = [
        { ...adaIdentity, typing: false },
        { ...bobIdentity, typing: false },
      ];
      await until(
        "both identities in all tabs",
        () =>
          [first, secondTab, second].every((member) =>
            JSON.stringify(member.members) === JSON.stringify(expectedMembers)
          ),
      );
      assertEquals((await ada.snapshot()).members, expectedMembers);
      secondTab.client.setPresence({ typingUntil: Date.now() + 5000 });
      await until(
        "Ada typing from her second tab",
        () =>
          second.members.some((member) =>
            member.id === adaIdentity.id && member.typing
          ),
      );
      // HTTP readers have no live expiry clock: transient typing belongs to sockets.
      assertEquals((await bob.snapshot()).members, expectedMembers);
      secondTab.client.setPresence({ typingUntil: 0 });
      await until(
        "typing clears without writing chat",
        () => second.members.every((member) => !member.typing),
      );
      assertEquals((await ada.snapshot()).messages, []);

      const one = await bounded(
        "Bob publishes",
        second.client.publish("chat", { text: "hello Ada" }),
      );
      const two = await bounded(
        "Ada replies",
        first.client.publish("chat", { text: "hello Bob" }),
      );
      assertEquals([one, two], [1, 2]);
      await until(
        "two ordered messages in every tab",
        () =>
          [first, secondTab, second].every((member) =>
            member.messages.length === 2
          ),
      );
      const expected: Array<[number, string | null, string]> = [[
        1,
        bobIdentity.id,
        "hello Ada",
      ], [2, adaIdentity.id, "hello Bob"]];
      for (const member of [first, secondTab, second]) {
        assertEquals(rows(member.messages), expected);
      }
      assertEquals(rows((await bob.snapshot()).messages), expected);

      const left = await ada.form("/session/leave", {
        channel: "lobby",
        _csrf: ada.csrf,
      });
      await expectStatus(left, 303);
      await until(
        "logout closes both guest sockets",
        () =>
          first.client.status === "closed" &&
          secondTab.client.status === "closed",
      );
      await until(
        "only Bob remains after logout",
        () => second.members.length === 1,
      );
      assertEquals(second.members, [{ ...bobIdentity, typing: false }]);
      assertEquals((await ada.snapshot()).viewer, null);
      await expectStatus(await handshake(scenario.server, ada.jar.header), 401);
      assertEquals(rows((await bob.snapshot()).messages), expected);
    });
  },
);

Deno.test(
  "switchboard: cookie authentication and CSRF reject impersonation and cross-site mutation",
  options,
  async () => {
    await withServer(async (scenario) => {
      const ada = new Guest(scenario.server);
      const bob = new Guest(scenario.server);
      const identity = await ada.join("Ada");
      const other = await bob.join("Bob");
      const tampered = ada.jar.copy();
      const session = tampered.cookies.get("__Host-session");
      assert(session, "Joining must set the encrypted guest session cookie");
      const at = Math.floor(session.length / 2);
      tampered.cookies.set(
        "__Host-session",
        session.slice(0, at) + (session[at] === "A" ? "B" : "A") +
          session.slice(at + 1),
      );
      await expectStatus(
        await handshake(scenario.server, tampered.header),
        401,
      );
      await expectStatus(
        await handshake(
          scenario.server,
          ada.jar.header,
          "https://other.example",
        ),
        403,
      );
      const mutations: Array<[string, Record<string, string>]> = [
        ["/session", { nickname: "Mallory", channel: "lobby" }],
        ["/session/leave", { channel: "lobby" }],
        ["/channels", { name: "forged", topic: "must not exist" }],
        ["/channels/lobby/messages", { text: "must not be sent" }],
      ];
      for (const [path, fields] of mutations) {
        await expectStatus(await ada.form(path, fields), 403);
        await expectStatus(
          await ada.form(path, { ...fields, _csrf: "not-the-token" }),
          403,
        );
      }
      await expectStatus(
        await ada.form("/channels/lobby/messages", {
          text: "Bob token",
          _csrf: bob.csrf,
        }),
        403,
      );
      await expectStatus(
        await ada.request("/channels/lobby/messages", {
          method: "POST",
          headers: { accept: "text/html", origin: "https://other.example" },
          body: new URLSearchParams({ text: "cross-site", _csrf: ada.csrf }),
        }),
        403,
      );
      const unchanged = await ada.snapshot();
      assertEquals(unchanged.viewer, identity);
      assertEquals(unchanged.messages, []);
      assert(
        !unchanged.channels.some((channel) => channel.name === "forged"),
        "Rejected mutation must not create a channel",
      );
      const page = await ada.send("authentic Ada", "lobby", {
        id: other.id,
        nickname: "Bob",
        from: JSON.stringify(other),
      });
      assertEquals(rows(page.messages), [[1, identity.id, "authentic Ada"]]);
      assertEquals(page.messages[0].from, identity);
    });
  },
);

Deno.test(
  "switchboard: channel creation preserves topics, rejects duplicates and isolates history",
  options,
  async () => {
    await withServer(async (scenario) => {
      const guest = new Guest(scenario.server);
      const identity = await guest.join("Ada");
      await guest.send("lobby only");
      const channel = await guest.create(
        "constructor",
        "A channel named like an inherited object member",
      );
      assertEquals(channel.channel, {
        name: "constructor",
        topic: "A channel named like an inherited object member",
      });
      assertEquals(channel.messages, []);
      await guest.send("constructor only", "constructor");
      await expectStatus(
        await guest.form("/channels", {
          name: "constructor",
          topic: "must not overwrite",
          _csrf: guest.csrf,
        }),
        409,
      );
      const observer = new Guest(scenario.server);
      const page = await observer.snapshot("constructor");
      assertEquals(page.viewer, null);
      assertEquals(page.channel, channel.channel);
      assertEquals(
        page.channels.filter((entry) => entry.name === "constructor"),
        [channel.channel],
      );
      assertEquals(rows(page.messages), [[1, identity.id, "constructor only"]]);
      assertEquals(rows((await observer.snapshot()).messages), [[
        1,
        identity.id,
        "lobby only",
      ]]);
      assertEquals((await observer.snapshot("development")).messages, []);
      assertEquals((await observer.snapshot("off-topic")).messages, []);
      await scenario.server.restart();
      const persisted = await observer.snapshot("constructor");
      assertEquals(persisted.channel, channel.channel);
      assertEquals(persisted.channels, page.channels);
      assertEquals(rows(persisted.messages), [[
        1,
        identity.id,
        "constructor only",
      ]]);
    });
  },
);

Deno.test(
  "switchboard: native form navigation renders escaped history and inert hydration data",
  options,
  async () => {
    await withServer(async ({ server }) => {
      const guest = new Guest(server);
      const identity = await guest.join("Ada");
      const text =
        '</script><script id="pwn">window.pwned=true</script>&<b>not markup</b>';
      await guest.create("native", "Topic <img src=x onerror=alert(1)> & text");
      await guest.send(text, "native");
      const response = await guest.request("/channels/native", {
        headers: { accept: "text/html" },
      });
      assertEquals(response.status, 200);
      const html = await response.text();
      assert(
        !html.includes('<script id="pwn">'),
        "Message text must not become executable markup",
      );
      assert(
        !html.includes("<img src=x onerror=alert(1)>"),
        "Topics must not become executable markup",
      );
      assert(
        /&lt;\/script(?:>|&gt;)/.test(html),
        "The transcript must actually render the submitted text",
      );
      const scripts = [
        ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
      ];
      const boot = scripts.find((script) =>
        /\bid="celld-boot"/.test(script[1])
      );
      assert(boot, "SSR must include its hydration snapshot");
      assert(
        /\btype="application\/json"/.test(boot[1]),
        "Hydration data must be inert",
      );
      assert(
        !boot[2].includes("<"),
        "Hydration JSON must not terminate its script element",
      );
      const raw: unknown = JSON.parse(boot[2]);
      assert(
        typeof raw === "object" && raw !== null && "props" in raw,
        "Expected an inert page boot envelope",
      );
      const page = PageSchema.parse(raw.props);
      assertEquals(page.viewer, identity);
      assertEquals(
        page.channel.topic,
        "Topic <img src=x onerror=alert(1)> & text",
      );
      assertEquals(rows(page.messages), [[1, identity.id, text]]);
    });
  },
);

Deno.test(
  "switchboard: restart recovers durable history and replays the outage exactly once",
  options,
  async () => {
    await withServer(async (scenario) => {
      const guest = new Guest(scenario.server);
      const identity = await guest.join("Ada");
      const original = participant(scenario, guest);
      await original.ready();
      assertEquals(
        await bounded(
          "first publication",
          original.client.publish("chat", { text: "before restart" }),
        ),
        1,
      );
      await until("first delivery", () => original.messages.length === 1);
      original.paused = true;
      await scenario.server.restart();
      assert(
        original.statuses.includes("reconnecting"),
        original.statuses.join(", "),
      );
      assertEquals(rows((await guest.snapshot()).messages), [[
        1,
        identity.id,
        "before restart",
      ]]);
      await guest.send("during recovery");
      original.paused = false;
      await until(
        "room reconnects",
        () => original.client.status === "open",
        20_000,
      );
      await until(
        "missed native message replay",
        () => original.messages.length === 2,
      );
      assertEquals(
        await bounded(
          "live publication after replay",
          original.client.publish("chat", { text: "after recovery" }),
        ),
        3,
      );
      await until("third message", () => original.messages.length === 3);
      const expected: Array<[number, string | null, string]> = [
        [1, identity.id, "before restart"],
        [2, identity.id, "during recovery"],
        [3, identity.id, "after recovery"],
      ];
      assertEquals(rows(original.messages), expected);
      const late = participant(scenario, guest);
      await late.ready();
      await until(
        "fresh client replays persisted history",
        () => late.messages.length === 3,
      );
      assertEquals(rows(late.messages), expected);
      assertEquals(
        await bounded(
          "live message following fresh replay",
          late.client.publish("chat", { text: "both live" }),
        ),
        4,
      );
      await until(
        "both receive fourth message",
        () => original.messages.length === 4 && late.messages.length === 4,
      );
      expected.push([4, identity.id, "both live"]);
      assertEquals(rows(original.messages), expected);
      assertEquals(rows(late.messages), expected);
      assertEquals(rows((await guest.snapshot()).messages), expected);
      assertEquals(original.errors, []);
      assertEquals(late.errors, []);
    });
  },
);

Deno.test(
  "switchboard: rejected native and socket messages do not poison later valid Unicode sends",
  options,
  async () => {
    await withServer(async (scenario) => {
      const guest = new Guest(scenario.server);
      const identity = await guest.join("Ada");
      const live = participant(scenario, guest);
      await live.ready();
      for (const text of ["", " \n\t ", "界".repeat(2001)]) {
        const response = await guest.form("/channels/lobby/messages", {
          text,
          _csrf: guest.csrf,
        });
        assert(
          response.status >= 400 && response.status < 500,
          `Invalid text returned ${response.status}`,
        );
        await response.text();
      }
      const oversized = await guest.form("/channels/lobby/messages", {
        text: "x".repeat(40_000),
        _csrf: guest.csrf,
      });
      await expectStatus(oversized, 413);
      for (
        const data of [{ text: "" }, { text: "   " }, {
          text: "x".repeat(2001),
        }, { text: 42 }]
      ) {
        const failure = await bounded(
          "invalid publication refusal",
          live.client.publish("chat", data),
        ).then(
          () => null,
          (error: unknown) => error,
        );
        assert(
          failure instanceof RoomClientError && failure.code === "invalid",
          `Expected invalid publication, got ${String(failure)}`,
        );
      }
      assertEquals((await guest.snapshot()).messages, []);
      const unicode = "界".repeat(2000);
      const page = await guest.send(unicode);
      assertEquals(rows(page.messages), [[1, identity.id, unicode]]);
      assertEquals(
        await bounded(
          "valid publication after invalid sends",
          live.client.publish("chat", { text: "still connected" }),
        ),
        2,
      );
      await until(
        "valid messages on the original socket",
        () => live.messages.length === 2,
      );
      assertEquals(rows(live.messages), [[1, identity.id, unicode], [
        2,
        identity.id,
        "still connected",
      ]]);
      assertEquals(
        rows((await guest.snapshot()).messages),
        rows(live.messages),
      );
    });
  },
);

Deno.test(
  "switchboard: the complete retained transcript remains readable at the text boundary",
  options,
  async () => {
    await withServer(async ({ server }) => {
      const guest = new Guest(server);
      const identity = await guest.join("Ada");
      const text = "\u0000".repeat(2000);
      for (let index = 0; index < 201; index++) {
        const response = await guest.form("/channels/lobby/messages", {
          text,
          _csrf: guest.csrf,
        });
        await expectStatus(response, 303);
      }
      const page = await guest.snapshot();
      assertEquals(
        rows(page.messages),
        Array.from(
          { length: 200 },
          (_, index) => [index + 2, identity.id, text],
        ),
      );
      const response = await guest.request("/channels/lobby", {
        headers: { accept: "text/html" },
      });
      assertEquals(response.status, 200);
      assert(
        response.headers.get("content-type")?.includes("text/html"),
        "Native page must remain HTML at the payload boundary",
      );
      await response.text();
    });
  },
);

Deno.test(
  "switchboard: catalog capacity rejects new channels without changing existing topics",
  options,
  async () => {
    await withServer(async ({ server }) => {
      const guest = new Guest(server);
      await guest.join("Ada");
      const initial = await guest.snapshot();
      const created: Channel[] = [];
      for (let index = initial.channels.length; index < MAX_CHANNELS; index++) {
        const channel = {
          name: `channel-${String(index).padStart(2, "0")}`,
          topic: `Topic ${index}`,
        };
        const response = await guest.form("/channels", {
          ...channel,
          _csrf: guest.csrf,
        });
        await expectStatus(response, 303);
        created.push(channel);
      }
      const before = await guest.snapshot();
      assertEquals(
        before.channels,
        [...initial.channels, ...created].sort((a, b) =>
          a.name === "lobby"
            ? -1
            : b.name === "lobby"
            ? 1
            : a.name.localeCompare(b.name)
        ),
      );
      const rejected = await guest.form("/channels", {
        name: "over-capacity",
        topic: "Not persisted",
        _csrf: guest.csrf,
      });
      await expectStatus(rejected, 409);
      assertEquals((await guest.snapshot()).channels, before.channels);
      await server.restart();
      assertEquals((await guest.snapshot()).channels, before.channels);
    });
  },
);

Deno.test(
  "switchboard: an explicit HTTPS tunnel origin governs cookies, CSRF and socket authentication",
  options,
  async () => {
    const publicOrigin = "https://switchboard-tunnel.trycloudflare.com";
    await withServer(async (scenario) => {
      const guest = new Guest(scenario.server, publicOrigin);
      const identity = await guest.join("TunnelGuest");
      const live = participant(scenario, guest);
      await live.ready();
      await live.client.publish("chat", {
        text: "Published through the tunnel origin",
      });
      await until("tunnel message", () => live.messages.length === 1);
      assertEquals(rows(live.messages), [[
        1,
        identity.id,
        "Published through the tunnel origin",
      ]]);
      const native = await guest.send("Native form through the tunnel origin");
      assertEquals(rows(native.messages), [
        [1, identity.id, "Published through the tunnel origin"],
        [2, identity.id, "Native form through the tunnel origin"],
      ]);
      await expectStatus(
        await guest.request("/channels/lobby/messages", {
          method: "POST",
          headers: { origin: scenario.server.origin },
          body: new URLSearchParams({
            text: "Wrong origin",
            _csrf: guest.csrf,
          }),
        }),
        403,
      );
      await expectStatus(
        await guest.form("/channels/lobby/messages", {
          text: "Bad CSRF",
          _csrf: "wrong",
        }),
        403,
      );
      await expectStatus(
        await handshake(
          scenario.server,
          guest.jar.header,
          "https://foreign.example",
        ),
        403,
      );
      assertEquals(
        rows((await guest.snapshot()).messages),
        rows(native.messages),
      );
    }, { PUBLIC_ORIGIN: publicOrigin });
  },
);
