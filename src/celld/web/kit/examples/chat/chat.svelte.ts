// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { tick } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { createNavigation, definePage } from "@celld/web/kit/navigation";
import type { NavigationOptions } from "@celld/web/kit/navigation";
import { RoomClient, RoomClientError } from "@celld/web/realtime/client";
import type { RoomStatus } from "@celld/web/realtime/client";
import type { PresenceEntry } from "@celld/web/realtime";
import { createClient } from "@celld/web/router/client";
import type {
  BrowserClient,
  ClientFailure,
  ClientResult,
} from "@celld/web/router/client";
import {
  chatMessage,
  roomMembers,
  routes,
  TextSchema,
} from "@celld/web/switchboard/contracts";
import type { ChatMessage, PageData } from "@celld/web/switchboard/contracts";
import type { ChatModel } from "./model.ts";

interface RoomView {
  messages: ChatMessage[];
  presence: readonly PresenceEntry[] | null;
  status: RoomStatus;
  unread: number;
  last: number;
  resumable: boolean;
}

function failure(error: ClientFailure): string {
  if (error.kind === "validation") {
    return [
      ...error.error.formErrors,
      ...Object.values(error.error.fieldErrors).flat(),
    ].join(" ") || "Check the fields and try again.";
  }
  if (error.kind === "auth") {
    return "Your guest session ended. Reload the page and join again.";
  }
  if (error.kind === "http") return error.error.message;
  if (error.kind === "response") {
    return "The server reply could not be read. Reload to check the result before repeating the action.";
  }
  if (error.kind === "cancelled") {
    return "The request was interrupted. Reload to check the result before repeating the action.";
  }
  return "The server could not be reached. Your inputs are still here; try again.";
}

