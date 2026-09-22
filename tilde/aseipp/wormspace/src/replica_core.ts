// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * WormPaxos: state machine replication over a segment chain, as logic over a
 * store and a segment resolver.
 *
 * The paper's WormPaxos (TR1544 §4.1) stores the command sequence in the
 * WormSpace address space. Replicas (the paper's WP-servers) learn by reading
 * it in order and propose by writing the next free address. Consensus is the
 * segments': each address is a write-once register, so whatever lands there
 * is the command at that position for every replica.
 *
 * A replica group named `g` is the segment chain `g`; each replica is a cell
 * `g.<replica>` of the `Replica` class holding a key/value state machine,
 * the global address of the next command to apply (`applied`), and its
 * leadership, if any: the segment it holds a batch capture on, the round, and
 * its private view of the next free offset there (`tail`).
 *
 *   - `learn` reads forward from `applied`, applies every written entry in
 *     order (a `set` or `del` changes the table, a `noop` or an entry that
 *     does not decode changes nothing, so every replica skips the same ones),
 *     and stops at the first register nobody has written, or at the end of
 *     the allocated chain.
 *   - `propose` is sticky: a replica that leads and has applied everything up
 *     to its own tail writes the command there under its round and nothing
 *     else, one round trip. Otherwise it learns to the tail and takes over:
 *     it allocates the segment holding `applied` if needed, captures the
 *     whole segment (a new round, which fences every older writer), writes
 *     a `noop` into every register below the highest written one that is
 *     still empty, learns again, and then writes. A refused write means
 *     somebody took over since: the replica drops its leadership and starts
 *     again, a bounded number of times. When its segment fills, the next
 *     proposal takes over the next link.
 *
 * Leadership survives only as long as nothing surprises it: it is kept while
 * every register learned at the leader's tail was written under a round no
 * later than its own (its own writes, or ones that landed before its
 * capture), and it is valid only while `applied` is exactly at the tail.
 *
 * Every method is serialised on the instance (`Serial`). Every register a
 * learner applies has passed its segment's durability barrier first (a
 * zero-timeout `listen` on the segment after the read); see the README for
 * the one case that does not cover.
 *
 * @module
 */

import {
  Chain,
  CHAIN_NAME_PATTERN,
  chainAddress,
  type ChainMismatch,
  chainPosition,
  type Segments,
} from "./chain.ts";
import { decodeEntry, encodeValue } from "./entry.ts";
import {
  type Conflict,
  type Contended,
  DEFAULT_SEGMENT_SIZE,
  liftTrimmed,
  type SegmentFailure,
} from "./sequencer_core.ts";
import {
  DEFAULT_RETRY,
  type RetryPolicy,
  retryTransient,
  Serial,
} from "@wormspace/segment/serial";
import {
  type Invalid,
  LIMITS,
  type ReadOk,
  type TooLarge,
} from "@wormspace/segment/types";

/** Replica names within a group. */
export const REPLICA_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Longest key, in UTF-16 code units. */
export const KEY_CHARS = 1024;

/** How many times one `propose` may start over before `CONTENDED`. */
export const PROPOSE_ATTEMPTS = 8;

/** How many commands one `learn` applies when the caller does not say. */
export const DEFAULT_LEARN = 1000;

export type Command =
  | { op: "set"; key: string; value: string }
  | { op: "del"; key: string }
  | { op: "noop" };

/** The segment a replica holds a batch capture on, and its next offset. */
export interface Leadership {
  index: number;
  captureId: number;
  tail: number;
}

export interface ReplicaState {
  smr: string;
  replica: string;
  /** The chain's segment size, once the chain exists and was read. */
  size: number | null;
  /** The size this replica creates the chain with, if it is the one to. */
  preferredSize: number;
  /** The global address of the next command to apply. */
  applied: number;
  leader: Leadership | null;
}

/** One key's new value, or its deletion. */
export interface KvChange {
  key: string;
  value: string | null;
}

/** What a replica keeps; SQLite in the Durable Object, Maps in tests. */
export interface ReplicaStore {
  load(): ReplicaState | null;
  get(key: string): string | null;
  /** Writes the state row and applies `changes`, atomically. */
  commit(state: ReplicaState, changes: readonly KvChange[]): void;
  /** Waits until every commit so far is durable; free when there was none. */
  barrier(): Promise<void>;
}

export interface ReplicaRequest {
  smr: string;
  replica: string;
}

export interface ProposeRequest extends ReplicaRequest {
  command: Command;
}

