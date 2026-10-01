// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

export async function workspacePath(cwd: string, input: string): Promise<string> {
  if (!input || input.includes("\0")) throw new Error("Expected a nonempty filesystem path without NUL");
  const root = await realpath(cwd);
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes the selected workspace");
  const components = rel.split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < components.length; index++) {
    cursor = join(cursor, components[index]);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("Symbolic links are not accepted in artifact paths");
      if (index < components.length - 1 && !info.isDirectory()) throw new Error("Path ancestor is not a directory");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return path;
}

export async function readWorkspaceFile(cwd: string, input: string, maxBytes = 8 * 1024 * 1024): Promise<{ path: string; bytes: Buffer }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid file size limit");
  const path = await workspacePath(cwd, input);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Input must be a regular file");
    if (info.size > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) return { path, bytes: buffer.subarray(0, length) };
      length += bytesRead;
    }
    throw new Error("Input grew while being read; retry against a stable artifact");
  } finally {
    await file.close();
  }
}

export async function writeWorkspaceFile(cwd: string, input: string, data: string | Uint8Array, overwrite = false): Promise<string> {
  const path = await workspacePath(cwd, input);
  await mkdir(dirname(path), { recursive: true });
  await workspacePath(cwd, input);
  const temporary = await mkdtemp(join(dirname(path), ".omp-artifact-"));
  const file = join(temporary, "output");
  try {
    await writeFile(file, data, { mode: 0o600, flag: "wx" });
    if (overwrite) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Output is not a regular file");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      await rename(file, path);
    } else {
      await link(file, path);
    }
    return path;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
