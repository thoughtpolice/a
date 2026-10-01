// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic make_shards.py, Apache-2.0, ab024cdc.
import { dirname, extname } from "node:path";
import { readWorkspaceFile } from "../../../lib/files.ts";
import { integer, list, object, text, walk } from "./common.ts";
const extensions: Record<string, true> = Object.fromEntries(
  "cbl cob cobol cpy pli pl1 jcl proc rpg rpgle sqlrpgle clle nat ada adb ads asm bms map pas dpr prg f for f90 f77 java kt scala groovy cs vb vbs bas cls frm fs c h cc cpp cxx hpp m mm go rs py rb php pl pm js jsx ts tsx swift lua tcl erl ex exs clj hs ml r sh bat ps1 asp aspx ascx cshtml jsp jspx sql pks pkb plsql tf"
    .split(" ").map((e) => [`.${e}`, true]),
);
export async function makeShards(root: string, value: unknown) {
  const spec = object(value),
    maxFiles = integer(spec.maxFiles ?? 25, 1, 100),
    maxLines = integer(spec.maxLines ?? 5000, 1, 20000);
  const filter = spec.pattern === undefined ? "" : text(spec.pattern, 200);
  // Deliberately narrow glob: literals, * and ?. Plain names also match path components.
  const regex = new RegExp(
    "^" +
      filter.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(
        /\?/g,
        ".",
      ) + "$",
  );
  const accepts = (name: string): boolean =>
    !filter || regex.test(name) || regex.test(name.split("/").at(-1)!) ||
    (!/[*?]/.test(filter) && name.split("/").includes(filter));
  const inventory: {
      path: string;
      loc: number;
      domain: string;
      name: string;
    }[] = [],
    excluded: string[] = [];
  let totalBytes = 0;
  for (const path of await walk(root)) {
    if (!extensions[extname(path).toLowerCase()] || path.endsWith(".min.js")) {
      continue;
    }
    if (
      spec.includeTests !== true &&
      /(^|\/)(test|tests|__tests__|spec|specs|fixtures|testdata|test-data)\//i
        .test(path)
    ) {
      excluded.push(path);
      continue;
    }
    const bytes = (await readWorkspaceFile(root, path, 5_000_000)).bytes;
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error("Source inventory exceeds aggregate 64 MiB");
    }
    if (bytes.includes(0)) {
      excluded.push(path);
      continue;
    }
    let loc = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
    for (const byte of bytes) if (byte === 10) loc++;
    inventory.push({ path, loc, domain: dirname(path), name: path });
  }
  if (spec.topology !== undefined) {
    const topology = object(spec.topology),
      locations = new Set<string>(),
      names = new Set<string>(),
      mapped: typeof inventory = [];
    const visit = (value: unknown, domain: string, depth: number): void => {
      if (depth > 40) throw new Error("Topology too deep");
      const node = object(value);
      if (node.kind === "domain") domain = text(node.name ?? node.id);
      if (node.kind === "module") {
        const path = text(node.file), name = text(node.name ?? node.id);
        if (locations.has(path) || names.has(name)) {
          throw new Error("Topology module locations/names must be unique");
        }
        locations.add(path);
        names.add(name);
        const found = inventory.find((i) => i.path === path);
        if (!found) {
          throw new Error(`Topology file not a readable source file: ${path}`);
        }
        mapped.push({ ...found, domain, name });
      }
      for (const child of list(node.children ?? [], 20000)) {
        visit(child, domain, depth + 1);
      }
    };
    visit(topology.root, "misc", 0);
    inventory.splice(0, inventory.length, ...mapped);
  }
  const shards: {
    name: string;
    domain: string;
    files: string[];
    loc: number;
  }[] = [];
  const selected = inventory.filter((f) => accepts(f.path) || accepts(f.name))
    .sort((a, b) =>
      a.domain < b.domain
        ? -1
        : a.domain > b.domain
        ? 1
        : a.path < b.path
        ? -1
        : a.path > b.path
        ? 1
        : 0
    );
  let chunk: typeof shards[number] | undefined;
  for (const file of selected) {
    if (file.loc > maxLines) {
      throw new Error(
        `Source file exceeds shard line cap and cannot be silently truncated: ${file.path}`,
      );
    }
    if (
      !chunk || chunk.domain !== file.domain ||
      chunk.files.length >= maxFiles || chunk.loc + file.loc > maxLines ||
      (spec.topology !== undefined && file.loc >= 300)
    ) {
      chunk = {
        name: spec.topology === undefined
          ? `${file.domain}#${
            shards.filter((s) => s.domain === file.domain).length + 1
          }`
          : file.name,
        domain: file.domain,
        files: [],
        loc: 0,
      };
      shards.push(chunk);
    }
    chunk.files.push(file.path);
    chunk.loc += file.loc;
    if (spec.topology !== undefined && file.loc >= 300) chunk = undefined;
  }
  if (!shards.length) throw new Error("No source files matched");
  return {
    shards,
    files: selected.length,
    loc: selected.reduce((sum, f) => sum + f.loc, 0),
    tinyEstate: inventory.length < 30,
    excluded,
  };
}
