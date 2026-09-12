// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A test-case reducer for generated programs. It works on the text, one
// statement per line and braces on lines of their own as gen.mjs writes it:
// dropping calls, then whole blocks with their headers (methods, classes,
// loops, if/else and try/catch chains), unwrapping blocks, single lines, and
// finally subexpressions. A candidate is kept when `test` says it still
// shows the same finding; Roslyn rejecting it counts as not.

const CHAIN = /^(else\b|catch\b|finally\b|while \(.*\);$)/;

function matching(lines, open) {
  let depth = 0;
  for (let i = open; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "{" || (t.endsWith("{") && !t.startsWith("//"))) depth++;
    if (t === "}" || t === "};" || t.startsWith("}")) depth--;
    if (depth === 0) return i;
  }
  return -1;
}

// Blocks: [header, open brace, close brace, end of the chain].
function blocks(lines) {
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (
      lines[i + 1].trim() !== "{" || lines[i].trim() === "{" ||
      lines[i].trim() === ""
    ) continue;
    const close = matching(lines, i + 1);
    if (close < 0) continue;
    let end = close;
    for (;;) {
      const next = lines[end + 1]?.trim() ?? "";
      if (!CHAIN.test(next)) break;
      if (lines[end + 2]?.trim() === "{") {
        const c = matching(lines, end + 2);
        if (c < 0) break;
        end = c;
      } else {
        end = end + 1;
      }
    }
    out.push([i, i + 1, close, end]);
  }
  return out;
}

// Balanced parenthesized groups within a line: [start, end] inclusive.
function groups(line) {
  const out = [];
  const stack = [];
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") stack.push(i);
    else if (c === ")" && stack.length) out.push([stack.pop(), i]);
  }
  return out.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
}

// The operands of a top-level binary operator in an expression.
function operands(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === " ") {
      const m =
        /^ (\?\?|\|\||&&|==|!=|<=|>=|<<|>>>|>>|[-+*/%&|^<>?:]|is|switch) /.exec(
          text.slice(i),
        );
      if (m) return [text.slice(0, i), text.slice(i + m[0].length)];
    }
  }
  return [];
}

