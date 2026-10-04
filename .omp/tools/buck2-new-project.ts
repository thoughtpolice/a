// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { literal, result } from "../lib/tool.ts";
import type { Tool, ToolAPI } from "../lib/tool.ts";

interface Params {
  type: "rust_binary" | "rust_library" | "deno_binary";
  name: string;
  path: string;
  description?: string;
  author?: string;
  license?: string;
  version?: string;
  visibility?: string[];
  permissions?: string[];
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "ENOENT"
    ) return false;
    throw error;
  }
}

// Reject symlinks even when they currently resolve inside the workspace: no
// generated path should depend on a link that can subsequently be retargeted.
async function checkAncestors(root: string, directory: string): Promise<void> {
  let cursor = root;
  for (
    const component of relative(root, directory).split(sep).filter(Boolean)
  ) {
    cursor = join(cursor, component);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Project ancestor is not a real directory: ${cursor}`);
      }
    } catch (error) {
      if (
        !(error && typeof error === "object" && "code" in error &&
          error.code === "ENOENT")
      ) throw error;
    }
  }
}

export default function factory(pi: ToolAPI): Tool<Params> {
  const t = pi.typebox.Type;
  return {
    name: "buck2_new_project",
    label: "Create Buck2 project",
    description:
      "Create a new Rust binary/library or Deno CLI package, refusing existing paths and symlink ancestors.",
    approval: "write",
    parameters: t.Object({
      type: t.Union([
        t.Literal("rust_binary"),
        t.Literal("rust_library"),
        t.Literal("deno_binary"),
      ]),
      name: t.String({ description: "Buck2 target name" }),
      path: t.String({
        description: "New package directory relative to the working directory",
      }),
      description: t.Optional(t.String()),
      author: t.Optional(t.String({ default: "Austin Seipp" })),
      license: t.Optional(t.String({ default: "Apache-2.0" })),
      version: t.Optional(t.String({ default: "1.0.0" })),
      visibility: t.Optional(
        t.Array(t.String(), {
          description: "Buck2 visibility labels; defaults to PUBLIC",
        }),
      ),
      permissions: t.Optional(
        t.Array(t.String(), {
          description: "Deno --allow-* values; defaults to no permissions",
        }),
      ),
    }, { additionalProperties: false }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      if (
        !["rust_binary", "rust_library", "deno_binary"].includes(params.type)
      ) throw new Error("Unsupported project type");
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(params.name)) {
        throw new Error("Invalid Buck2 target name");
      }
      if (!params.path || isAbsolute(params.path)) {
        throw new Error(
          "Project path must be relative to the working directory",
        );
      }
      const author = params.author ?? "Austin Seipp";
      const license = params.license ?? "Apache-2.0";
      const version = params.version ?? "1.0.0";
      const description = params.description || `${params.name} project`;
      for (const [key, value] of Object.entries({ author, license, version })) {
        if (
          !value || hasControlCharacters(value) || /[\u2028\u2029]/.test(value)
        ) {
          throw new Error(
            `Invalid ${key}: expected nonempty single-line metadata`,
          );
        }
      }
      const visibility = params.visibility ?? ["PUBLIC"];
      if (
        !Array.isArray(visibility) ||
        visibility.some((value) =>
          typeof value !== "string" || !value || hasControlCharacters(value)
        )
      ) throw new Error("Invalid visibility list");
      const permissions = params.permissions ?? [];
      if (params.type !== "deno_binary" && params.permissions !== undefined) {
        throw new Error("Permissions apply only to Deno projects");
      }
      if (
        !Array.isArray(permissions) ||
        permissions.some((value) =>
          !/^(read|write|net|env|run|sys|ffi|import)(=.+)?$/.test(value) ||
          hasControlCharacters(value)
        )
      ) throw new Error("Invalid Deno permissions");
      const root = await realpath(pi.cwd);
      const directory = resolve(root, params.path);
      const packagePath = relative(root, directory);
      if (
        !packagePath || packagePath === ".." ||
        packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath)
      ) {
        throw new Error(
          "Project path must remain within the working directory",
        );
      }
      if (hasControlCharacters(packagePath) || /[:#]/.test(packagePath)) {
        throw new Error(
          "Project path contains invalid Buck2 package characters",
        );
      }
      await checkAncestors(root, dirname(directory));
      if (await exists(directory)) {
        throw new Error(`Project directory already exists: ${params.path}`);
      }
      const copyright = `© 2024-${new Date().getFullYear()} ${author}`;
      const header = (comment: string) =>
        `${comment} SPDX-FileCopyrightText: ${copyright}\n${comment} SPDX-License-Identifier: ${license}\n\n`;
      const list = (items: string[]) => `[${items.map(literal).join(", ")}]`;
      const files: Record<string, string> = {
        PACKAGE: `${
          header("#")
        }load("@root//buck/shims:package.bzl", "pkg")\n\npkg.info(\n    copyright = [${
          literal(copyright)
        }],\n    license = ${literal(license)},\n    description = ${
          literal(description)
        },\n    version = ${literal(version)},\n)\n`,
      };
      if (params.type === "deno_binary") {
        files.BUILD = `${
          header("#")
        }load("@toolchains//deno:defs.bzl", "deno")\n\ndeno.binary(\n    name = ${
          literal(params.name)
        },\n    type = "run",\n    main = "main.ts",\n    config = "deno.jsonc",\n    permissions = ${
          list(permissions)
        },\n    visibility = ${list(visibility)},\n)\n`;
        files["main.ts"] = `${
          header("//")
        }if (import.meta.main) {\n  console.log(${
          literal(`Hello from ${params.name}!`)
        });\n}\n`;
        files["deno.jsonc"] = `${
          header("//")
        }{\n  "lock": "deno.lock",\n  "imports": {}\n}\n`;
        // Lockfiles are machine-readable JSON, which has no comment syntax.
        files["deno.lock"] = '{\n  "version": "5",\n  "specifiers": {}\n}\n';
      } else {
        const binary = params.type === "rust_binary";
        files.BUILD = `${
          header("#")
        }load("@root//buck/shims:shims.bzl", depot = "shims")\n\ndepot.${params.type}(\n    name = ${
          literal(params.name)
        },\n    srcs = glob(["src/**/*.rs"]),\n    deps = ["third-party//by-name/mi/mimalloc:rust"],\n    visibility = ${
          list(visibility)
        },\n)\n`;
        files[binary ? "src/main.rs" : "src/lib.rs"] = binary
          ? `${
            header("//")
          }#[global_allocator]\nstatic GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;\n\nfn main() {\n    println!("Hello from ${params.name}!");\n}\n`
          : `${
            header("//")
          }pub fn greeting() -> &'static str {\n    "Hello from ${params.name}!"\n}\n`;
      }
      signal?.throwIfAborted();
      await mkdir(dirname(directory), { recursive: true });
      await checkAncestors(root, dirname(directory));
      await mkdir(directory); // Atomic refusal if another creator won the race.
      try {
        if (params.type !== "deno_binary") await mkdir(join(directory, "src"));
        for (const [name, content] of Object.entries(files)) {
          signal?.throwIfAborted();
          await writeFile(join(directory, name), content, {
            encoding: "utf8",
            flag: "wx",
            signal,
          });
        }
        signal?.throwIfAborted();
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return result({
        type: params.type,
        path: packagePath,
        target: `depot//${packagePath.split(sep).join("/")}:${params.name}`,
        files: Object.keys(files).map((name) => join(packagePath, name)),
      });
    },
  };
}
