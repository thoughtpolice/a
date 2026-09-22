// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized model check of the decision core against its invariants: the
 * generator and the checker, shared by `model_test.ts`, which runs it, and
 * `fake_segment_test.ts`, which replays its operation sequences against the
 * in-memory segment.
 *
 * Two things are kept side by side. `Storage` is what the Durable Object's
 * tables would hold, maintained by a reducer over each `Outcome` and read back
 * through the same views the Durable Object builds. `Truth` is an independent
 * account of the semantics: every capture ever granted (pruned or not), and
 * the first value ever accepted at each offset. After every step the two must
 * agree, which is what shows that pruning dominated captures and trimming are
 * invisible, and that nothing a rejection touched was ever persisted.
 *
 * Several writers capture single registers and ranges, steal each other's
 * captures, write with their current round, a stale one, zero, or somebody
 * else's, replay what is already there, read, and trim. Seeds are fixed, so a
 * failure reproduces exactly; its seed and step number are in the message.
 * A `trace` callback sees every request, its result, and the storage after
 * it, which is what lets another implementation be checked step by step.
 *
 * @module
 */

import * as core from "@wormspace/segment/core";
import {
  type CaptureRow,
  type Meta,
  type Outcome,
  type Range,
  type RegisterRow,
} from "@wormspace/segment/core";
import {
  type AllocRequest,
  type AllocResult,
  type CaptureRequest,
  type CaptureResult,
  LIMITS,
  type ReadRequest,
  type ReadResult,
  type TrimRequest,
  type TrimResult,
  type WriteRequest,
  type WriteResult,
} from "@wormspace/segment/types";
import { assert, equals, show } from "@celld/assert";

export const SEEDS = 100;
export const STEPS = 300;
export const SIZE = 24;
const WRITERS = ["alpha", "beta", "gamma", "delta"];
const T0 = 1_700_000_000_000;

/** One generated operation: its request, the model's result, and its clock. */
export type Step =
  | { op: "alloc"; nowMs: number; request: AllocRequest; result: AllocResult }
  | {
    op: "capture";
    nowMs: number;
    request: CaptureRequest;
    result: CaptureResult;
  }
  | { op: "write"; nowMs: number; request: WriteRequest; result: WriteResult }
  | { op: "read"; nowMs: number; request: ReadRequest; result: ReadResult }
  | { op: "trim"; nowMs: number; request: TrimRequest; result: TrimResult };

/** Sees every step once the model has applied it. */
export type Trace = (step: Step, storage: Storage) => void;

/** mulberry32: small, fast, and identical on every run of every platform. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The segment's tables, as the Durable Object would hold them. */
export interface Storage {
  meta: Meta;
  captures: CaptureRow[];
  registers: Map<number, RegisterRow>;
}

/** Every write the Durable Object would perform for one outcome. */
export function apply(storage: Storage, outcome: Outcome<unknown>): boolean {
  if (outcome.meta === storage.meta) {
    assert(
      outcome.insertRegisters === undefined &&
        outcome.insertCapture === undefined &&
        outcome.pruneCaptures === undefined &&
        outcome.deleteThrough === undefined,
      "an unchanged meta carried a write set",
    );
    return false;
  }
  const prune = outcome.pruneCaptures;
  if (prune !== undefined) {
    storage.captures = storage.captures.filter((row) =>
      !(row.start >= prune.start && row.end <= prune.end)
    );
  }
  const captured = outcome.insertCapture;
  if (captured !== undefined) {
    storage.captures.push({
      round: captured.round,
      start: captured.start,
      end: captured.end,
    });
  }
  for (const row of outcome.insertRegisters ?? []) {
    assert(!storage.registers.has(row.offset), "a primary key was reused");
    storage.registers.set(row.offset, {
      offset: row.offset,
      round: row.round,
      value: row.value,
    });
  }
  const through = outcome.deleteThrough;
  if (through !== undefined) {
    for (const offset of [...storage.registers.keys()]) {
      if (offset <= through) storage.registers.delete(offset);
    }
    storage.captures = storage.captures.filter((row) => row.end > through + 1);
  }
  storage.meta = outcome.meta;
  return true;
}

export function written(storage: Storage, range: Range): RegisterRow[] {
  return [...storage.registers.values()]
    .filter((row) => row.offset >= range.start && row.offset < range.end)
    .sort((left, right) => left.offset - right.offset);
}

export function overlapping(storage: Storage, range: Range): CaptureRow[] {
  return storage.captures.filter((row) =>
    row.start < range.end && row.end > range.start
  );
}

