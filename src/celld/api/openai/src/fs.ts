// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The file system the coding tools work on: a small async interface, an
 * in-memory implementation, and a read-only wrapper. Nothing here touches
 * the host: a Worker has no file system of its own, and an agent should
 * only ever see the workspace it is given.
 *
 * Paths are workspace-relative with `/` separators. {@link normalizePath}
 * resolves `.` and `..` and refuses anything that would leave the
 * workspace: absolute paths, drive letters, `~`, NUL, or `..` past the root.
 *
 * @module
 */

/** What is at a path. */
export type EntryKind = "file" | "dir";

/**
 * What a read or a listing may be given: a `signal` that stops it (it
 * rejects with the signal's reason). Implementations that cannot stop a
 * call midway check it before they start and between the steps they take.
 */
export interface FileSystemCallOptions {
  readonly signal?: AbortSignal;
}

/** A workspace. Implementations decide where the bytes live. */
export interface FileSystem {
  /** A file's text, or null when there is no file there. */
  read(path: string, options?: FileSystemCallOptions): Promise<string | null>;
  /** Writes a file, creating parent directories. */
  write(path: string, content: string): Promise<void>;
  /** Removes a file; throws if there is none. */
  remove(path: string): Promise<void>;
  /** What is at `path` (`""` is the root), or null. */
  kind(path: string): Promise<EntryKind | null>;
  /** Every file under `dir` (`""` for all), recursively, sorted. */
  list(dir: string, options?: FileSystemCallOptions): Promise<string[]>;
  /**
   * Lines of the files under `dir` that match `pattern`, a POSIX extended
   * regular expression, evaluated where a deadline can stop it (a sandbox
   * runs `grep -E` in its container), never in this isolate. Optional:
   * without it, `grep_files` matches literally only. `signal` ends the
   * search; at most `limit` matches come back, in path order.
   */
  search?(request: SearchRequest): Promise<SearchResult>;
  /**
   * What this file system changes, as an identity for the tool registry's
   * mutation lanes: two file systems over one workspace (and a shell
   * runner in it) should give the same object. Default: the file system
   * itself.
   */
  readonly workspace?: object;
}

/** What {@link FileSystem.search} looks for. */
export interface SearchRequest {
  readonly pattern: string;
  /** Workspace-relative directory; `""` for the root. */
  readonly dir: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** One matching line. */
export interface SearchMatch {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

/** What a search found; `truncated` when there may be more. */
export interface SearchResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

/** A path, normalised, or why it is refused. */
export type NormalizedPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * Normalises a workspace-relative path: `./a//b/../c` becomes `a/c`, and
 * `""` or `.` is the root (`""`).
 */
export function normalizePath(path: string): NormalizedPath {
  if (typeof path !== "string") {
    return { ok: false, message: "a path must be a string" };
  }
  if (path.includes("\0")) {
    return { ok: false, message: "a path must not contain NUL" };
  }
  if (
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\")
  ) {
    return { ok: false, message: `absolute paths are not allowed: ${path}` };
  }
  if (path === "~" || path.startsWith("~/")) {
    return {
      ok: false,
      message: `home-relative paths are not allowed: ${path}`,
    };
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        return { ok: false, message: `the path leaves the workspace: ${path}` };
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return { ok: true, path: parts.join("/") };
}

/** {@link normalizePath}, throwing on refusal. */
export function requirePath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.path;
}

/** A workspace held in memory; the default for tests and sandboxes. */
export class MemoryFileSystem implements FileSystem {
  readonly #files = new Map<string, string>();

  /** Starts with `files`, keyed by path. */
  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.#files.set(requirePath(path), content);
    }
  }

  #isDir(path: string): boolean {
    if (path === "") return true;
    const prefix = `${path}/`;
    for (const file of this.#files.keys()) {
      if (file.startsWith(prefix)) return true;
    }
    return false;
  }

  read(
    path: string,
    options: FileSystemCallOptions = {},
  ): Promise<string | null> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const normalized = normalizePath(path);
    if (!normalized.ok) return Promise.reject(new Error(normalized.message));
    return Promise.resolve(this.#files.get(normalized.path) ?? null);
  }

  write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized.ok) return Promise.reject(new Error(normalized.message));
    const target = normalized.path;
    if (target === "" || this.#isDir(target)) {
      return Promise.reject(
        new Error(`${target || "the root"} is a directory`),
      );
    }
    const parts = target.split("/");
    for (let end = 1; end < parts.length; end++) {
      const parent = parts.slice(0, end).join("/");
      if (this.#files.has(parent)) {
        return Promise.reject(
          new Error(`${parent} is a file, not a directory`),
        );
      }
    }
    this.#files.set(target, content);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized.ok) return Promise.reject(new Error(normalized.message));
    if (!this.#files.delete(normalized.path)) {
      return Promise.reject(
        new Error(
          this.#isDir(normalized.path)
            ? `${normalized.path || "the root"} is a directory`
            : `no such file: ${normalized.path}`,
        ),
      );
    }
    return Promise.resolve();
  }

  kind(path: string): Promise<EntryKind | null> {
    const normalized = normalizePath(path);
    if (!normalized.ok) return Promise.reject(new Error(normalized.message));
    if (this.#files.has(normalized.path)) return Promise.resolve("file");
    return Promise.resolve(this.#isDir(normalized.path) ? "dir" : null);
  }

  list(dir: string, options: FileSystemCallOptions = {}): Promise<string[]> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const normalized = normalizePath(dir);
    if (!normalized.ok) return Promise.reject(new Error(normalized.message));
    const prefix = normalized.path === "" ? "" : `${normalized.path}/`;
    return Promise.resolve(
      [...this.#files.keys()].filter((file) => file.startsWith(prefix)).sort(),
    );
  }

  /** Every file and its content, sorted by path. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.#files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    );
  }
}

/** The same file system with every write refused. */
export function readOnly(fs: FileSystem): FileSystem {
  const refuse = (path: string) =>
    Promise.reject(new Error(`the workspace is read-only: ${path}`));
  return {
    read: (path, options) => fs.read(path, options),
    kind: (path) => fs.kind(path),
    list: (dir, options) => fs.list(dir, options),
    write: (path) => refuse(path),
    remove: (path) => refuse(path),
    workspace: fs.workspace ?? fs,
    ...(fs.search === undefined
      ? {}
      : { search: (request) => fs.search!(request) }),
  };
}