// Line ranges of type and method declarations whose name appears nowhere
// else, and entries no call names.
function unusedDeclarations(lines, calls) {
  const text = lines.join("\n");
  const count = (name) =>
    (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  const called = new Set(
    calls.map((c) => c.method.slice(c.method.lastIndexOf(".") + 1)),
  );
  const out = [];
  for (const [h, , , end] of blocks(lines)) {
    const header = lines[h].trim();
    const type =
      /^(?:\[\w+\]\s*)?(?:internal |public )?(?:static |sealed |abstract |readonly )*(?:class|struct|interface|enum|record(?: struct)?) (\w+)/
        .exec(header);
    const method =
      /^(?:public |internal |private )?(?:static |virtual |override |sealed )*[\w<>\[\], ]+? (\w+)\(/
        .exec(header);
    if (type && count(type[1]) === 1) out.push([h, end]);
    else if (
      method &&
      !/^(?:if|for|foreach|while|switch|catch|using|return)\b/.test(header)
    ) {
      const name = method[1];
      const entry = /^public static /.test(header) &&
        lines.slice(0, h).some((l) =>
          l.startsWith("public static class Entry")
        );
      if (
        entry
          ? !called.has(name) && name !== "Trace"
          : count(name) === 1 && !/\boverride\b/.test(header)
      ) out.push([h, end]);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const m =
      /^(?:internal |public )?(?:record(?: struct)?|union) (\w+)\(.*\);$/.exec(
        lines[i].trim(),
      );
    if (m && count(m[1]) === 1) out.push([i, i]);
  }
  return out;
}

const REPLACEMENTS = ["0", "1", "true", "false", "null", '""', "default"];

export async function minimize(
  { source, calls, test, jobs = 8, maxTests = 6000, log = () => {} },
) {
  let lines = source.split("\n");
  let current = calls;
  let tests = 0;

  // Tries candidates in batches of `jobs`; returns the first (in order)
  // that reproduces, or null.
  async function first(candidates) {
    for (let i = 0; i < candidates.length && tests < maxTests; i += jobs) {
      const batch = candidates.slice(i, i + jobs);
      tests += batch.length;
      const results = await Promise.all(
        batch.map((c) => test(c.lines.join("\n"), c.calls ?? current)),
      );
      const index = results.findIndex(Boolean);
      if (index >= 0) return batch[index];
    }
    return null;
  }

  async function pass(make) {
    let progress = false;
    for (let position = 0; tests < maxTests;) {
      const candidates = make(position);
      if (!candidates.length) break;
      const found = await first(candidates);
      if (!found) {
        // A window with nothing that reproduces: go on after it.
        if (candidates.next === undefined) break;
        position = candidates.next;
        continue;
      }
      lines = found.lines;
      if (found.calls) current = found.calls;
      position = found.position;
      progress = true;
      log(`${lines.length} lines, ${current.length} calls (${tests} tests)`);
    }
    return progress;
  }

  // Calls, declarations, blocks and lines, until none of them makes progress.
  async function structure() {
    let progress = false;
    // Calls: an entry call and the Trace call after it.
    progress = await pass(() => {
      const out = [];
      for (let i = 0; i < current.length; i++) {
        if (current[i].method.endsWith(".Trace")) continue;
        const n = current[i + 1]?.method.endsWith(".Trace") ? 2 : 1;
        out.push({
          lines,
          calls: [...current.slice(0, i), ...current.slice(i + n)],
          position: 0,
        });
      }
      return out;
    }) || progress;
    // Declarations nothing mentions any more, all at once.
    progress = await pass(() => {
      const unused = unusedDeclarations(lines, current);
      if (!unused.length) return [];
      const drop = new Set(
        unused.flatMap(([from, to]) =>
          Array.from({ length: to - from + 1 }, (_, i) => from + i)
        ),
      );
      return [{ lines: lines.filter((_, i) => !drop.has(i)), position: 0 }];
    }) || progress;
    // Whole blocks, outermost first, from the top; after a success the pass
    // goes on from the same line.
    progress = await pass((position) =>
      blocks(lines)
        .filter(([h]) => h >= position)
        .map(([h, , , end]) => ({
          lines: [...lines.slice(0, h), ...lines.slice(end + 1)],
          position: h,
        }))
    ) || progress;
    // Unwrapping: keep a block's body in place of the block and its chain.
    progress = await pass((position) =>
      blocks(lines)
        .filter(([h]) => h >= position)
        .map(([h, open, close, end]) => ({
          lines: [
            ...lines.slice(0, h),
            ...lines.slice(open + 1, close),
            ...lines.slice(end + 1),
          ],
          position: h,
        }))
    ) || progress;
    // Single lines.
    progress = await pass((position) => {
      const out = [];
      for (let i = position; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === "{" || t === "}" || t === "" || t.startsWith("}")) continue;
        out.push({
          lines: [...lines.slice(0, i), ...lines.slice(i + 1)],
          position: i,
        });
      }
      return out;
    }) || progress;
    return progress;
  }

  for (let round = 0; round < 8 && tests < maxTests; round++) {
    let progress = false;
    while (tests < maxTests && await structure()) progress = true;
    // Subexpressions: a group replaced by a constant or by an operand.
    progress = await pass((position) => {
      const out = [];
      for (let i = position; i < lines.length; i++) {
        for (const [start, end] of groups(lines[i])) {
          const inner = lines[i].slice(start + 1, end);
          const options = [
            ...operands(inner).map((o) => `(${o})`),
            ...REPLACEMENTS,
          ];
          if (/^\(.*\)$/.test(inner)) options.unshift(inner);
          for (const r of options) {
            if (r === lines[i].slice(start, end + 1)) continue;
            const line = lines[i].slice(0, start) + r + lines[i].slice(end + 1);
            out.push({
              lines: [...lines.slice(0, i), line, ...lines.slice(i + 1)],
              position: i,
            });
          }
        }
        if (out.length > jobs * 8) {
          out.next = i + 1;
          break;
        }
      }
      return out;
    }) || progress;
    if (!progress) break;
  }
  return { source: lines.join("\n"), calls: current, tests };
}