/** A read answered from storage through the views the Durable Object builds. */
export function modelRead(storage: Storage, request: ReadRequest): ReadResult {
  const plan = core.planRead(storage.meta, request);
  if (plan.kind === "reply") return plan.result;
  const sizes = written(storage, plan).map((row) => ({
    offset: row.offset,
    bytes: row.value.byteLength,
  }));
  const window = { start: plan.start, end: core.readWindow(plan, sizes) };
  return core.finishRead(
    storage.meta,
    window,
    written(storage, window),
    overlapping(storage, window),
  );
}

/** The semantics, kept independently of storage. */
interface Truth {
  /** Every capture ever granted, by round, with its effective range. */
  rounds: Map<number, { start: number; end: number; writer: string }>;
  /** The first value accepted at each offset, and the round that wrote it. */
  firstWrite: Map<number, { value: Uint8Array; round: number }>;
}

function truthRound(truth: Truth, offset: number): number {
  let round = 0;
  for (const [candidate, range] of truth.rounds) {
    if (range.start <= offset && offset < range.end && candidate > round) {
      round = candidate;
    }
  }
  return round;
}

function randomInt(random: () => number, bound: number): number {
  return Math.floor(random() * bound);
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[randomInt(random, values.length)];
}

function randomBytes(random: () => number): Uint8Array {
  const bytes = new Uint8Array(randomInt(random, 6));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = randomInt(random, 256);
  }
  return bytes;
}

const OPERATIONS = [
  ["alloc", 2],
  ["capture", 14],
  ["batchCapture", 8],
  ["write", 46],
  ["read", 18],
  ["trim", 3],
] as const;

const TOTAL_WEIGHT = OPERATIONS.reduce((sum, [, weight]) => sum + weight, 0);

function pickOperation(random: () => number): string {
  let point = random() * TOTAL_WEIGHT;
  for (const [name, weight] of OPERATIONS) {
    point -= weight;
    if (point < 0) return name;
  }
  return "read";
}

/**
 * Runs one seed to completion, throwing with enough context to replay it, and
 * records the interesting outcomes it produced into `seen`.
 */
