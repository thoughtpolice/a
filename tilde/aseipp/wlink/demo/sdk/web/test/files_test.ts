// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "../assert.ts";
import {
  compareCodePoints,
  directoryName,
  fileName,
  Listing,
  MAX_NAME,
  RecordingMirror,
  Vfs,
} from "../files.ts";

const encoder = new TextEncoder();
const p = (path: string) => encoder.encode(path);
const decoder = new TextDecoder();

/** A fake IWAD: the contract test only reads its first four bytes and its size. */
const WAD = (() => {
  const data = new Uint8Array(64);
  data.set(encoder.encode("IWAD"));
  return data;
})();

function mounted(): Vfs {
  const vfs = new Vfs();
  assertEquals(vfs.mountReadonly("doom2.wad", WAD), true);
  return vfs;
}

function write(vfs: Vfs, path: string, text: string): void {
  const fd = vfs.open(p(path), true);
  assert(fd >= 0, `open ${path}`);
  assertEquals(vfs.writeAt(fd, 0n, encoder.encode(text)), text.length);
  vfs.close(fd);
}

function names(entries: Listing[] | null): string[] {
  assert(entries !== null, "expected a directory");
  return entries.map((entry) => `${entry.name} ${entry.size} ${entry.directory}`);
}

Deno.test("what is and is not a path in the virtual root", () => {
  assertEquals(fileName(p("a.txt")), "a.txt");
  assertEquals(fileName(p("./a.txt")), "a.txt");
  assertEquals(fileName(p(".././a.txt")), null);
  assertEquals(fileName(p("././a.txt")), "a.txt");
  assertEquals(fileName(p("dir/sub/a.txt")), "dir/sub/a.txt");
  assertEquals(fileName(p("")), null);
  assertEquals(fileName(p(".")), null);
  assertEquals(fileName(p("..")), null);
  assertEquals(fileName(p("a//b")), null);
  assertEquals(fileName(p("a/./b")), null);
  assertEquals(fileName(p("a/../b")), null);
  assertEquals(fileName(p("/a")), null);
  assertEquals(fileName(p("a/")), null);
  assertEquals(fileName(p("a\\b")), null);
  assertEquals(fileName(new Uint8Array([0x61, 0, 0x62])), null);
  assertEquals(fileName(p("x".repeat(MAX_NAME - 1))), "x".repeat(MAX_NAME - 1));
  assertEquals(fileName(p("x".repeat(MAX_NAME))), null);
  assertEquals(fileName(new Uint8Array([0xff, 0xfe])), null);

  assertEquals(directoryName(p("")), "");
  assertEquals(directoryName(p(".")), "");
  assertEquals(directoryName(p("./")), "");
  assertEquals(directoryName(p("dir")), "dir");
  assertEquals(directoryName(p("dir/sub")), "dir/sub");
  assertEquals(directoryName(p("..")), null);
});

Deno.test("names are ordered as the host orders their bytes", () => {
  assert(compareCodePoints("a.txt", "b.txt") < 0, "a before b");
  assert(compareCodePoints("￿", "\u{10000}") < 0, "the supplementary planes come last");
  assert("￿" < "\u{10000}" === false, "which is not what UTF-16 comparison says");
  assert(compareCodePoints("a", "aa") < 0, "a prefix comes first");
  assertEquals(compareCodePoints("same", "same"), 0);
});

Deno.test("small files, as the SDK contract exercises them", () => {
  const vfs = mounted();
  let fd = vfs.open(p("contract.tmp"), true);
  assert(fd >= 0, "create file");
  assertEquals(vfs.writeAt(fd, 0n, encoder.encode("alpha")), 5);
  assertEquals(vfs.writeAt(fd, 1n, encoder.encode("XYZ")), 3);
  assertEquals(vfs.writeAt(fd, 0n, new Uint8Array(0)), 0);
  assertEquals(vfs.size(fd), 5);
  vfs.close(fd);

  fd = vfs.open(p("contract.tmp"), false);
  assert(fd >= 0, "reopen file");
  let read = vfs.readAt(fd, 0n, 8);
  assertEquals(read.status, 0);
  assertEquals(decoder.decode(read.data), "aXYZa");
  read = vfs.readAt(fd, 5n, 8);
  assertEquals([read.status, read.data.length], [0, 0]);
  read = vfs.readAt(fd, 0n, 0);
  assertEquals([read.status, read.data.length], [0, 0]);
  vfs.close(fd);

  assertEquals(vfs.open(p("contract-missing.tmp"), false), -1);
  assertEquals(vfs.open(p("doom2.wad"), true), -1);
  fd = vfs.open(p("doom2.wad"), false);
  assert(fd >= 0, "asset open");
  assertEquals(vfs.size(fd), 64);
  assertEquals(decoder.decode(vfs.readAt(fd, 0n, 4).data), "IWAD");
  assertEquals(vfs.writeAt(fd, 0n, encoder.encode("alpha")), -1);
  vfs.close(fd);

  // Closing a handle is what closes the file, so far more opens than the host
  // can hold at once work as long as each is closed in turn.
  for (let i = 0; i < 256; i++) {
    const handle = vfs.open(p("doom2.wad"), false);
    assert(handle >= 0, "reopen after close");
    vfs.close(handle);
  }
  const handles = new Set<number>();
  for (let i = 0; i < 8; i++) {
    const handle = vfs.open(p("doom2.wad"), false);
    assert(handle >= 0 && !handles.has(handle), "distinct concurrent handles");
    handles.add(handle);
  }
  for (const handle of handles) {
    assertEquals(vfs.size(handle), 64);
    vfs.close(handle);
  }

  assertEquals(vfs.size(200), -1);
  assertEquals(vfs.readAt(200, 0n, 4).status, -1);
  assertEquals(vfs.writeAt(200, 0n, new Uint8Array(1)), -1);
});

