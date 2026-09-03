// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "../assert.ts";
import { DirectoryMirror } from "../mirror_dir.ts";
import { Vfs } from "../files.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const p = (path: string) => encoder.encode(path);

function temporary(): [string, () => void] {
  const root = Deno.makeTempDirSync({ prefix: "console-save-" });
  return [root, () => Deno.removeSync(root, { recursive: true })];
}

Deno.test("a prepared directory is loaded below the mounts", () => {
  const [root, clean] = temporary();
  try {
    Deno.mkdirSync(`${root}/deep/inner`, { recursive: true });
    Deno.writeTextFileSync(`${root}/deep/inner/a.txt`, "aa");
    Deno.writeTextFileSync(`${root}/top.txt`, "top");
    Deno.writeTextFileSync(`${root}/.flush.tmp`, "leftover");
    Deno.writeTextFileSync(`${root}/doom2.wad`, "in the way");

    const vfs = new Vfs();
    assert(vfs.mountReadonly("doom2.wad", encoder.encode("IWAD")), "mount");
    const warnings: string[] = [];
    DirectoryMirror.create(root).load(vfs, (message) => warnings.push(message));

    assertEquals(
      vfs.listDirectory(p(""))?.map((entry) => entry.name),
      ["deep", "doom2.wad", "top.txt"],
    );
    assertEquals(decoder.decode(vfs.read("deep/inner/a.txt") ?? new Uint8Array()), "aa");
    assertEquals(decoder.decode(vfs.read("doom2.wad") ?? new Uint8Array()), "IWAD");
    assertEquals(warnings.length, 1);
    assert(
      warnings[0].endsWith("doom2.wad: a mounted asset is in the way, skipped"),
      warnings[0],
    );
  } finally {
    clean();
  }
});

Deno.test("a name the virtual root cannot hold is reported and skipped", () => {
  const [root, clean] = temporary();
  try {
    Deno.writeTextFileSync(`${root}/back\\slash.txt`, "x");
    const vfs = new Vfs();
    const warnings: string[] = [];
    DirectoryMirror.create(root).load(vfs, (message) => warnings.push(message));
    assertEquals(vfs.listDirectory(p(""))?.length, 0);
    assertEquals(warnings.length, 1);
    assert(warnings[0].endsWith("not a usable name, skipped"), warnings[0]);
  } finally {
    clean();
  }
});

Deno.test("every change the guest makes reaches the disk", () => {
  const [root, clean] = temporary();
  try {
    const vfs = new Vfs();
    const mirror = DirectoryMirror.create(root);
    vfs.setMirror(mirror);

    const fd = vfs.open(p("dir/a.txt"), true);
    assert(fd >= 0, "open");
    assertEquals(vfs.writeAt(fd, 0n, encoder.encode("alpha")), 5);
    // Nothing is on disk until the handle closes or the run ends.
    assertEquals(Deno.statSync(`${root}/dir`).isDirectory, true);
    vfs.close(fd);
    assertEquals(Deno.readTextFileSync(`${root}/dir/a.txt`), "alpha");
    // The temporary the write goes through is never left behind.
    assertEquals(Deno.readDirSync(root).find((e) => e.name === ".flush.tmp"), undefined);

    assertEquals(vfs.rename(p("dir/a.txt"), p("moved/b.txt")), 0);
    assertEquals(Deno.readTextFileSync(`${root}/moved/b.txt`), "alpha");
    assertEquals(vfs.createDirectory(p("empty")), 0);
    assertEquals(Deno.statSync(`${root}/empty`).isDirectory, true);
    assertEquals(vfs.remove(p("moved/b.txt")), 0);
    assertEquals(Deno.readDirSync(`${root}/moved`).next().done, true);
    assertEquals(vfs.remove(p("moved")), 0);
    assertEquals(vfs.remove(p("empty")), 0);
    assertEquals([...Deno.readDirSync(root)].map((entry) => entry.name), ["dir"]);
    assertEquals(vfs.saveError, null);
  } finally {
    clean();
  }
});

Deno.test("what was written before the run ended is flushed at the end", () => {
  const [root, clean] = temporary();
  try {
    const vfs = new Vfs();
    vfs.setMirror(DirectoryMirror.create(root));
    const fd = vfs.open(p("open.txt"), true);
    assert(fd >= 0, "open");
    vfs.writeAt(fd, 0n, encoder.encode("still open"));
    vfs.flushAll();
    assertEquals(Deno.readTextFileSync(`${root}/open.txt`), "still open");
  } finally {
    clean();
  }
});

Deno.test("a directory that cannot be written is reported once", () => {
  const [root, clean] = temporary();
  try {
    const vfs = new Vfs();
    const mirror = DirectoryMirror.create(`${root}/saves`);
    vfs.setMirror(mirror);
    // A file where the directory has to go is what a save directory hits when
    // the guest and the host disagree about a name.
    Deno.writeTextFileSync(`${root}/saves/dir`, "not a directory");
    const fd = vfs.open(p("dir/a.txt"), true);
    assert(fd >= 0, "open");
    vfs.writeAt(fd, 0n, encoder.encode("x"));
    vfs.close(fd);
    assert(vfs.saveError !== null, "the failure is recorded");
    assert(vfs.saveError.startsWith("creating "), vfs.saveError);
    const first = vfs.saveError;
    vfs.remove(p("dir/a.txt"));
    assertEquals(vfs.saveError, first, "only the first failure is reported");
  } finally {
    clean();
  }
});