export interface LearnRequest extends ReplicaRequest {
  maxCommands?: number;
}

export interface GetRequest extends ReplicaRequest {
  key: string;
}

export interface ReplicaInitRequest extends ReplicaRequest {
  size: number;
}

export interface ReplicaStateOk {
  ok: true;
  smr: string;
  replica: string;
  applied: number;
  leader: Leadership | null;
  /** The chain's size, or `null` while no chain exists. */
  size: number | null;
  preferredSize: number;
}

/** The command landed at `address`, decided under round `term`. */
export interface ProposeOk {
  ok: true;
  address: number;
  term: number;
  applied: number;
}

/**
 * `blocked` is the first address nobody has written, or `null` when the
 * learner reached the end of the allocated chain (or of `maxCommands`).
 */
export interface LearnOk {
  ok: true;
  applied: number;
  learned: number;
  blocked: number | null;
}

export interface GetOk {
  ok: true;
  key: string;
  value: string | null;
  applied: number;
}

export type ProposeResult = ProposeOk | SegmentFailure | Contended;
export type LearnResult = LearnOk | SegmentFailure;
export type GetResult = GetOk | Invalid;
export type ReplicaStateResult = ReplicaStateOk | Invalid;
export type ReplicaInitResult =
  | ReplicaStateOk
  | Invalid
  | Conflict
  | ChainMismatch;

/** The replica's remote surface: the Durable Object's, and the core's. */
export interface ReplicaAPI {
  init(request: ReplicaInitRequest): Promise<ReplicaInitResult>;
  propose(request: ProposeRequest): Promise<ProposeResult>;
  learn(request: LearnRequest): Promise<LearnResult>;
  /**
   * Reads one key of the local state. Not `get`: that name is a reserved
   * member of every Durable Object stub (the deprecated Fetcher helper).
   */
  lookup(request: GetRequest): Promise<GetResult>;
  state(request: ReplicaRequest): Promise<ReplicaStateResult>;
}

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function fields(request: unknown): Record<string, unknown> {
  return (typeof request === "object" && request !== null
    ? request
    : {}) as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= KEY_CHARS;
}

/** Checks a command from the wire; keys and values are strings. */
export function checkCommand(
  value: unknown,
): { ok: true; command: Command } | Invalid {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("command must be an object");
  }
  const command = value as Record<string, unknown>;
  const keys = Object.keys(command).sort().join(",");
  switch (command.op) {
    case "noop":
      if (keys !== "op") return invalid("noop takes no fields");
      return { ok: true, command: { op: "noop" } };
    case "del":
      if (keys !== "key,op") return invalid("del takes exactly op and key");
      if (!isKey(command.key)) {
        return invalid(`key must be a 1..${KEY_CHARS} character string`);
      }
      return { ok: true, command: { op: "del", key: command.key } };
    case "set":
      if (keys !== "key,op,value") {
        return invalid("set takes exactly op, key, and value");
      }
      if (!isKey(command.key)) {
        return invalid(`key must be a 1..${KEY_CHARS} character string`);
      }
      if (typeof command.value !== "string") {
        return invalid("value must be a string");
      }
      return {
        ok: true,
        command: { op: "set", key: command.key, value: command.value },
      };
    default:
      return invalid('op must be "set", "del", or "noop"');
  }
}

/** A command's register value: the value entry of its canonical JSON. */
export function encodeCommand(
  command: Command,
): { ok: true; bytes: Uint8Array } | Invalid | TooLarge {
  const canonical = command.op === "set"
    ? { op: "set", key: command.key, value: command.value }
    : command.op === "del"
    ? { op: "del", key: command.key }
    : { op: "noop" };
  return encodeValue(new TextEncoder().encode(JSON.stringify(canonical)));
}

/**
 * The command a register holds, or `null` for anything that is not one (a
 * hole entry, bytes that are not an entry, or an entry that is not a valid
 * command). Every replica treats `null` exactly as a `noop`.
 */
export function decodeCommand(bytes: Uint8Array): Command | null {
  const entry = decodeEntry(bytes);
  if (!entry.ok || entry.entry.kind !== "value") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(entry.entry.value),
    );
  } catch {
    return null;
  }
  const checked = checkCommand(parsed);
  return checked.ok ? checked.command : null;
}

/** What applying `command` does to the table. */
export function changesOf(command: Command | null): KvChange[] {
  if (command === null) return [];
  switch (command.op) {
    case "set":
      return [{ key: command.key, value: command.value }];
    case "del":
      return [{ key: command.key, value: null }];
    case "noop":
      return [];
  }
}

