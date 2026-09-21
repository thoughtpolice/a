// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The link arithmetic: positions, the sealing decision, trim plans, the
 * allocation metadata, and the `linkSize` bounds.
 *
 * @module
 */

import {
  capacity,
  checkLinkSize,
  decodeLinkMetadata,
  encodeLinkMetadata,
  type Link,
  LINK_LIMITS,
  linkName,
  offsetOf,
  place,
  sameLink,
  trimPlan,
} from "@journal/links";
import { LIMITS } from "@journal/types";
import { assert, assertCode, assertEquals } from "@celld/assert";

const SIZE = 8;

function link(
  index: number,
  firstSeq: number,
  sealedAt: number | null = null,
  term = 1,
): Link {
  return { link: index, firstSeq, captureId: 1, sealedAt, term };
}

Deno.test("links are named after the log, from index 0", () => {
  assertEquals(linkName("orders", 0), "orders.0");
  assertEquals(linkName("orders", 12), "orders.12");
});

Deno.test("an unsealed link holds a whole link size; a sealed one its seal", () => {
  assertEquals(capacity(link(0, 1), SIZE), SIZE);
  assertEquals(capacity(link(0, 1, 5), SIZE), 5);
  assertEquals(capacity(link(0, 1, 0), SIZE), 0);
});

Deno.test("a sequence's offset is its distance from the link's first", () => {
  const first = link(0, 1);
  assertEquals(offsetOf(first, 1, SIZE), 0);
  assertEquals(offsetOf(first, 8, SIZE), 7);
  assertEquals(offsetOf(first, 9, SIZE), null, "past the link");
  assertEquals(offsetOf(first, 0, SIZE), null, "before the link");
  const sealed = link(1, 9, 3);
  assertEquals(offsetOf(sealed, 11, SIZE), 2);
  assertEquals(offsetOf(sealed, 12, SIZE), null, "past the seal");
  assertEquals(offsetOf(link(2, 12, 0), 12, SIZE), null, "an empty seal");
});

Deno.test("the first batch opens link 0 at head", () => {
  assertEquals(place(null, 1, 3, 1, SIZE), {
    kind: "open",
    index: 0,
    firstSeq: 1,
    seal: null,
  });
});

Deno.test("a batch that fits goes where head is", () => {
  const last = link(0, 1);
  assertEquals(place(last, 1, SIZE, 1, SIZE), {
    kind: "append",
    link: last,
    offset: 0,
  });
  assertEquals(place(last, 4, 5, 1, SIZE), {
    kind: "append",
    link: last,
    offset: 3,
  });
});

Deno.test("a batch that does not fit seals the link and opens the next", () => {
  const last = link(0, 1);
  assertEquals(place(last, 4, 6, 1, SIZE), {
    kind: "open",
    index: 1,
    firstSeq: 4,
    seal: { link: last, sealedAt: 3 },
  });
  // A full link is sealed at its own end.
  assertEquals(place(last, 9, 1, 1, SIZE), {
    kind: "open",
    index: 1,
    firstSeq: 9,
    seal: { link: last, sealedAt: SIZE },
  });
});

Deno.test("a new term seals the link even when the batch would fit", () => {
  const last = link(3, 20, null, 1);
  assertEquals(place(last, 22, 1, 2, SIZE), {
    kind: "open",
    index: 4,
    firstSeq: 22,
    seal: { link: last, sealedAt: 2 },
  });
  // Nothing written under the old term yet: the seal is empty.
  assertEquals(place(last, 20, 1, 2, SIZE), {
    kind: "open",
    index: 4,
    firstSeq: 20,
    seal: { link: last, sealedAt: 0 },
  });
});