Deno.test("the handle table is a hundred and twenty-eight deep", () => {
  const vfs = mounted();
  const open: number[] = [];
  for (let i = 0; i < 128; i++) {
    const fd = vfs.open(p("doom2.wad"), false);
    assert(fd >= 0, `handle ${i}`);
    open.push(fd);
  }
  assertEquals(vfs.open(p("doom2.wad"), false), -1);
  vfs.close(open[7]);
  assertEquals(vfs.open(p("doom2.wad"), false), open[7]);
});

Deno.test("directories, as the SDK contract exercises them", () => {
  const vfs = mounted();
  write(vfs, "contract.tmp", "aXYZa");
  assertEquals(names(vfs.listDirectory(p(""))), ["contract.tmp 5 false", "doom2.wad 64 false"]);
  assertEquals(names(vfs.listDirectory(p("."))), names(vfs.listDirectory(p(""))));
  assertEquals(vfs.listDirectory(p("contract-missing")), null);
  assertEquals(vfs.listDirectory(p("doom2.wad")), null);
  assertEquals(vfs.createDirectory(p("")), 0);
  assertEquals(vfs.createDirectory(p(".")), 0);
  assertEquals(vfs.createDirectory(p("doom2.wad")), -1);
  assertEquals(vfs.createDirectory(p("doom2.wad/below")), -1);

  assertEquals(vfs.createDirectory(p("contract-dir/sub")), 0);
  assertEquals(vfs.createDirectory(p("contract-dir/sub")), 0);
  assert(
    names(vfs.listDirectory(p(""))).includes("contract-dir 0 true"),
    "the root lists the directory",
  );
  assertEquals(names(vfs.listDirectory(p("contract-dir"))), ["sub 0 true"]);
  assertEquals(names(vfs.listDirectory(p("contract-dir/sub"))), []);

  write(vfs, "contract-dir/sub/b.txt", "bb");
  write(vfs, "contract-dir/sub/a.txt", "aaa");
  assertEquals(names(vfs.listDirectory(p("contract-dir/sub"))), ["a.txt 3 false", "b.txt 2 false"]);
  write(vfs, "contract-implicit/deep/file.txt", "x");
  assertEquals(names(vfs.listDirectory(p("contract-implicit"))), ["deep 0 true"]);

  assertEquals(vfs.rename(p("contract-dir/sub/a.txt"), p("contract-dir/sub/c.txt")), 0);
  assertEquals(vfs.open(p("contract-dir/sub/a.txt"), false), -1);
  assertEquals(names(vfs.listDirectory(p("contract-dir/sub"))), ["b.txt 2 false", "c.txt 3 false"]);
  assertEquals(vfs.rename(p("contract-dir/sub/c.txt"), p("contract-dir/sub/b.txt")), 0);
  assertEquals(names(vfs.listDirectory(p("contract-dir/sub"))), ["b.txt 3 false"]);
  assertEquals(vfs.rename(p("contract-implicit"), p("contract-moved")), 0);
  assertEquals(vfs.listDirectory(p("contract-implicit")), null);
  assertEquals(names(vfs.listDirectory(p("contract-moved/deep"))), ["file.txt 1 false"]);
  assertEquals(vfs.rename(p("contract-moved"), p("contract-moved/deep/inside")), -1);
  assertEquals(vfs.rename(p("contract-moved"), p("contract-dir")), -1);

  assertEquals(vfs.remove(p("contract-dir/sub")), -1);
  assertEquals(vfs.remove(p("contract-dir/sub/b.txt")), 0);
  assertEquals(vfs.remove(p("contract-dir/sub")), 0);
  assertEquals(vfs.remove(p("contract-dir")), 0);
  assertEquals(vfs.listDirectory(p("contract-dir")), null);
  assertEquals(vfs.remove(p("contract-moved/deep/file.txt")), 0);
  assertEquals(vfs.remove(p("contract-moved/deep")), 0);
  assertEquals(vfs.remove(p("contract-moved")), 0);
  assertEquals(vfs.remove(p("contract-dir")), -1);
  assertEquals(vfs.remove(p("")), -1);
  assertEquals(vfs.rename(p(""), p("contract-root")), -1);

  assertEquals(vfs.remove(p("doom2.wad")), -1);
  assertEquals(vfs.rename(p("doom2.wad"), p("renamed.wad")), -1);
  assertEquals(vfs.rename(p("contract.tmp"), p("doom2.wad")), -1);

  // A file removed while open stays readable through its handle and is gone
  // once the handle closes.
  const fd = vfs.open(p("contract-open.tmp"), true);
  assert(fd >= 0, "open for removal");
  assertEquals(vfs.writeAt(fd, 0n, encoder.encode("xyz")), 3);
  assertEquals(vfs.remove(p("contract-open.tmp")), 0);
  assertEquals(vfs.size(fd), 3);
  assertEquals(decoder.decode(vfs.readAt(fd, 0n, 3).data), "xyz");
  vfs.close(fd);
  assertEquals(vfs.open(p("contract-open.tmp"), false), -1);
  assertEquals(names(vfs.listDirectory(p(""))), ["contract.tmp 5 false", "doom2.wad 64 false"]);
});

