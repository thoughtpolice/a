// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic code-modernization, Apache-2.0, ab024cdc.
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  decodeUtf8,
  readWorkspaceFile,
  workspacePath,
} from "../../../lib/files.ts";
export const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 4000): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > max ||
    value.includes("\0")
  ) throw new Error("Expected bounded nonempty text");
  return value;
}
export function list(value: unknown, max = 2000): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error("Expected bounded array");
  }
  return value;
}
export function strings(value: unknown, max = 2000): string[] {
  return list(value, max).map((v) => text(v));
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < min ||
    value > max
  ) throw new Error("Invalid bounded integer");
  return value;
}
export const plain = (value: unknown): string =>
  String(value ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").slice(
    0,
    4000,
  );
export const html = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const md = (value: unknown): string =>
  html(plain(value)).replace(/[\\`*_{}\[\]()#+.!|>-]/g, "\\$&");
export async function json(root: string, path: string): Promise<unknown> {
  return JSON.parse(
    decodeUtf8((await readWorkspaceFile(root, path)).bytes).replace(
      /^\uFEFF/,
      "",
    ),
  );
}
export async function content(root: string, path: string): Promise<string> {
  return decodeUtf8((await readWorkspaceFile(root, path)).bytes).replace(
    /^\uFEFF/,
    "",
  );
}
export async function selectedRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = "/";
  for (const component of absolute.split("/").filter(Boolean)) {
    cursor = join(cursor, component);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new Error("Source root must not contain symbolic link components");
    }
  }
  const root = await realpath(absolute), home = await realpath(homedir());
  if (
    root === "/" || root.split("/").filter(Boolean).length < 2 ||
    root === home || home.startsWith(root + "/")
  ) throw new Error("Source root is too broad");
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("Source root must be a directory");
  }
  return root;
}
export const skipDirs: Record<string, true> = Object.fromEntries(
  [
    ".git",
    "node_modules",
    "vendor",
    "third_party",
    "dist",
    "build",
    "target",
    "bin",
    "obj",
    "out",
    "__pycache__",
    "venv",
    "generated",
    "coverage",
  ].map((name) => [name, true]),
);
export async function walk(root: string, skip = true): Promise<string[]> {
  const found: string[] = [];
  let entries = 0;
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 40) throw new Error("Source depth exceeds 40");
    for (
      const entry of (await readdir(await workspacePath(root, dir), {
        withFileTypes: true,
      })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    ) {
      if (++entries > 20000) throw new Error("Source exceeds 20000 entries");
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Source contains symbolic link: ${path}`);
      }
      if (entry.isDirectory()) {
        if (
          entry.name !== ".git" &&
          (!skip ||
            (!Object.hasOwn(skipDirs, entry.name) &&
              !entry.name.startsWith(".")))
        ) await visit(path, depth + 1);
      } else if (entry.isFile()) found.push(path);
      else throw new Error(`Nonregular source entry: ${path}`);
    }
  }
  await visit(".", 0);
  return found;
}
export function kind(path: string): "doc" | "test" | "main" {
  if (/\.(md|markdown|txt|rst|adoc)$/i.test(path)) return "doc";
  return /(^|\/)(test|tests|__tests__|spec|specs)\//i.test(path) ||
      /(^test_|_tests?\.[^.]+$|\.(spec|test)\.[^.]+$|(Test|Tests|TestCase|IT)\.[^.]+$|^Test[A-Z0-9_])/
        .test(basename(path))
    ? "test"
    : "main";
}
export function isTooling(path: string): boolean {
  const name = basename(path).toLowerCase();
  return /^(?:build|buck|pom\.xml|mvnw(?:\.cmd)?|gradlew(?:\.bat)?|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties|package(?:-lock)?\.json|(?:yarn|pnpm|uv|poetry)\.lock|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|cargo\.(?:toml|lock)|go\.(?:mod|sum)|composer\.(?:json|lock)|phpunit\.xml(?:\.dist)?|cmakelists\.txt|makefile|dockerfile)$/
    .test(name) ||
    /\.(?:csproj|sln|props|targets|runsettings)$/.test(name) ||
    /^(?:tsconfig[\w.-]*\.json|[\w-]+\.config\.(?:js|cjs|mjs|ts)|docker-compose[\w.-]*\.ya?ml)$/
      .test(name);
}
export async function fileSet(
  root: string,
  skip = true,
): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  let size = 0;
  for (const path of await walk(root, skip)) {
    const bytes = (await readWorkspaceFile(root, path)).bytes;
    size += bytes.length;
    if (size > 64 * 1024 * 1024) {
      throw new Error("Source exceeds aggregate 64 MiB read limit");
    }
    files[path] = sha(bytes);
  }
  return files;
}