export function run(
  seed: number,
  steps: number,
  seen: Set<string>,
  trace?: Trace,
): void {
  const random = mulberry32(seed);
  const storage: Storage = {
    meta: core.INITIAL_META,
    captures: [],
    registers: new Map(),
  };
  const truth: Truth = { rounds: new Map(), firstWrite: new Map() };
  // Each writer's current round, and every round it was ever granted.
  const current = new Map<string, number>();
  const granted = new Map<string, number[]>(WRITERS.map((w) => [w, []]));
  let nowMs = T0;

  const fail = (step: number, message: string): never => {
    throw new Error(`seed ${seed} step ${step}: ${message}`);
  };

  for (let step = 0; step < steps; step += 1) {
    const before = storage.meta;
    nowMs += 1;
    // Allocation comes first in most seeds; a few steps run unallocated.
    const operation = !before.allocated && step > 2
      ? "alloc"
      : pickOperation(random);
    const writer = pick(random, WRITERS);

    switch (operation) {
      case "alloc": {
        const metadata = randomBytes(random);
        const request = { size: SIZE, metadata, allocator: writer };
        const outcome = core.alloc(before, request, nowMs);
        const result = outcome.result;
        if (result.ok) {
          if (before.allocated) fail(step, "a second alloc won");
          if (!equals(outcome.meta.metadata, metadata)) {
            fail(step, "the winner's metadata was not kept");
          }
        } else if (result.code === "ALREADY_ALLOCATED") {
          if (!before.allocated) fail(step, "ALREADY_ALLOCATED when free");
          if (
            result.allocator !== before.allocator ||
            !equals(result.metadata, before.metadata)
          ) {
            fail(step, "ALREADY_ALLOCATED misreported the winner");
          }
          seen.add("alloc-lost");
        } else {
          fail(step, `unexpected alloc result ${show(result)}`);
        }
        apply(storage, outcome);
        trace?.({ op: "alloc", nowMs, request, result }, storage);
        break;
      }
      case "capture":
      case "batchCapture": {
        let start: number;
        let end: number | undefined;
        if (operation === "capture") {
          start = randomInt(random, SIZE + 1);
          end = random() < 0.5 ? undefined : start + 1;
        } else if (random() < 0.5) {
          start = 0;
          end = SIZE;
        } else {
          start = randomInt(random, SIZE);
          end = start + 1 + randomInt(random, SIZE - start);
        }
        const request = { start, end, owner: writer };
        const range = core.captureScope(before, request);
        const view = range === null ? core.EMPTY_CAPTURE_VIEW : {
          writtenInRange: written(storage, range).length,
          liveCaptures: storage.captures.length,
          dominated: storage.captures.filter((row) =>
            row.start >= range.start && row.end <= range.end
          ).length,
        };
        const outcome = core.capture(before, request, view, nowMs);
        const result = outcome.result;
        const last = end ?? start + 1;
        if (result.ok) {
          if (result.captureId !== before.nextRound) {
            fail(step, "a capture did not take the next round");
          }
          if (outcome.meta.nextRound !== before.nextRound + 1) {
            fail(step, "nextRound did not advance by one");
          }
          if (truth.rounds.has(result.captureId)) {
            fail(step, `round ${result.captureId} was granted twice`);
          }
          if (
            result.start !== Math.max(start, before.trimmedThrough + 1) ||
            result.end !== last
          ) {
            fail(step, `capture reported ${result.start}..${result.end}`);
          }
          let alreadyWritten = 0;
          for (let offset = result.start; offset < result.end; offset += 1) {
            if (truth.firstWrite.has(offset)) {
              alreadyWritten += 1;
            }
            // A steal: someone else's current round held this offset.
            const holder = truthRound(truth, offset);
            const owner = truth.rounds.get(holder)?.writer;
            if (owner !== undefined && owner !== writer) {
              seen.add("steal");
            }
          }
          if (result.alreadyWritten !== alreadyWritten) {
            fail(step, "alreadyWritten disagrees with the model");
          }
          if (result.start > start) {
            seen.add("capture-clipped");
          }
          if (outcome.pruneCaptures !== undefined) {
            seen.add("capture-pruned");
          }
          truth.rounds.set(result.captureId, {
            start: result.start,
            end: result.end,
            writer,
          });
          current.set(writer, result.captureId);
          granted.get(writer)!.push(result.captureId);
        } else if (result.code === "UNALLOCATED") {
          if (before.allocated) {
            fail(step, "UNALLOCATED after alloc");
          }
        } else if (result.code === "OUT_OF_RANGE") {
          if (last <= before.size) {
            fail(step, "a legal range was OUT_OF_RANGE");
          }
        } else if (result.code === "TRIMMED") {
          if (last - 1 > before.trimmedThrough) {
            fail(step, "a live range was TRIMMED");
          }
          seen.add("capture-trimmed");
        } else {
          fail(step, `unexpected capture result ${show(result)}`);
        }
        apply(storage, outcome);
        trace?.({ op: "capture", nowMs, request, result }, storage);
        break;
      }
      case "write": {
        const mine = current.get(writer) ?? 0;
        const history = granted.get(writer)!;
        const roll = random();
        let captureId: number;
        if (roll < 0.6) {
          captureId = mine;
        } else if (roll < 0.75 && history.length > 0) {
          captureId = pick(random, history);
        } else if (roll < 0.85) {
          captureId = 0;
        } else captureId = randomInt(random, before.nextRound);
        // Aim inside the writer's capture most of the time.
        const held = truth.rounds.get(captureId);
        const start = held !== undefined && random() < 0.8
          ? held.start + randomInt(random, held.end - held.start)
          : randomInt(random, SIZE + 1);
        const count = random() < 0.7 ? 1 : 1 + randomInt(random, 4);
        const values: Uint8Array[] = [];
        for (let index = 0; index < count; index += 1) {
          const existing = truth.firstWrite.get(start + index);
          // Replays of what is already there, byte for byte.
          values.push(
            existing !== undefined && random() < 0.5
              ? new Uint8Array(existing.value)
              : randomBytes(random),
          );
        }
        const request: WriteRequest = { start, values, captureId };
        const range = core.writeScope(before, request);
        const view = range === null ? core.EMPTY_WRITE_VIEW : {
          existing: new Map(
            written(storage, range).map((row) => [row.offset, row.value]),
          ),
          captures: overlapping(storage, range),
        };
        const outcome = core.write(before, request, view, nowMs);
        const result = outcome.result;

        // Every offset before the one that refused must itself be writable.
        const passable = (upTo: number) => {
          for (let offset = start; offset < upTo; offset += 1) {
            if (truth.firstWrite.has(offset)) {
              fail(step, `offset ${offset} was written but not reported`);
            }
            if (truthRound(truth, offset) !== captureId) {
              fail(step, `offset ${offset} was stale but not reported`);
            }
          }
        };

        if (result.ok) {
          if (result.start !== start || result.end !== start + count) {
            fail(step, "a write reported the wrong range");
          }
          passable(start + count);
          for (let index = 0; index < count; index += 1) {
            if (start + index <= before.trimmedThrough) {
              fail(step, "a write landed below the trim mark");
            }
            truth.firstWrite.set(start + index, {
              value: values[index],
              round: captureId,
            });
          }
          seen.add(captureId === 0 ? "unsafe-write" : "write");
          if (count > 1) {
            seen.add("batch-write");
          }
        } else if (result.code === "ALREADY_WRITTEN") {
          passable(result.offset);
          const first = truth.firstWrite.get(result.offset);
          if (first === undefined) {
            fail(step, `ALREADY_WRITTEN for unwritten ${result.offset}`);
          } else if (
            result.sameValue !==
              equals(first.value, values[result.offset - start])
          ) {
            fail(step, "ALREADY_WRITTEN.sameValue is wrong");
          }
          seen.add(result.sameValue ? "replay-same" : "replay-different");
        } else if (result.code === "CAPTURE_STALE") {
          passable(result.offset);
          if (truth.firstWrite.has(result.offset)) {
            fail(step, "CAPTURE_STALE on a written register");
          }
          const effective = truthRound(truth, result.offset);
          if (result.round !== effective || effective === captureId) {
            fail(
              step,
              `CAPTURE_STALE with round ${result.round}, ` +
                `effective ${effective}, captureId ${captureId}`,
            );
          }
          const own = truth.rounds.get(captureId);
          if (
            own !== undefined && own.start <= result.offset &&
            result.offset < own.end && !(effective > captureId)
          ) {
            fail(step, "a covered capture went stale without a higher round");
          }
          seen.add(captureId === 0 ? "unsafe-refused" : "stale-write");
        } else if (result.code === "TRIMMED") {
          if (start > before.trimmedThrough) {
            fail(step, "a live write TRIMMED");
          }
        } else if (result.code === "OUT_OF_RANGE") {
          if (start + count <= before.size) {
            fail(step, "a legal write was OUT_OF_RANGE");
          }
        } else if (result.code === "UNALLOCATED") {
          if (before.allocated) {
            fail(step, "UNALLOCATED after alloc");
          }
        } else if (result.code === "INVALID") {
          if (captureId < before.nextRound) {
            fail(step, `a well-formed write was INVALID: ${result.message}`);
          }
        } else {
          fail(step, `unexpected write result ${show(result)}`);
        }
        apply(storage, outcome);
        trace?.({ op: "write", nowMs, request, result }, storage);
        break;
      }
      case "read": {
        const start = randomInt(random, SIZE + 1);
        const count = 1 + randomInt(random, 8);
        const maxBytes = 1 + randomInt(random, 12);
        const request = { start, count, maxBytes };
        const result = modelRead(storage, request);
        trace?.({ op: "read", nowMs, request, result }, storage);
        if (!result.ok) {
          if (result.code === "TRIMMED" && start > before.trimmedThrough) {
            fail(step, "a live read was TRIMMED");
          }
          if (result.code === "OUT_OF_RANGE" && start < before.size) {
            fail(step, "a legal read was OUT_OF_RANGE");
          }
          if (result.code === "INVALID") {
            fail(step, "a legal read was INVALID");
          }
          break;
        }
        const registers = result.registers;
        if (registers.length === 0) {
          fail(step, "a read returned nothing");
        }
        if (registers.length > count) {
          fail(step, "a read exceeded its count");
        }
        let total = 0;
        for (const [index, register] of registers.entries()) {
          if (register.offset !== start + index) {
            fail(step, "a read skipped an offset");
          }
          const first = truth.firstWrite.get(register.offset);
          if (first !== undefined) {
            if (
              register.state !== "written" ||
              register.round !== first.round ||
              register.value === undefined ||
              !equals(register.value, first.value)
            ) {
              fail(step, `offset ${register.offset} read ${show(register)}`);
            } else {
              total += register.value.byteLength;
              // Only the first register may exceed the budget on its own.
              if (register.offset > start && total > maxBytes) {
                fail(step, "a read overshot its byte budget");
              }
            }
          } else {
            const round = truthRound(truth, register.offset);
            const state = round === 0 ? "unwritten" : "captured";
            if (
              register.state !== state || register.round !== round ||
              register.value !== undefined
            ) {
              fail(step, `offset ${register.offset} read ${show(register)}`);
            }
          }
        }
        const end = registers[registers.length - 1].offset + 1;
        if (end < Math.min(start + count, SIZE)) {
          // A short window must have been cut by the next value's size.
          const next = truth.firstWrite.get(end);
          if (next === undefined || total + next.value.byteLength <= maxBytes) {
            fail(step, "a read stopped early without cause");
          }
          seen.add("read-budget");
        }
        break;
      }
      case "trim": {
        // Creep forward, so most of a run still has live registers to fight
        // over; -1 and 0 steps exercise idempotence.
        const through = Math.max(
          0,
          before.trimmedThrough + randomInt(random, 4) - 1,
        );
        const scope = core.trimScope(before, { through });
        const view = scope === null ? core.EMPTY_TRIM_VIEW : {
          writtenThrough: [...storage.registers.keys()].filter((offset) =>
            offset <= scope
          )
            .length,
        };
        const outcome = core.trim(before, { through }, view);
        const result = outcome.result;
        if (result.ok) {
          if (
            result.trimmedThrough !== Math.max(through, before.trimmedThrough)
          ) {
            fail(step, "trim reported the wrong mark");
          }
          let deleted = 0;
          for (const offset of truth.firstWrite.keys()) {
            if (offset > before.trimmedThrough && offset <= through) {
              deleted += 1;
            }
          }
          if (result.deleted !== deleted) {
            fail(step, `trim deleted ${result.deleted}, model ${deleted}`);
          }
          if (through > before.trimmedThrough) seen.add("trim");
          else seen.add("trim-idempotent");
        } else if (result.code === "UNALLOCATED") {
          if (before.allocated) fail(step, "UNALLOCATED after alloc");
        } else if (result.code === "OUT_OF_RANGE") {
          if (through <= before.size - 1) {
            fail(step, "a legal trim was OUT_OF_RANGE");
          }
        } else {
          fail(step, `unexpected trim result ${show(result)}`);
        }
        apply(storage, outcome);
        trace?.({ op: "trim", nowMs, request: { through }, result }, storage);
        break;
      }
    }

    const meta = storage.meta;
    if (meta.nextRound < before.nextRound) fail(step, "nextRound went back");
    if (meta.trimmedThrough < before.trimmedThrough) {
      fail(step, "the trim mark went back");
    }
    if (meta.allocated && meta.size !== SIZE) fail(step, "size changed");
    if (
      meta.trimmedThrough < -1 ||
      (meta.allocated && meta.trimmedThrough > meta.size - 1)
    ) {
      fail(step, "the trim mark left the segment");
    }
    // Written values never change, and nothing below the mark survives.
    let live = 0;
    for (const [offset, first] of truth.firstWrite) {
      const row = storage.registers.get(offset);
      if (offset <= meta.trimmedThrough) {
        if (row !== undefined) fail(step, `trimmed ${offset} is still stored`);
        continue;
      }
      live += 1;
      if (
        row === undefined || row.round !== first.round ||
        !equals(row.value, first.value)
      ) {
        fail(step, `register ${offset} changed: ${show(row)}`);
      }
    }
    if (storage.registers.size !== live) {
      fail(step, "storage holds a register the model never accepted");
    }
    if (meta.writtenCount !== live) {
      fail(step, `writtenCount ${meta.writtenCount}, model ${live}`);
    }
    // Every register ever accepted, trimmed or not, and nothing else.
    if (meta.writes !== truth.firstWrite.size) {
      fail(step, `writes ${meta.writes}, model ${truth.firstWrite.size}`);
    }
    if (meta.writes < before.writes) fail(step, "writes went back");
    for (const row of storage.captures) {
      if (row.end - 1 <= meta.trimmedThrough) {
        fail(step, "a capture wholly below the mark is still stored");
      }
    }
    if (storage.captures.length > LIMITS.liveCaptures) {
      fail(step, `${storage.captures.length} capture rows were never pruned`);
    }
    // Pruning is invisible: stored captures give every live offset the same
    // effective round as the full history does.
    for (
      let offset = meta.trimmedThrough + 1;
      offset < meta.size;
      offset += 1
    ) {
      if (
        core.effectiveRound(storage.captures, offset) !==
          truthRound(truth, offset)
      ) {
        fail(step, `offset ${offset} has a different effective round`);
      }
    }
  }
}
