// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Segment chains: the paper's contiguous address space, as a client-side
 * convention over fixed-size segments.
 *
 * A chain named `c` is the segments `c.0`, `c.1`, `c.2`, ..., all of the same
 * size, and global address `a` is offset `a % size` of segment `c.<a / size>`.
 * Each link's allocation metadata says which chain and index it belongs to,
 * and the size, as the UTF-8 JSON `{"chain": c, "index": i, "size": s}`; the
 * size is fixed for the whole chain, and whoever allocates `c.0` fixes it.
 *
 * Nothing here is a service. The helper runs over an abstract resolver from a
 * segment name to its API, so the same code runs in a Worker
 * (`(name) => env.SEGMENTS.getByName(name)`), inside another Durable Object,
 * and in a Deno test over the fake segment. Every outcome a caller branches
 * on is a result union; a transport failure from the resolver's stub is
 * thrown through untouched, and every method is safe to repeat after one.
 *
 * Links are allocated in order: `allocate(i)` refuses unless `i - 1` is
 * already an allocated link of this chain. Allocation is permanent, so the
 * allocated links of a chain are always a prefix `0..n-1`, which is what lets
 * `tail` stop at the first gap.
 *
 * @module
 */

import {
  type Invalid,
  LIMITS,
  type SegmentAPI,
  type StatusOk,
  type TooLarge,
  type Unallocated,
} from "@wormspace/segment/types";

/** Resolves a segment name to its API: a Durable Object stub, or a fake. */
export type Segments = (name: string) => SegmentAPI;

/**
 * The largest link index. Its ten digits, plus the dot, leave a chain name
 * 117 characters of the 128 a segment name may have; and with the largest
 * segment, `(MAX_CHAIN_INDEX + 1) * LIMITS.maxSize` is 2^48, so every global
 * address is a safe integer.
 */
export const MAX_CHAIN_INDEX = 0xffff_ffff;

/** A segment name, less room for `.` and the ten digits of any index. */
export const CHAIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,116}$/;

/** What every link's metadata says about it. */
export interface ChainMetadata {
  chain: string;
  index: number;
  size: number;
}

/**
 * A segment under a link's name that is not that link: its metadata is not
 * chain metadata, names another chain or index, or disagrees on the size.
 * `found` is the decoded metadata, or `null` when it does not decode.
 */
export interface ChainMismatch {
  ok: false;
  code: "CHAIN_MISMATCH";
  message: string;
  name: string;
  expected: ChainMetadata;
  found: ChainMetadata | null;
}

/** One allocated link and a status snapshot taken after it was found. */
export interface ChainLink {
  index: number;
  name: string;
  status: StatusOk;
}

export interface AllocateOk extends ChainLink {
  ok: true;
  /** Whether this call allocated the link, rather than finding it. */
  created: boolean;
}

export interface TailOk {
  ok: true;
  /** The last allocated link, or `null` when the chain has none. */
  tail: ChainLink | null;
}

export type AllocateResult =
  | AllocateOk
  | ChainMismatch
  | Unallocated
  | Invalid
  | TooLarge;
export type TailResult = TailOk | ChainMismatch | Invalid;
export type OpenResult =
  | { ok: true; chain: Chain }
  | ChainMismatch
  | Unallocated
  | Invalid;