Deno.test("a batch larger than a link is TOO_LARGE, not split", () => {
  const placed = place(link(0, 1), 1, SIZE + 1, 1, SIZE);
  assert(placed.kind === "reply", "an oversized batch is answered");
  assertCode(placed.result, "TOO_LARGE");
  // At the production minimum, the largest batch always fits a new link.
  assert(
    LINK_LIMITS.minSize >= LIMITS.batchRecords,
    "the minimum link holds the largest batch",
  );
  const full = place(
    link(0, 1),
    2,
    LIMITS.batchRecords,
    1,
    LINK_LIMITS.minSize,
  );
  assertEquals(full.kind, "open");
});

Deno.test("placing at a head the last link cannot hold is a bug", () => {
  for (const head of [0, 1 + SIZE + 1]) {
    let threw = false;
    try {
      place(link(0, 1), head, 1, 1, SIZE);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, `head ${head} was placed`);
  }
});

Deno.test("a sealed last link is followed, never written", () => {
  assertEquals(place(link(0, 1, 5), 6, 1, 1, SIZE), {
    kind: "open",
    index: 1,
    firstSeq: 6,
    seal: null,
  });
});

Deno.test("a trim drops whole links below the mark and cuts the boundary", () => {
  const links = [link(0, 1, 5), link(1, 6, 0), link(2, 6), link(3, 14)];
  assertEquals(trimPlan(links, 3, SIZE), [
    { link: links[0], through: 2, drop: false },
  ]);
  assertEquals(trimPlan(links, 5, SIZE), [
    { link: links[0], through: SIZE - 1, drop: true },
    { link: links[1], through: SIZE - 1, drop: true },
  ]);
  assertEquals(trimPlan(links, 10, SIZE), [
    { link: links[0], through: SIZE - 1, drop: true },
    { link: links[1], through: SIZE - 1, drop: true },
    { link: links[2], through: 4, drop: false },
  ]);
  assertEquals(trimPlan(links, 13, SIZE).map((step) => step.drop), [
    true,
    true,
    true,
  ]);
  assertEquals(trimPlan(links, 0, SIZE), []);
  assertEquals(trimPlan([], 10, SIZE), []);
});

Deno.test("the last link keeps its row even when it is wholly trimmed", () => {
  const links = [link(0, 1, 8), link(1, 9)];
  assertEquals(trimPlan(links, 16, SIZE), [
    { link: links[0], through: SIZE - 1, drop: true },
    { link: links[1], through: SIZE - 1, drop: false },
  ]);
});

Deno.test("link metadata round-trips and nothing else decodes", () => {
  const metadata = { log: "orders", index: 3, firstSeq: 17, term: 2 };
  const bytes = encodeLinkMetadata(metadata);
  assertEquals(decodeLinkMetadata(bytes), metadata);
  assert(sameLink(metadata, { ...metadata }), "equal metadata is the same");
  for (
    const other of [
      { ...metadata, log: "other" },
      { ...metadata, index: 4 },
      { ...metadata, firstSeq: 18 },
      { ...metadata, term: 3 },
    ]
  ) {
    assert(!sameLink(metadata, other), JSON.stringify(other));
  }
  const text = (value: string) => new TextEncoder().encode(value);
  for (
    const bad of [
      new Uint8Array([0xff]),
      text("[]"),
      text("null"),
      text('{"log":"orders","index":3,"firstSeq":17}'),
      text('{"log":"orders","index":3,"firstSeq":17,"term":2,"x":1}'),
      text('{"log":"orders","index":3.5,"firstSeq":17,"term":2}'),
      text('{"chain":"orders","index":3,"size":8}'),
    ]
  ) {
    assertEquals(decodeLinkMetadata(bad), null);
  }
});

Deno.test("linkSize is optional and bounded", () => {
  assertEquals(checkLinkSize(undefined), undefined);
  assertEquals(checkLinkSize(LINK_LIMITS.testMinSize), 8);
  assertEquals(checkLinkSize(LINK_LIMITS.maxSize), 65_536);
  assertEquals(checkLinkSize(LINK_LIMITS.defaultSize), 4096);
  for (const bad of [7, 65_537, 64.5, "64", null, Number.NaN]) {
    assertCode(checkLinkSize(bad), "INVALID");
  }
});
