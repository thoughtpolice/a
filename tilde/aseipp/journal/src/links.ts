// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal's chain of segment links, as pure arithmetic.
 *
 * A journal's records live in write-once segments named `<log>.<index>`,
 * each `linkSize` registers long. Link `i` stores the records from its
 * `firstSeq` on, one per register from offset 0, so a record's position is
 * `seq - firstSeq` in the link with the largest `firstSeq` at or below it.
 *
 * Two rules keep that mapping trivial and every append a single atomic
 * segment write:
 *
 *   - **A batch never spans links.** When a batch does not fit in what is left
 *     of the current link, the link is *sealed* at the offset it reached
 *     (`sealedAt`: its remaining registers are never used, and no sequence is
 *     ever assigned to them) and the batch goes to offset 0 of the next one.
 *   - **A link holds one term.** Every record in a link was appended under the
 *     term the link was opened with, so the term is stored once, in the link,
 *     rather than in every register. When the term changes, the next append
 *     seals the current link the same way and opens a new one.
 *
 * A sealed link may be empty (`sealedAt === 0`), so two links can share a
 * `firstSeq`; the later one is the one holding the records.
 *
 * @module
 */

import { type Invalid, LIMITS, type TooLarge } from "./types.ts";

/** Link sizes, in registers. */
export const LINK_LIMITS = {
  /** The size a journal gets when the first acquire does not choose one. */
  defaultSize: 4096,
  /**
   * The smallest size a production journal should use: one largest batch, so
   * every batch fits in an empty link.
   */
  minSize: LIMITS.batchRecords,
  /**
   * The smallest size accepted at all, so tests can seal and roll over
   * cheaply. Below `minSize`, a batch larger than a link is `TOO_LARGE`.
   */
  testMinSize: 8,
  /** A segment's largest size. */
  maxSize: 65_536,
} as const;

/** One link, as the journal's link table holds it. */
export interface Link {
  /** The link's index, which is also its segment's name suffix. */
  link: number;
  /** The sequence stored at offset 0. */
  firstSeq: number;
  /** The round the journal holds the whole segment with. */
  captureId: number;
  /** The offset the link was sealed at, or `null` while it can grow. */
  sealedAt: number | null;
  /** The term every record in the link was appended under. */
  term: number;
}

/** Where a batch goes. */
export type Placement =
  | { kind: "append"; link: Link; offset: number }
  | {
    kind: "open";
    index: number;
    firstSeq: number;
    /** The link to seal first, at `sealedAt`; `null` for the first link. */
    seal: { link: Link; sealedAt: number } | null;
  }
  | { kind: "reply"; result: TooLarge };

/** One segment trim a journal trim needs, and whether its row goes too. */
export interface LinkTrim {
  link: Link;
  /** The offset to trim through. */
  through: number;
  /** The whole link is below the mark: its row can be dropped. */
  drop: boolean;
}

/** The segment holding link `index` of `log`. */
export function linkName(log: string, index: number): string {
  return `${log}.${index}`;
}

/** How many sequences the link holds, or can hold while unsealed. */
export function capacity(link: Link, linkSize: number): number {
  return link.sealedAt ?? linkSize;
}

/**
 * The offset of `seq` in `link`, or `null` when the link does not hold it.
 * An unsealed link's range ends at `linkSize`; the caller bounds it by head.
 */
export function offsetOf(
  link: Link,
  seq: number,
  linkSize: number,
): number | null {
  const offset = seq - link.firstSeq;
  return offset >= 0 && offset < capacity(link, linkSize) ? offset : null;
}

/**
 * Places a batch of `count` records at `head`, appended under `term`, after
 * the journal's `last` link. The batch goes into `last` only when the term
 * matches and it fits; otherwise `last` is sealed where `head` left it and
 * the batch opens the next link at offset 0.
 */
export function place(
  last: Link | null,
  head: number,
  count: number,
  term: number,
  linkSize: number,
): Placement {
  if (count > linkSize) {
    return {
      kind: "reply",
      result: {
        ok: false,
        code: "TOO_LARGE",
        message: `batch of ${count} exceeds the link size ${linkSize}`,
      },
    };
  }
  if (last === null) {
    return { kind: "open", index: 0, firstSeq: head, seal: null };
  }
  const offset = head - last.firstSeq;
  if (offset < 0 || offset > capacity(last, linkSize)) {
    throw new RangeError(
      `head ${head} is outside link ${last.link} ` +
        `(first ${last.firstSeq}, capacity ${capacity(last, linkSize)})`,
    );
  }
  if (last.sealedAt !== null) {
    if (offset !== last.sealedAt) {
      throw new RangeError(
        `head ${head} is not at the seal of link ${last.link}`,
      );
    }
    return { kind: "open", index: last.link + 1, firstSeq: head, seal: null };
  }
  if (last.term === term && offset + count <= linkSize) {
    return { kind: "append", link: last, offset };
  }
  return {
    kind: "open",
    index: last.link + 1,
    firstSeq: head,
    seal: { link: last, sealedAt: offset },
  };
}

/**
 * The segment trims that realise a journal trim through `through`, over the
 * links in index order. Every link wholly at or below the mark is trimmed
 * entirely and its row dropped, except the last link, whose row is what the
 * journal recovers its head from; the link holding the mark is trimmed
 * through it.
 */
export function trimPlan(
  links: readonly Link[],
  through: number,
  linkSize: number,
): LinkTrim[] {
  const plan: LinkTrim[] = [];
  for (const [position, link] of links.entries()) {
    const last = position === links.length - 1;
    const lastSeq = link.firstSeq + capacity(link, linkSize) - 1;
    if (!last && lastSeq <= through) {
      plan.push({ link, through: linkSize - 1, drop: true });
      continue;
    }
    if (link.firstSeq <= through) {
      plan.push({
        link,
        through: Math.min(through - link.firstSeq, linkSize - 1),
        drop: false,
      });
    }
    break;
  }
  return plan;
}

/** What a link's segment was allocated with, beside its size. */
export interface LinkMetadata {
  log: string;
  index: number;
  firstSeq: number;
  term: number;
}

/** The UTF-8 JSON a link's segment is allocated with. */
export function encodeLinkMetadata(metadata: LinkMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    log: metadata.log,
    index: metadata.index,
    firstSeq: metadata.firstSeq,
    term: metadata.term,
  }));
}

/** Reads link metadata back, or `null` for anything else. */
export function decodeLinkMetadata(bytes: Uint8Array): LinkMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { log, index, firstSeq, term, ...rest } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(rest).length !== 0 || typeof log !== "string" ||
    !Number.isSafeInteger(index) || !Number.isSafeInteger(firstSeq) ||
    !Number.isSafeInteger(term)
  ) {
    return null;
  }
  return {
    log,
    index: index as number,
    firstSeq: firstSeq as number,
    term: term as number,
  };
}

/** Whether two link metadata values describe the same link. */
export function sameLink(left: LinkMetadata, right: LinkMetadata): boolean {
  return left.log === right.log && left.index === right.index &&
    left.firstSeq === right.firstSeq && left.term === right.term;
}

/**
 * Validates the optional `linkSize` of an acquire: `undefined` when absent,
 * the size when it is an integer in `[testMinSize, maxSize]`.
 */
export function checkLinkSize(value: unknown): number | undefined | Invalid {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < LINK_LIMITS.testMinSize || value > LINK_LIMITS.maxSize
  ) {
    const { testMinSize, maxSize } = LINK_LIMITS;
    return {
      ok: false,
      code: "INVALID",
      message: `linkSize must be an integer in [${testMinSize}, ${maxSize}]`,
    };
  }
  return value;
}