Deno.test("a renaming that would not fit, and one into its own subtree", () => {
  const vfs = new Vfs();
  assertEquals(vfs.createDirectory(p("d")), 0);
  // 252 bytes: renaming the parent to a five-byte name would push it to 256.
  write(vfs, `d/${"x".repeat(250)}`, "deep");
  assertEquals(vfs.rename(p("d"), p("ddddd")), -1);
  assertEquals(vfs.rename(p("d"), p("dddd")), 0);
  assertEquals(names(vfs.listDirectory(p("dddd"))), [`${"x".repeat(250)} 4 false`]);
  assertEquals(vfs.rename(p("dddd"), p("dddd/inside")), -1);
  assertEquals(vfs.rename(p("dddd"), p("dddd")), 0);
});

Deno.test("a prepared directory is read back and removed", () => {
  const vfs = mounted();
  assertEquals(vfs.loadEntry("preexisting", true, null), null);
  assertEquals(vfs.loadEntry("preexisting/hello.txt", false, encoder.encode("hi")), null);
  assertEquals(names(vfs.listDirectory(p("preexisting"))), ["hello.txt 2 false"]);
  const fd = vfs.open(p("preexisting/hello.txt"), false);
  assert(fd >= 0, "saved open");
  assertEquals(decoder.decode(vfs.readAt(fd, 0n, 8).data), "hi");
  vfs.close(fd);
  assertEquals(vfs.remove(p("preexisting/hello.txt")), 0);
  assertEquals(vfs.remove(p("preexisting")), 0);

  assertEquals(
    vfs.loadEntry("doom2.wad", false, new Uint8Array(1)),
    "a mounted asset is in the way, skipped",
  );
  assertEquals(vfs.loadEntry("doom2.wad", true, null), "a mounted asset is in the way, skipped");
});

Deno.test("a mirror sees every change in the order the guest made it", () => {
  const vfs = new Vfs();
  const mirror = new RecordingMirror();
  vfs.setMirror(mirror);
  write(vfs, "dir/a.txt", "aa");
  assertEquals(vfs.rename(p("dir/a.txt"), p("dir/b.txt")), 0);
  assertEquals(vfs.createDirectory(p("other")), 0);
  assertEquals(vfs.remove(p("dir/b.txt")), 0);
  assertEquals(mirror.calls, [
    "mkdir dir",
    "write dir/a.txt 2",
    "rename dir/a.txt dir/b.txt",
    "mkdir other",
    "remove dir/b.txt false",
  ]);
  assertEquals(vfs.saveError, null);
});

Deno.test("only the first failure to keep a change is reported", () => {
  const vfs = new Vfs();
  const mirror = new RecordingMirror();
  vfs.setMirror(mirror);
  mirror.failure = "Read-only file system";
  write(vfs, "a.txt", "aa");
  assertEquals(vfs.saveError, "writing write a.txt 2: Read-only file system");
  assertEquals(vfs.remove(p("a.txt")), 0);
  assertEquals(vfs.saveError, "writing write a.txt 2: Read-only file system");
});

Deno.test("writing far past the end zero-fills the gap", () => {
  const vfs = new Vfs();
  const fd = vfs.open(p("sparse.bin"), true);
  assert(fd >= 0, "open");
  assertEquals(vfs.writeAt(fd, 1000n, encoder.encode("z")), 1);
  assertEquals(vfs.size(fd), 1001);
  const read = vfs.readAt(fd, 0n, 1001);
  assertEquals(read.data.length, 1001);
  assertEquals(read.data.subarray(0, 1000).every((byte) => byte === 0), true);
  assertEquals(read.data[1000], 0x7a);
  assertEquals(vfs.writeAt(fd, BigInt(64 * 1024 * 1024), encoder.encode("z")), -1);
  assertEquals(vfs.writeAt(fd, 0n, new Uint8Array(64 * 1024 * 1024 + 1)), -1);
  vfs.close(fd);
});

Deno.test("a write open truncates what was there", () => {
  const vfs = new Vfs();
  write(vfs, "a.txt", "aaaa");
  write(vfs, "a.txt", "b");
  assertEquals(decoder.decode(vfs.read("a.txt") ?? new Uint8Array()), "b");
});