const NOOP = (() => {
  const encoded = encodeCommand({ op: "noop" });
  if (!encoded.ok) throw new Error("the noop command must encode");
  return encoded.bytes;
})();

/** Whether `state` leads the segment holding `applied`, exactly there. */
export function leads(state: ReplicaState): boolean {
  const leader = state.leader;
  if (leader === null || state.size === null) return false;
  if (leader.tail >= state.size) return false;
  const address = chainAddress(leader.index, leader.tail, state.size);
  return address.ok && address.address === state.applied;
}

type Learned =
  | { ok: true; state: ReplicaState; learned: number; blocked: number | null }
  | SegmentFailure;

export class ReplicaCore implements ReplicaAPI {
  readonly #store: ReplicaStore;
  readonly #segments: Segments;
  readonly #retry: RetryPolicy;
  readonly #serial = new Serial();

  constructor(
    store: ReplicaStore,
    segments: Segments,
    retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.#store = store;
    this.#segments = segments;
    this.#retry = retry;
  }

  #again<T>(call: () => Promise<T>): Promise<T> {
    return retryTransient(call, this.#retry);
  }

  #state(request: unknown): ReplicaState | Invalid {
    const { smr, replica } = fields(request);
    if (typeof smr !== "string" || !CHAIN_NAME_PATTERN.test(smr)) {
      return invalid(`group names must match ${CHAIN_NAME_PATTERN}`);
    }
    if (typeof replica !== "string" || !REPLICA_PATTERN.test(replica)) {
      return invalid(`replica names must match ${REPLICA_PATTERN}`);
    }
    const state = this.#store.load();
    if (state === null) {
      return {
        smr,
        replica,
        size: null,
        preferredSize: DEFAULT_SEGMENT_SIZE,
        applied: 0,
        leader: null,
      };
    }
    if (state.smr !== smr || state.replica !== replica) {
      return invalid(
        `this cell is replica ${state.replica} of ${state.smr}, not ` +
          `${replica} of ${smr}`,
      );
    }
    return state;
  }

  #report(state: ReplicaState): ReplicaStateOk {
    return {
      ok: true,
      smr: state.smr,
      replica: state.replica,
      applied: state.applied,
      leader: state.leader,
      size: state.size,
      preferredSize: state.preferredSize,
    };
  }

  #owner(state: ReplicaState): string {
    return `replica:${state.replica}`;
  }

  /** Reads the chain's size from link 0, once it exists. */
  async #bind(
    state: ReplicaState,
  ): Promise<{ ok: true; state: ReplicaState } | ChainMismatch | Invalid> {
    if (state.size !== null) return { ok: true, state };
    const opened = await this.#again(() =>
      Chain.open(this.#segments, state.smr)
    );
    if (!opened.ok) {
      return opened.code === "UNALLOCATED" ? { ok: true, state } : opened;
    }
    const bound = { ...state, size: opened.chain.size };
    this.#store.commit(bound, []);
    return { ok: true, state: bound };
  }

  /** Creates link 0 with the preferred size unless somebody already did. */
  async #create(
    state: ReplicaState,
  ): Promise<{ ok: true; state: ReplicaState } | SegmentFailure> {
    const bound = await this.#bind(state);
    if (!bound.ok || bound.state.size !== null) return bound;
    const chain = Chain.create(this.#segments, state.smr, state.preferredSize);
    if (!chain.ok) return chain;
    const created = await this.#again(() =>
      chain.chain.allocate(0, this.#owner(state))
    );
    // A mismatch here is a race with a replica that preferred another size;
    // whoever won, link 0 now says what the size is.
    if (!created.ok && created.code !== "CHAIN_MISMATCH") return created;
    const again = await this.#bind(state);
    if (!again.ok) return again;
    if (again.state.size === null) {
      return invalid(`chain ${state.smr} has no link 0 after creating it`);
    }
    return again;
  }

  /**
   * Applies written registers from `applied` on, up to `max` of them. Each
   * window is read, passed through its segment's barrier, and committed with
   * its changes in one step, so progress survives a failure mid-way.
   */
  async #learn(start: ReplicaState, max: number): Promise<Learned> {
    const bound = await this.#bind(start);
    if (!bound.ok) return bound;
    let state = bound.state;
    const size = state.size;
    let learned = 0;
    if (size === null) return { ok: true, state, learned, blocked: null };
    while (learned < max) {
      const position = chainPosition(state.applied, size);
      if (!position.ok) return position;
      const { index, offset } = position;
      const segment = this.#segments(`${state.smr}.${index}`);
      const want = Math.min(size - offset, max - learned, LIMITS.readCount);
      const window = await this.#again(() =>
        segment.read({ start: offset, count: want })
      );
      if (!window.ok) {
        if (window.code === "UNALLOCATED") break;
        return liftTrimmed(window, index, size);
      }
      if (window.registers.some((register) => register.state === "written")) {
        await this.#again(() => segment.listen({ since: 0, timeoutMs: 0 }));
      }
      const changes: KvChange[] = [];
      let { applied, leader } = state;
      let blocked: number | null = null;
      for (const register of window.registers) {
        if (register.state !== "written" || register.value === undefined) {
          blocked = applied;
          break;
        }
        changes.push(...changesOf(decodeCommand(register.value)));
        if (
          leader !== null && leader.index === index &&
          leader.tail === register.offset
        ) {
          // Our own write, or one that landed before our capture: still
          // ours. A later round means somebody took over.
          leader = register.round <= leader.captureId
            ? { ...leader, tail: leader.tail + 1 }
            : null;
        }
        applied += 1;
        learned += 1;
      }
      if (applied !== state.applied || leader !== state.leader) {
        state = { ...state, applied, leader };
        this.#store.commit(state, changes);
      }
      if (blocked !== null) return { ok: true, state, learned, blocked };
    }
    return { ok: true, state, learned, blocked: null };
  }

  /**
   * Takes over the segment holding `applied`: allocate it if needed, capture
   * from `applied` to its end, fill the holes below the highest written
   * register with `noop`, and learn through them. Returns the new state,
   * which leads unless somebody took over again in the meantime.
   */
  async #takeover(
    start: ReplicaState,
  ): Promise<{ ok: true; state: ReplicaState } | SegmentFailure> {
    const created = await this.#create(start);
    if (!created.ok) return created;
    let state = created.state;
    const size = state.size as number;
    const position = chainPosition(state.applied, size);
    if (!position.ok) return position;
    const { index, offset } = position;
    const chain = Chain.create(this.#segments, state.smr, size);
    if (!chain.ok) return chain;
    const allocated = await this.#again(() =>
      chain.chain.allocate(index, this.#owner(state))
    );
    if (!allocated.ok) return allocated;
    const segment = this.#segments(`${state.smr}.${index}`);
    // The whole segment, not just from `offset`: every register below it is
    // written and immune anyway, and a capture that covers the last one
    // prunes its row, so repeated takeovers keep one row per segment rather
    // than one per takeover (which the segment caps at 4096).
    const captured = await this.#again(() =>
      segment.capture({ start: 0, end: size, owner: this.#owner(state) })
    );
    if (!captured.ok) return liftTrimmed(captured, index, size);
    const captureId = captured.captureId;

    // Every register at or past `offset` is now written or ours.
    const pending: number[] = [];
    let highest = -1;
    for (let from = offset; from < size;) {
      const window: ReadOk | SegmentFailure = await this.#again(() =>
        segment.read({
          start: from,
          count: Math.min(size - from, LIMITS.readCount),
        })
      );
      if (!window.ok) return liftTrimmed(window, index, size);
      for (const register of window.registers) {
        if (register.state === "written") highest = register.offset;
        else pending.push(register.offset);
      }
      from = window.registers[window.registers.length - 1].offset + 1;
    }
    for (const hole of pending.filter((at) => at < highest)) {
      const filled = await this.#again(() =>
        segment.write({ start: hole, values: [NOOP], captureId })
      );
      if (filled.ok) continue;
      if (filled.code === "ALREADY_WRITTEN" && filled.sameValue) continue;
      if (
        filled.code === "ALREADY_WRITTEN" || filled.code === "CAPTURE_STALE"
      ) {
        // Somebody took over while we filled; our round is worthless.
        return { ok: true, state };
      }
      return liftTrimmed(filled, index, size);
    }
    state = { ...state, leader: { index, captureId, tail: offset } };
    this.#store.commit(state, []);
    const learned = await this.#learn(state, Infinity);
    if (!learned.ok) return learned;
    return { ok: true, state: learned.state };
  }

  init(request: ReplicaInitRequest): Promise<ReplicaInitResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const { size } = fields(request);
      if (!isCount(size) || size < 1 || size > LIMITS.maxSize) {
        return invalid(`size must be an integer in [1, ${LIMITS.maxSize}]`);
      }
      const bound = await this.#bind(state);
      if (!bound.ok) return bound;
      let next = bound.state;
      if (next.size !== null && next.size !== size) {
        await this.#store.barrier();
        return {
          ok: false,
          code: "CONFLICT",
          message: `chain ${next.smr} already has segments of ${next.size}`,
          size: next.size,
        };
      }
      next = { ...next, preferredSize: size };
      this.#store.commit(next, []);
      await this.#store.barrier();
      return this.#report(next);
    });
  }

  learn(request: LearnRequest): Promise<LearnResult> {
    return this.#serial.run(async () => {
      const state = this.#state(request);
      if ("code" in state) return state;
      const { maxCommands } = fields(request);
      if (
        maxCommands !== undefined &&
        (!isCount(maxCommands) || maxCommands < 1)
      ) {
        return invalid("maxCommands must be an integer >= 1");
      }
      const learned = await this.#learn(
        state,
        (maxCommands as number | undefined) ?? DEFAULT_LEARN,
      );
      await this.#store.barrier();
      if (!learned.ok) return learned;
      return {
        ok: true,
        applied: learned.state.applied,
        learned: learned.learned,
        blocked: learned.blocked,
      };
    });
  }

  propose(request: ProposeRequest): Promise<ProposeResult> {
    return this.#serial.run(async () => {
      const initial = this.#state(request);
      if ("code" in initial) return initial;
      const checked = checkCommand(fields(request).command);
      if (!checked.ok) return checked;
      const encoded = encodeCommand(checked.command);
      if (!encoded.ok) return encoded;
      const result = await this.#propose(
        initial,
        checked.command,
        encoded.bytes,
      );
      await this.#store.barrier();
      return result;
    });
  }

  async #propose(
    initial: ReplicaState,
    command: Command,
    bytes: Uint8Array,
  ): Promise<ProposeResult> {
    let state = initial;
    for (let attempt = 0; attempt < PROPOSE_ATTEMPTS; attempt += 1) {
      if (!leads(state)) {
        const learned = await this.#learn(state, Infinity);
        if (!learned.ok) return learned;
        state = learned.state;
      }
      if (!leads(state)) {
        const taken = await this.#takeover(state);
        if (!taken.ok) return taken;
        state = taken.state;
        if (!leads(state)) continue;
      }
      const leader = state.leader as Leadership;
      const segment = this.#segments(`${state.smr}.${leader.index}`);
      const written = await this.#again(() =>
        segment.write({
          start: leader.tail,
          values: [bytes],
          captureId: leader.captureId,
        })
      );
      if (
        written.ok ||
        (written.code === "ALREADY_WRITTEN" && written.sameValue)
      ) {
        const address = state.applied;
        state = {
          ...state,
          applied: address + 1,
          leader: { ...leader, tail: leader.tail + 1 },
        };
        this.#store.commit(state, changesOf(command));
        return {
          ok: true,
          address,
          term: leader.captureId,
          applied: state.applied,
        };
      }
      switch (written.code) {
        case "ALREADY_WRITTEN": {
          // The tail moved under us; learning says whether we still lead.
          const learned = await this.#learn(state, Infinity);
          if (!learned.ok) return learned;
          state = learned.state;
          continue;
        }
        case "CAPTURE_STALE":
          state = { ...state, leader: null };
          this.#store.commit(state, []);
          continue;
        default:
          return liftTrimmed(written, leader.index, state.size as number);
      }
    }
    return {
      ok: false,
      code: "CONTENDED",
      message: `no address held after ${PROPOSE_ATTEMPTS} attempts`,
    };
  }

  lookup(request: GetRequest): Promise<GetResult> {
    return this.#serial.run((): Promise<GetResult> => {
      const state = this.#state(request);
      if ("code" in state) return Promise.resolve(state);
      const { key } = fields(request);
      if (!isKey(key)) {
        return Promise.resolve(
          invalid(`key must be a 1..${KEY_CHARS} character string`),
        );
      }
      return Promise.resolve({
        ok: true,
        key,
        value: this.#store.get(key),
        applied: state.applied,
      });
    });
  }

  state(request: ReplicaRequest): Promise<ReplicaStateResult> {
    return this.#serial.run(() => {
      const state = this.#state(request);
      return Promise.resolve("code" in state ? state : this.#report(state));
    });
  }
}
