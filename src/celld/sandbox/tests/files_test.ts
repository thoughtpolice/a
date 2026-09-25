// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { readAll } from "@celld/sandbox";
import { rejectsWith, withSandbox } from "./fixture.ts";

Deno.test("text files round-trip and parents are created", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.writeFile("a/b/c.txt", "héllo\n");
    const file = await sandbox.readFile("a/b/c.txt");
    assertEquals(file, {
      path: "a/b/c.txt",
      size: 7,
      encoding: "utf-8",
      content: "héllo\n",
    });
    assertEquals(await Deno.readTextFile(`${workspace}/a/b/c.txt`), "héllo\n");
    await rejectsWith(
      sandbox.writeFile("x/y.txt", "no", { createParents: false }),
      "not_directory",
    );
  }));

Deno.test("binary files are byte-exact both ways", () =>
  withSandbox(async ({ sandbox }) => {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
    await sandbox.writeFile("blob.bin", bytes);
    const back = await sandbox.readFile("blob.bin", { encoding: "bytes" });
    assertEquals(back.encoding, "bytes");
    assertEquals(back.content, bytes);
    await rejectsWith(sandbox.readFile("blob.bin"), "not_text");
    await sandbox.writeFile("b64.bin", btoa("\0\x01\xff"), {
      encoding: "base64",
    });
    assertEquals(
      (await sandbox.readFile("b64.bin", { encoding: "bytes" })).content,
      new Uint8Array([0, 1, 255]),
    );
    await rejectsWith(
      sandbox.writeFile("bad", "***", { encoding: "base64" }),
      "invalid",
    );
  }));

Deno.test("modes are applied", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("run.sh", "#!/bin/sh\necho ran\n", { mode: "755" });
    assertEquals((await sandbox.exec(["./run.sh"])).stdout, "ran\n");
    await rejectsWith(sandbox.writeFile("x", "", { mode: "999" }), "invalid");
  }));

Deno.test("size limits hold for reads and writes", () =>
  withSandbox(async ({ sandbox }) => {
    await rejectsWith(sandbox.writeFile("big", "x".repeat(101)), "too_large");
    await sandbox.writeFile("ok", "x".repeat(100));
    const error = await rejectsWith(
      sandbox.readFile("ok", { maxBytes: 10 }),
      "too_large",
    );
    assert(error.detail.includes("100 bytes"), error.message);
  }, { settings: { maxFileBytes: 100 } }));

Deno.test("reading what is not a file says why", () =>
  withSandbox(async ({ sandbox }) => {
    await rejectsWith(sandbox.readFile("missing"), "not_found");
    await sandbox.mkdir("dir");
    await rejectsWith(sandbox.readFile("dir"), "is_directory");
    await sandbox.exec(["mkfifo", "pipe"]);
    await rejectsWith(sandbox.readFile("pipe"), "not_regular");
    await rejectsWith(sandbox.writeFile("dir", "x"), "is_directory");
  }));

Deno.test("symbolic links cannot reach outside the workspace", () =>
  withSandbox(async ({ sandbox, root }) => {
    await Deno.writeTextFile(`${root}/secret`, "top secret");
    await sandbox.exec(["ln", "-s", root, "escape"]);
    await sandbox.exec(["ln", "-s", `${root}/secret`, "secret-link"]);
    await sandbox.exec(["ln", "-s", "/nonexistent/place", "dangling"]);
    await rejectsWith(sandbox.readFile("escape/secret"), "outside_workspace");
    await rejectsWith(sandbox.readFile("secret-link"), "outside_workspace");
    await rejectsWith(
      sandbox.writeFile("escape/planted", "x"),
      "outside_workspace",
    );
    await rejectsWith(sandbox.writeFile("dangling/x", "x"), "invalid_path");
    await rejectsWith(sandbox.mkdir("escape/new"), "outside_workspace");
    await rejectsWith(sandbox.listFiles("escape"), "outside_workspace");
    await rejectsWith(sandbox.stat("secret-link"), "outside_workspace");
    await rejectsWith(
      sandbox.renameFile("escape/secret", "stolen"),
      "outside_workspace",
    );
    await rejectsWith(sandbox.remove("escape/secret"), "outside_workspace");
    // Removing the link itself is fine and leaves its target alone.
    await sandbox.deleteFile("secret-link");
    assertEquals(await Deno.readTextFile(`${root}/secret`), "top secret");
  }));

Deno.test("links inside the workspace are followed", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("real/file.txt", "inside");
    await sandbox.exec(["ln", "-s", "real", "alias"]);
    assertEquals((await sandbox.readFile("alias/file.txt")).content, "inside");
    const stat = await sandbox.stat("alias");
    assertEquals([stat.kind, stat.symlink], ["dir", true]);
  }));

