// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { walk } from "@std/fs/walk";

// -------------------------------------------------------------------------------------------------

// NOTE: This is the one type we need from @yowasp/runtime and it's exposed from
// all packages, so just to keep one canonical definition, we'll put it here.
/** A Tree of files for toolchain usage */
export type Tree = {
  [name: string]: Tree | string | Uint8Array;
};

/** Walk a directory path and create a `Tree` from it. */
export async function walkDirectoryForTree(path: string): Promise<Tree> {
  const files: Tree = {};
  const dirpath = path + (path.endsWith("/") ? "" : "/");

  // first, walk all the normal files and add them to the tree
  for await (const entry of walk(path, { maxDepth: 1 })) {
    if (entry.path === path) {
      continue;
    }

    const relpath = entry.path.slice(dirpath.length);

    if (entry.isDirectory) {
      files[relpath] = await walkDirectoryForTree(entry.path);
    } else {
      files[relpath] = await Deno.readFile(entry.path);
    }
  }

  return files;
}

/**
 * Write a Tree to a directory on the filesystem. Creates the directory if it doesn't exist.
 * Recursively writes all files and subdirectories.
 */
export async function writeTreeToDirectory(
  tree: Tree,
  path: string,
): Promise<void> {
  // Ensure the directory exists
  await Deno.mkdir(path, { recursive: true });

  for (const [name, value] of Object.entries(tree)) {
    const fullPath = `${path}/${name}`;

    if (value instanceof Uint8Array) {
      // It's a file - write it
      await Deno.writeFile(fullPath, value);
    } else if (typeof value === "string") {
      // It's a string (legacy format) - encode and write
      await Deno.writeFile(fullPath, new TextEncoder().encode(value));
    } else if (typeof value === "object") {
      // It's a directory - recurse
      await writeTreeToDirectory(value, fullPath);
    }
  }
}

/**
 * Create a Tree from an inline specification. The spec is a mapping of file paths to
 * arrays of lines. Paths can include slashes to create subdirectories. Lines are joined
 * with newlines and encoded as UTF-8.
 *
 * Example:
 *   createTree({
 *     "foo.txt": ["first line", "second line"],
 *     "subdir/bar.txt": ["content"]
 *   })
 */
export function createTree(spec: { [name: string]: string[] }): Tree {
  const tree: Tree = {};

  for (const [path, lines] of Object.entries(spec)) {
    const content = lines.join("\n") + "\n";
    const bytes = new TextEncoder().encode(content);

    const parts = path.split("/");
    let current = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      const next = current[part];
      if (typeof next === "object" && !(next instanceof Uint8Array)) {
        current = next as Tree;
      } else {
        throw new Error(
          `Path conflict at ${
            parts.slice(0, i + 1).join("/")
          }: expected directory, found file`,
        );
      }
    }

    // Add the file
    const filename = parts[parts.length - 1];
    if (filename in current) {
      throw new Error(`Duplicate file: ${path}`);
    }
    current[filename] = bytes;
  }

  return tree;
}

/**
 * Merge two Trees together. If both trees have directories at the same key, they are
 * recursively merged. If both have files at the same key, an error is thrown.
 */