/** All state is per rendered page. Sockets start only after browser hydration. */
export function createChatModel(snapshot: () => PageData): ChatModel {
  const initial = snapshot();
  let page = $state(initial);
  let filter = $state("");
  let mobilePanel = $state<ChatModel["mobilePanel"]>("none");
  let navigating = $state(false);
  let formError = $state("");
  let notice = $state("");
  let now = $state(Date.now());
  const rooms = new SvelteMap<string, RoomView>();
  const drafts = new SvelteMap<string, string>();
  const errors = new SvelteMap<string, string>();
  const pending = new SvelteSet<string>();
  const clients = new SvelteMap<string, RoomClient>();
  let api: BrowserClient<typeof routes> | undefined;
  let running = $state(false);
  let lifecycle = 0;
  let go: ((name: string, push: boolean) => Promise<boolean>) | undefined;
  let cancelNavigation: (() => void) | undefined;
  let mutationRequest: AbortController | undefined;
  let mutationDone: Promise<void> | undefined;
  let typingTimer: number | undefined;
  let lastTyping = 0;

  function http(): BrowserClient<typeof routes> {
    return api ??= createClient(routes, { baseUrl: location.origin });
  }

  function view(name: string): RoomView {
    const existing = rooms.get(name);
    if (existing) return existing;
    const room = $state<RoomView>({
      messages: [],
      presence: null,
      status: "connecting",
      unread: 0,
      last: 0,
      resumable: false,
    });
    rooms.set(name, room);
    return room;
  }

  function reconcile(data: PageData): number {
    const room = view(data.channel.name);
    const last = data.messages.at(-1)?.seq ?? 0;
    // The snapshot is authoritative up to its tail; preserve newer live frames.
    room.messages = [
      ...data.messages,
      ...room.messages.filter((message) => message.seq > last),
    ].slice(-200);
    room.last = room.messages.at(-1)?.seq ?? 0;
    return last;
  }
  reconcile(initial);
  view(initial.channel.name).resumable = true;

  const members = $derived.by(() => {
    const presence = view(page.channel.name).presence;
    return presence === null ? page.members : roomMembers(presence, now);
  });
  const typingNames = $derived(
    members.filter((member) => member.typing && member.id !== page.viewer?.id)
      .map((member) => member.nickname),
  );
  const unread = $derived.by(() =>
    Object.fromEntries([...rooms].map(([name, room]) => [name, room.unread]))
  );

  function receive(name: string, incoming: ChatMessage): void {
    const room = view(name);
    if (incoming.seq > room.last) {
      room.messages.push(incoming);
      room.last = incoming.seq;
    } else {
      // Promotion may replay a missing frame below a buffered live tail.
      let low = 0;
      let high = room.messages.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (room.messages[middle].seq < incoming.seq) low = middle + 1;
        else high = middle;
      }
      if (
        room.messages[low]?.seq === incoming.seq ||
        room.messages.length === 200 && low === 0
      ) return;
      room.messages.splice(low, 0, incoming);
    }
    if (room.messages.length > 200) room.messages.shift();
    if (name !== page.channel.name) room.unread++;
  }

  async function recover(name: string, client: RoomClient): Promise<void> {
    const result = await http().call("channel", { params: { channel: name } });
    if (!running || clients.get(name) !== client) return;
    if (result.ok) {
      reconcile(result.data);
      if (name === page.channel.name) {
        notice = "Recent history was refreshed after reconnecting.";
      }
    } else notice = failure(result);
  }

  function connect(name: string, cursor?: number): void {
    if (!running || page.viewer === null || clients.has(name)) return;
    const room = view(name);
    room.status = "connecting";
    const client = new RoomClient({
      url: `/channels/${name}/socket`,
      onStatus(status) {
        room.status = status;
      },
      onPresence(presence) {
        room.presence = presence;
        now = Date.now();
      },
      onError(error) {
        errors.set(name, error.message);
      },
    });
    clients.set(name, client);
    client.subscribe("chat", (message) => receive(name, chatMessage(message)), {
      // Unvisited rooms start live, without counting old history as unread.
      ...(room.resumable ? { after: cursor ?? room.last } : {}),
      onReset() {
        void recover(name, client);
      },
    });
  }

  function connectChannels(): void {
    for (const channel of page.channels) connect(channel.name);
  }

  function clearTyping(): void {
    clearTimeout(typingTimer);
    typingTimer = undefined;
    clients.get(page.channel.name)?.setPresence(null);
    lastTyping = 0;
  }

  function closeConnections(): void {
    clearTyping();
    for (const client of clients.values()) client.close();
    clients.clear();
    for (const room of rooms.values()) room.presence = null;
  }

  async function commit(data: PageData, push: boolean): Promise<void> {
    clearTyping();
    const room = view(data.channel.name);
    const promote = !room.resumable;
    const cursor = reconcile(data);
    room.resumable = true;
    page = data;
    room.unread = 0;
    filter = "";
    mobilePanel = "none";
    if (push) history.pushState(null, "", `/channels/${data.channel.name}`);
    document.title = `#${data.channel.name} — Switchboard`;
    if (promote) {
      // A fresh socket cannot let an old live frame overtake snapshot replay.
      const old = clients.get(data.channel.name);
      clients.delete(data.channel.name);
      old?.close();
      connect(data.channel.name, cursor);
    }
    connectChannels();
    await tick();
  }

  async function mutate(
    kind: "enter" | "create" | "leave",
    call: (signal: AbortSignal) => Promise<ClientResult<typeof routes.enter>>,
  ): Promise<boolean> {
    if (mutationDone) {
      formError = "Wait for the current action to finish.";
      return false;
    }
    formError = "";
    cancelNavigation?.();
    const epoch = lifecycle;
    const controller = mutationRequest = new AbortController();
    let finished!: () => void;
    mutationDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      const result = await call(controller.signal);
      if (!running || lifecycle !== epoch) return false;
      if (!result.ok) {
        if (kind === "leave") notice = failure(result);
        else formError = failure(result);
        return false;
      }
      if (kind !== "create") closeConnections();
      if (kind === "leave") {
        drafts.clear();
        errors.clear();
      }
      if (navigating) {
        // A later navigation owns selection, but cannot discard changed cookies.
        page = {
          ...page,
          viewer: result.data.viewer,
          csrf: result.data.csrf,
          channels: result.data.channels,
          members: result.data.channel.name === page.channel.name
            ? result.data.members
            : page.members,
        };
        connectChannels();
      } else await commit(result.data, kind === "create");
      return true;
    } finally {
      if (lifecycle === epoch) {
        mutationDone = undefined;
        mutationRequest = undefined;
      }
      finished();
    }
  }

  return {
    get enhanced() {
      return running;
    },
    get page() {
      return page;
    },
    get messages() {
      return view(page.channel.name).messages;
    },
    get members() {
      return members;
    },
    get status() {
      return page.viewer === null ? "reading" : view(page.channel.name).status;
    },
    get navigating() {
      return navigating;
    },
    get sending() {
      return pending.has(page.channel.name);
    },
    get sendError() {
      return errors.get(page.channel.name) ?? "";
    },
    get formError() {
      return formError;
    },
    get notice() {
      return notice;
    },
    get typingNames() {
      return typingNames;
    },
    get unread() {
      return unread;
    },
    get draft() {
      return drafts.get(page.channel.name) ?? "";
    },
    set draft(value) {
      drafts.set(page.channel.name, value);
      errors.delete(page.channel.name);
    },
    get filter() {
      return filter;
    },
    set filter(value) {
      filter = value;
    },
    get mobilePanel() {
      return mobilePanel;
    },
    set mobilePanel(value) {
      mobilePanel = value;
    },
    start() {
      running = true;
      connectChannels();
      const timer = setInterval(() => {
        now = Date.now();
      }, 1000);
      const options: NavigationOptions<PageData> = {
        pages: [
          definePage(routes.home, async (context) => {
            await mutationDone;
            return http().call("home", { signal: context.signal });
          }),
          definePage(routes.channel, async (context) => {
            await mutationDone;
            return http().call("channel", {
              params: context.params,
              signal: context.signal,
            });
          }),
        ],
        onState(state) {
          navigating = state.status === "pending";
          if (state.status === "error") notice = failure(state.error);
        },
        async commit(data, context) {
          if (!context.signal.aborted && running) await commit(data, false);
        },
      };
      const navigation = createNavigation(options);
      go = (name, push) =>
        navigation.navigate(`/channels/${name}`, {
          history: push ? "push" : "none",
        });
      cancelNavigation = () => navigation.update(options);
      const stop = () => {
        if (!running) return;
        running = false;
        lifecycle++;
        mutationRequest?.abort();
        navigation.destroy();
        go = undefined;
        cancelNavigation = undefined;
        clearInterval(timer);
        closeConnections();
        removeEventListener("pagehide", pagehide);
      };
      const pagehide = (event: PageTransitionEvent) => {
        if (!event.persisted) stop();
      };
      addEventListener("pagehide", pagehide);
      return stop;
    },
    navigate(name, push = true) {
      return go ? go(name, push) : Promise.resolve(false);
    },
    enter(nickname) {
      return mutate(
        "enter",
        (signal) =>
          http().call("enter", {
            body: { nickname, channel: page.channel.name },
            headers: { "x-csrf-token": page.csrf },
            signal,
          }),
      );
    },
    createChannel(name, topic) {
      return mutate(
        "create",
        (signal) =>
          http().call("create", {
            body: { name, topic },
            headers: { "x-csrf-token": page.csrf },
            signal,
          }),
      );
    },
    async leave() {
      await mutate(
        "leave",
        (signal) =>
          http().call("leave", {
            body: { channel: page.channel.name },
            headers: { "x-csrf-token": page.csrf },
            signal,
          }),
      );
    },
    async send() {
      const name = page.channel.name;
      const draft = drafts.get(name) ?? "";
      if (pending.has(name)) return;
      const parsed = TextSchema.safeParse(draft);
      if (!parsed.success) {
        errors.set(
          name,
          "Write a message of 1–2000 characters before sending.",
        );
        return;
      }
      const client = clients.get(name);
      if (!client || client.status !== "open") {
        errors.set(
          name,
          "You are not connected. Keep your draft and wait for the connection, or join again.",
        );
        return;
      }
      pending.add(name);
      errors.delete(name);
      try {
        await client.publish("chat", { text: parsed.data });
        if (drafts.get(name) === draft) drafts.set(name, "");
        if (page.channel.name === name) clearTyping();
      } catch (error) {
        const uncertain = error instanceof RoomClientError &&
          (error.code === "disconnected" || error.code === "timeout");
        errors.set(
          name,
          uncertain
            ? "Delivery could not be confirmed. Your draft is still here; check the transcript before sending again."
            : error instanceof Error
            ? error.message
            : "The message could not be sent. Your draft is still here.",
        );
      } finally {
        pending.delete(name);
      }
    },
    typing() {
      const client = clients.get(page.channel.name);
      if (!client || client.status !== "open") return;
      if (!drafts.get(page.channel.name)?.trim()) {
        clearTyping();
        return;
      }
      const at = Date.now();
      if (at - lastTyping >= 1000) {
        client.setPresence({ typingUntil: at + 5000 });
        lastTyping = at;
      }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(clearTyping, 5000);
    },
    clearFormError() {
      formError = "";
    },
    dismissNotice() {
      notice = "";
    },
  };
}