Deno.test("lexical escapes never reach the container", () =>
  withSandbox(async ({ sandbox, container }) => {
    await sandbox.exec(["true"]);
    const before = container.execs.length;
    await rejectsWith(sandbox.readFile("../etc/passwd"), "outside_workspace");
    await rejectsWith(sandbox.readFile("/etc/passwd"), "outside_workspace");
    await rejectsWith(sandbox.writeFile("", "x"), "invalid_path");
    await rejectsWith(sandbox.deleteFile("."), "invalid_path");
    assertEquals(container.execs.length, before);
  }));

Deno.test("mkdir, stat and exists", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.mkdir("one");
    await rejectsWith(sandbox.mkdir("one"), "exists");
    await sandbox.mkdir("one", { recursive: true });
    await rejectsWith(sandbox.mkdir("two/three"), "not_directory");
    await sandbox.mkdir("two/three", { recursive: true });
    await sandbox.writeFile("two/three/f.txt", "12345");
    const stat = await sandbox.stat("two/three/f.txt");
    assertEquals([stat.path, stat.kind, stat.size, stat.symlink], [
      "two/three/f.txt",
      "file",
      5,
      false,
    ]);
    assert(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(stat.modifiedAt),
      stat.modifiedAt,
    );
    assertEquals(await sandbox.exists("two"), { exists: true, kind: "dir" });
    assertEquals(await sandbox.exists("nope"), { exists: false, kind: null });
    await rejectsWith(sandbox.exists("../x"), "outside_workspace");
  }));

Deno.test("listFiles is sorted, shallow by default, and hides dotfiles", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("b.txt", "");
    await sandbox.writeFile("a/inner.txt", "");
    await sandbox.writeFile(".env", "");
    await sandbox.writeFile(".git/config", "");
    await sandbox.writeFile("with space/and\ttab.txt", "");
    await sandbox.exec(["ln", "-s", "b.txt", "link"]);
    const shallow = await sandbox.listFiles();
    assertEquals(shallow.entries.map((e) => `${e.kind}:${e.path}`), [
      "dir:a",
      "file:b.txt",
      "symlink:link",
      "dir:with space",
    ]);
    const deep = await sandbox.listFiles("", {
      recursive: true,
      includeHidden: true,
    });
    assertEquals(deep.entries.map((e) => e.path), [
      ".env",
      ".git",
      ".git/config",
      "a",
      "a/inner.txt",
      "b.txt",
      "link",
      "with space",
      "with space/and\ttab.txt",
    ]);
    const sub = await sandbox.listFiles("a", { recursive: true });
    assertEquals(sub.entries, [{
      path: "a/inner.txt",
      name: "inner.txt",
      kind: "file",
    }]);
    const limited = await sandbox.listFiles("", { recursive: true, limit: 2 });
    assertEquals([limited.entries.length, limited.truncated], [2, true]);
    await rejectsWith(sandbox.listFiles("b.txt"), "not_directory");
    await rejectsWith(sandbox.listFiles("none"), "not_found");
  }));

Deno.test("rename, delete and remove", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.writeFile("from.txt", "moving");
    await sandbox.mkdir("dest");
    await sandbox.renameFile("from.txt", "dest/to.txt");
    assertEquals((await sandbox.readFile("dest/to.txt")).content, "moving");
    await sandbox.writeFile("other.txt", "replaced");
    await sandbox.moveFile("other.txt", "dest/to.txt");
    assertEquals((await sandbox.readFile("dest/to.txt")).content, "replaced");
    await rejectsWith(
      sandbox.renameFile("dest/to.txt", "dest"),
      "is_directory",
    );
    await rejectsWith(sandbox.renameFile("missing", "x"), "not_found");
    await rejectsWith(sandbox.deleteFile("dest"), "is_directory");
    await rejectsWith(sandbox.remove("dest"), "not_empty");
    await sandbox.deleteFile("dest/to.txt");
    await rejectsWith(sandbox.deleteFile("dest/to.txt"), "not_found");
    await sandbox.remove("dest");
    await sandbox.writeFile("tree/a/b/c", "");
    await sandbox.remove("tree", { recursive: true });
    assertEquals((await sandbox.exists("tree")).exists, false);
  }));

Deno.test("file streams read and write large files", () =>
  withSandbox(async ({ sandbox }) => {
    const size = 300_000;
    const bytes = new Uint8Array(size).map((_, i) => i % 251);
    const upload = await sandbox.openStream({
      kind: "write",
      path: "big/upload.bin",
    });
    const written = await sandbox.stream(upload, new Blob([bytes]).stream());
    assertEquals(await written.json(), { path: "big/upload.bin", size });
    const download = await sandbox.openStream({
      kind: "read",
      path: "big/upload.bin",
    });
    const response = await sandbox.stream(download, null);
    assertEquals(response.headers.get("x-celld-sandbox-size"), String(size));
    assertEquals(await readAll(response.body!), bytes);
    await rejectsWith(sandbox.readFile("big/upload.bin"), "too_large");
    const dir = await sandbox.openStream({ kind: "read", path: "big" });
    await rejectsWith(sandbox.stream(dir, null), "not_regular");
  }, { settings: { maxFileBytes: 1000 } }));