export function mergeTrees(a: Tree, b: Tree): Tree {
  const result: Tree = {};

  for (const [key, value] of Object.entries(a)) {
    result[key] = value;
  }

  for (const [key, value] of Object.entries(b)) {
    if (key in result) {
      const aVal = result[key];
      const bVal = value;

      const aIsTree = typeof aVal === "object" && !(aVal instanceof Uint8Array);
      const bIsTree = typeof bVal === "object" && !(bVal instanceof Uint8Array);

      // Both are trees (directories) - recursively merge
      if (aIsTree && bIsTree) {
        result[key] = mergeTrees(aVal, bVal);
      } else if (!aIsTree && !bIsTree) {
        // Both are files - overlapping files error
        throw new Error(`Overlapping file: ${key}`);
      } else {
        // One is a file, one is a directory
        throw new Error(
          `Type conflict at ${key}: cannot merge file and directory`,
        );
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Dump a Tree to the console in a human-readable format. Shows the directory structure
 * and file contents. Files are decoded as UTF-8 text and shown with their content.
 * Directories are shown with their nested structure.
 */
export function dumpTree(tree: Tree, prefix = ""): void {
  const entries = Object.entries(tree).sort(([a], [b]) => a.localeCompare(b));

  for (const [name, value] of entries) {
    if (value instanceof Uint8Array) {
      // It's a file - show the name and decoded content
      console.log(`${prefix}${name}: <uint8 data>`);
    } else if (typeof value === "object") {
      // It's a directory - recurse
      console.log(`${prefix}${name}/`);
      dumpTree(value, prefix + "  ");
    } else {
      // It's a string (legacy format from some tools)
      console.log(`${prefix}${name}: <string data>`);
    }
  }
}

/** Pluck a sub-Tree from a Tree. If it isn't a tree, an `Error` will be thrown. */
export function pluckTree(tree: Tree, entry: string): Tree {
  if (tree[entry] === undefined) {
    return {};
  }
  if (typeof tree[entry] !== "object") {
    throw new Error(`Subtree ${entry} is not a Tree!`);
  }
  return tree[entry] as Tree;
}

// -------------------------------------------------------------------------------------------------

/**
 * Run a @yowasp/runtime command, and capture its stderr and stdout.
 */
async function captureCommandOutput(
  fn: (
    args?: string[],
    tree?: Tree,
    opts?: any,
  ) => Promise<Tree> | Tree | undefined,
  args: string[],
  inputTree: Tree,
  inputSettings: any,
): Promise<[Tree | undefined, Uint8Array, Uint8Array]> {
  // Capture stdout and stderr
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const settings = {
    ...inputSettings,
    stdout: (data: Uint8Array | null) => {
      if (data !== null) {
        stdoutChunks.push(data);
      }
    },
    stderr: (data: Uint8Array | null) => {
      if (data !== null) {
        stderrChunks.push(data);
      }
    },
  };

  const result = await fn(args, inputTree, settings);

  // Combine chunks into single arrays
  const stdoutTotal = stdoutChunks.reduce(
    (acc, chunk) => acc + chunk.length,
    0,
  );
  const stderrTotal = stderrChunks.reduce(
    (acc, chunk) => acc + chunk.length,
    0,
  );

  const stdout = new Uint8Array(stdoutTotal);
  const stderr = new Uint8Array(stderrTotal);

  let stdoutOffset = 0;
  for (const chunk of stdoutChunks) {
    stdout.set(chunk, stdoutOffset);
    stdoutOffset += chunk.length;
  }

  let stderrOffset = 0;
  for (const chunk of stderrChunks) {
    stderr.set(chunk, stderrOffset);
    stderrOffset += chunk.length;
  }

  return [result, stdout, stderr];
}

/**
 * Run a @yowasp/runtime command over a given input tree, and capture its output Tree.
 * The resulting stderr/stdout of the command will be inserted into the resulting Tree
 * for reuse. It is expected that all output files will be located under "out" as this
 * is the only tree that will be retained.
 */
export async function runYowaspCommand(
  fn: (
    args?: string[],
    tree?: Tree,
    opts?: any,
  ) => Promise<Tree> | Tree | undefined,
  name: string,
  input: Tree,
  args: string[],
  opts: any,
): Promise<Tree> {
  input["out"] = {}; // always add an 'out' directory for e.g. clang
  const [result, stdout, stderr] = await captureCommandOutput(
    fn,
    args,
    input,
    opts,
  );
  if (result == undefined) {
    throw new Error(`command ${name} failed to generate a result`);
  }

  //console.error(new TextDecoder().decode(stderr));
  const outputTree: Tree = {
    stdout: stdout,
    stderr: stderr,
  };

  return mergeTrees(pluckTree(result, "out"), outputTree);
}

// -------------------------------------------------------------------------------------------------
