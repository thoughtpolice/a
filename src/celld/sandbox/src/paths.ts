// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace paths, checked lexically before anything reaches the container.
 *
 * A path is workspace-relative (`src/a.ts`, `./a//b/../c`) or absolute
 * inside the workspace (`/workspace/src/a.ts`). It is refused when it
 * contains NUL or a newline, when `..` would climb above the workspace,
 * when it is absolute but outside, and for `~`. Symbolic links are the
 * container scripts' job: they resolve each path again and refuse one
 * that ends up outside (see `scripts.ts`).
 *
 * @module
 */

import { SandboxError } from "./errors.ts";

/** A checked path: relative to the workspace (`""` is its root) and absolute. */
export interface WorkspacePath {
  readonly relative: string;
  readonly absolute: string;
}

const MAX_PATH = 4096;

/** Checks an absolute container directory setting such as the workspace. */
export function checkDirectory(path: string, what: string): string {
  if (
    typeof path !== "string" || !path.startsWith("/") || path.includes("\0")
  ) {
    throw new SandboxError("invalid", `${what} must be an absolute path`);
  }
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new SandboxError("invalid", `${what} must not contain ..`);
  }
  if (parts.length === 0) {
    throw new SandboxError("invalid", `${what} must not be /`);
  }
  return `/${parts.join("/")}`;
}

/** Resolves `path` against `workspace` (an already checked directory). */
export function workspacePath(workspace: string, path: string): WorkspacePath {
  if (typeof path !== "string") {
    throw new SandboxError("invalid_path", "a path must be a string");
  }
  if (path.length > MAX_PATH) {
    throw new SandboxError("invalid_path", "the path is too long");
  }
  if (/[\0\n\r]/.test(path)) {
    throw new SandboxError(
      "invalid_path",
      "a path must not contain NUL or line breaks",
    );
  }
  if (path === "~" || path.startsWith("~/")) {
    throw new SandboxError(
      "invalid_path",
      `home-relative paths are not allowed: ${path}`,
    );
  }
  let rest = path;
  if (path.startsWith("/")) {
    if (path !== workspace && !path.startsWith(`${workspace}/`)) {
      throw new SandboxError(
        "outside_workspace",
        `${path} is outside the workspace ${workspace}`,
      );
    }
    rest = path.slice(workspace.length);
  }
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new SandboxError(
          "outside_workspace",
          `the path leaves the workspace: ${path}`,
        );
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const relative = parts.join("/");
  return {
    relative,
    absolute: relative === "" ? workspace : `${workspace}/${relative}`,
  };
}

/** {@link workspacePath}, refusing the workspace root itself. */
export function workspaceEntry(workspace: string, path: string): WorkspacePath {
  const resolved = workspacePath(workspace, path);
  if (resolved.relative === "") {
    throw new SandboxError(
      "invalid_path",
      "the workspace root itself cannot be the target",
    );
  }
  return resolved;
}