function invalid(message: string): Invalid {
  return { ok: false, code: "INVALID", message };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isIndex(value: unknown): value is number {
  return isCount(value) && value >= 0 && value <= MAX_CHAIN_INDEX;
}

function isSize(value: unknown): value is number {
  return isCount(value) && value >= 1 && value <= LIMITS.maxSize;
}

function isChainName(value: unknown): value is string {
  return typeof value === "string" && CHAIN_NAME_PATTERN.test(value);
}

const INDEX_MESSAGE = `index must be an integer in [0, ${MAX_CHAIN_INDEX}]`;
const SIZE_MESSAGE = `size must be an integer in [1, ${LIMITS.maxSize}]`;
const CHAIN_MESSAGE = `chain names must match ${CHAIN_NAME_PATTERN}`;

/** The segment name of link `index`: `<chain>.<index>`, decimal, unpadded. */
export function segmentName(
  chain: string,
  index: number,
): { ok: true; name: string } | Invalid {
  if (!isChainName(chain)) return invalid(CHAIN_MESSAGE);
  if (!isIndex(index)) return invalid(INDEX_MESSAGE);
  return { ok: true, name: `${chain}.${index}` };
}

/** The global address of `offset` in link `index`: `index * size + offset`. */
export function chainAddress(
  index: number,
  offset: number,
  size: number,
): { ok: true; address: number } | Invalid {
  if (!isSize(size)) return invalid(SIZE_MESSAGE);
  if (!isIndex(index)) return invalid(INDEX_MESSAGE);
  if (!isCount(offset) || offset < 0 || offset >= size) {
    return invalid(`offset must be an integer in [0, ${size - 1}]`);
  }
  return { ok: true, address: index * size + offset };
}

/** The link and offset holding a global address; `chainAddress` inverted. */
export function chainPosition(
  address: number,
  size: number,
): { ok: true; index: number; offset: number } | Invalid {
  if (!isSize(size)) return invalid(SIZE_MESSAGE);
  const end = (MAX_CHAIN_INDEX + 1) * size;
  if (!isCount(address) || address < 0 || address >= end) {
    return invalid(`address must be an integer in [0, ${end - 1}]`);
  }
  const offset = address % size;
  return { ok: true, index: (address - offset) / size, offset };
}

/** The canonical metadata bytes of a link. */
export function encodeChainMetadata(
  metadata: ChainMetadata,
): { ok: true; metadata: Uint8Array } | Invalid {
  const { chain, index, size } = metadata;
  if (!isChainName(chain)) return invalid(CHAIN_MESSAGE);
  if (!isIndex(index)) return invalid(INDEX_MESSAGE);
  if (!isSize(size)) return invalid(SIZE_MESSAGE);
  const text = JSON.stringify({ chain, index, size });
  return { ok: true, metadata: new TextEncoder().encode(text) };
}

/**
 * Reads a link's metadata back. Anything but a UTF-8 JSON object with exactly
 * a valid `chain`, `index`, and `size` is not a chain segment.
 */
export function decodeChainMetadata(
  bytes: Uint8Array,
): { ok: true; metadata: ChainMetadata } | Invalid {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return invalid("chain metadata must be UTF-8 JSON");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) {
    return invalid("chain metadata must be a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.join(",") !== "chain,index,size") {
    return invalid("chain metadata has exactly chain, index, and size");
  }
  const { chain, index, size } = fields;
  if (!isChainName(chain)) return invalid(CHAIN_MESSAGE);
  if (!isIndex(index)) return invalid(INDEX_MESSAGE);
  if (!isSize(size)) return invalid(SIZE_MESSAGE);
  return { ok: true, metadata: { chain, index, size } };
}

/** Whether a link's decoded metadata is exactly what the chain expects. */
function matches(found: ChainMetadata, expected: ChainMetadata): boolean {
  return found.chain === expected.chain && found.index === expected.index &&
    found.size === expected.size;
}

function mismatch(
  name: string,
  expected: ChainMetadata,
  found: ChainMetadata | null,
  why: string,
): ChainMismatch {
  return {
    ok: false,
    code: "CHAIN_MISMATCH",
    message: `segment ${name} is not link ${expected.index} of chain ` +
      `${expected.chain}: ${why}`,
    name,
    expected,
    found,
  };
}

/**
 * Checks an allocated segment against the link it should be: its metadata
 * must decode to exactly this chain, index, and size, and its own size must
 * agree.
 */
function verify(
  name: string,
  expected: ChainMetadata,
  size: number,
  metadata: Uint8Array | null,
): ChainMismatch | null {
  const decoded = decodeChainMetadata(metadata ?? new Uint8Array(0));
  if (!decoded.ok) {
    return mismatch(name, expected, null, decoded.message);
  }
  if (!matches(decoded.metadata, expected)) {
    return mismatch(
      name,
      expected,
      decoded.metadata,
      `its metadata says ${JSON.stringify(decoded.metadata)}`,
    );
  }
  if (size !== expected.size) {
    return mismatch(
      name,
      expected,
      decoded.metadata,
      `it holds ${size} registers`,
    );
  }
  return null;
}

/** One chain: its name, its fixed segment size, and the resolver. */
export class Chain {
  readonly #segments: Segments;
  readonly name: string;
  readonly size: number;

  private constructor(segments: Segments, name: string, size: number) {
    this.#segments = segments;
    this.name = name;
    this.size = size;
  }

  /**
   * A handle for a chain whose size the caller decides: the one that will
   * allocate link 0, or one that already knows the size.
   */
  static create(
    segments: Segments,
    name: string,
    size: number,
  ): { ok: true; chain: Chain } | Invalid {
    if (!isChainName(name)) return invalid(CHAIN_MESSAGE);
    if (!isSize(size)) return invalid(SIZE_MESSAGE);
    return { ok: true, chain: new Chain(segments, name, size) };
  }

  /**
   * A handle for an existing chain, with the size link 0 was allocated with.
   * Costs one `status`.
   */
  static async open(segments: Segments, name: string): Promise<OpenResult> {
    if (!isChainName(name)) return invalid(CHAIN_MESSAGE);
    const first = `${name}.0`;
    const status = await segments(first).status();
    if (!status.allocated) {
      return {
        ok: false,
        code: "UNALLOCATED",
        message: `chain ${name} has no link 0`,
      };
    }
    const expected = { chain: name, index: 0, size: status.size };
    const wrong = verify(first, expected, status.size, status.metadata);
    if (wrong !== null) return wrong;
    return { ok: true, chain: new Chain(segments, name, status.size) };
  }

  /** The segment name of link `index`. */
  segmentName(index: number): { ok: true; name: string } | Invalid {
    return segmentName(this.name, index);
  }

  /** The global address of `offset` in link `index`. */
  address(
    index: number,
    offset: number,
  ): { ok: true; address: number } | Invalid {
    return chainAddress(index, offset, this.size);
  }

  /** The link and offset holding a global address. */
  position(
    address: number,
  ): { ok: true; index: number; offset: number } | Invalid {
    return chainPosition(address, this.size);
  }

  #expected(index: number): ChainMetadata {
    return { chain: this.name, index, size: this.size };
  }

  /**
   * Allocates link `index`, or finds it. Allocation is first-writer-wins per
   * link, so any number of clients may race to extend the chain: exactly one
   * creates the link, and every other one (including the creator replaying a
   * lost reply) finds it with `created: false` after checking that the
   * segment there really is this link. Link `index - 1` must already exist,
   * or the result is `UNALLOCATED` and nothing is allocated.
   *
   * Costs a `status` of the predecessor (none for link 0), the `alloc`, and a
   * `status` of the link for the reply.
   */
  async allocate(index: number, allocator?: string): Promise<AllocateResult> {
    const named = this.segmentName(index);
    if (!named.ok) return named;
    const name = named.name;
    if (index > 0) {
      const previous = `${this.name}.${index - 1}`;
      const before = await this.#segments(previous).status();
      if (!before.allocated) {
        return {
          ok: false,
          code: "UNALLOCATED",
          message: `link ${index - 1} of chain ${this.name} is not allocated`,
        };
      }
      const wrong = verify(
        previous,
        this.#expected(index - 1),
        before.size,
        before.metadata,
      );
      if (wrong !== null) return wrong;
    }
    const expected = this.#expected(index);
    const encoded = encodeChainMetadata(expected);
    if (!encoded.ok) return encoded;
    const segment = this.#segments(name);
    const result = await segment.alloc({
      size: this.size,
      metadata: encoded.metadata,
      ...(allocator === undefined ? {} : { allocator }),
    });
    let created: boolean;
    if (result.ok) {
      created = true;
    } else if (result.code === "ALREADY_ALLOCATED") {
      const wrong = verify(name, expected, result.size, result.metadata);
      if (wrong !== null) return wrong;
      created = false;
    } else {
      return result;
    }
    return { ok: true, index, name, created, status: await segment.status() };
  }

  /**
   * Finds the last allocated link, walking forward from `fromIndex` (default
   * 0) to the first unallocated one; one `status` per link walked, so pass
   * the last index you know. A hint past the end walks back instead.
   */
  async tail(options: { fromIndex?: number } = {}): Promise<TailResult> {
    const from = options.fromIndex ?? 0;
    if (!isIndex(from)) return invalid(INDEX_MESSAGE);
    let last: ChainLink | null = null;
    const look = async (
      index: number,
    ): Promise<ChainLink | ChainMismatch | null> => {
      const name = `${this.name}.${index}`;
      const status = await this.#segments(name).status();
      if (!status.allocated) return null;
      const wrong = verify(
        name,
        this.#expected(index),
        status.size,
        status.metadata,
      );
      return wrong ?? { index, name, status };
    };
    for (let index = from; index <= MAX_CHAIN_INDEX; index += 1) {
      const link = await look(index);
      if (link === null) break;
      if ("code" in link) return link;
      last = link;
    }
    if (last === null) {
      for (let index = from - 1; index >= 0; index -= 1) {
        const link = await look(index);
        if (link === null) continue;
        if ("code" in link) return link;
        last = link;
        break;
      }
    }
    return { ok: true, tail: last };
  }
}
