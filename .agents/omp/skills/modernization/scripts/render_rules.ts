// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// Modified adaptation of Anthropic render_rules.py, Apache-2.0, ab024cdc.
import { list, md, object, text } from "./common.ts";
export function renderRules(value: unknown) {
  const spec = object(value), system = md(text(spec.system, 100));
  const categories = ["Calculation", "Validation", "Lifecycle", "Policy"];
  const rules = list(spec.confirmedRules ?? [], 2000).map((v) => object(v))
    .sort((a, b) => {
      const ca = categories.indexOf(String(a.category)),
        cb = categories.indexOf(String(b.category));
      const priorityA = String(a.priority ?? "P1"),
        priorityB = String(b.priority ?? "P1"),
        sourceA = String(a.source),
        sourceB = String(b.source);
      return (ca < 0 ? 9 : ca) - (cb < 0 ? 9 : cb) ||
        (priorityA < priorityB ? -1 : priorityA > priorityB ? 1 : 0) ||
        (sourceA < sourceB ? -1 : sourceA > sourceB ? 1 : 0);
    });
  const doc = [
    `# Business Rules — ${system}`,
    "",
    "Cataloged claims, not execution evidence. Citation/adversarial review decisions must be retained separately; rendering does not confirm a rule.",
    "",
    "| ID | Name | Category | Priority | Source | Confidence |",
    "|---|---|---|---|---|---|",
  ];
  const cards: string[] = [], questions: string[] = [];
  let currentCategory = "";
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i],
      id = `RULE-${String(i + 1).padStart(3, "0")}`,
      name = md(text(r.name, 300)),
      source = text(r.source, 1000);
    const citation = /^\s*`?([^\s`:,;()]+):(\d+)(?:\s*[-–]\s*(\d+))?/.exec(
      source,
    );
    if (
      !citation || Number(citation[2]) < 1 ||
      citation[3] && Number(citation[3]) < Number(citation[2])
    ) throw new Error("Rule source requires path:line[-line] citation");
    const primary = `${citation[1]}:${citation[2]}${
        citation[3] ? `-${citation[3]}` : ""
      }`,
      also = source.slice(citation[0].length).replace(
        /^[\s`;,.–-]*(?:also\s+)?/i,
        "",
      );
    const priority = text(r.priority, 2),
      confidence = text(r.confidence, 20),
      category = text(r.category, 40);
    if (
      !/^P[012]$/.test(priority) ||
      !["High", "Medium", "Low"].includes(confidence)
    ) throw new Error("Unknown rule priority/confidence");
    doc.push(
      `| ${id} | ${name} | ${md(category)} | ${priority} | ${
        md(primary)
      } | ${confidence} |`,
    );
    const group = categories.includes(category) ? category : "Other";
    if (group !== currentCategory) {
      cards.push(`## ${group}`, "");
      currentCategory = group;
    }
    cards.push(
      `### ${id}: ${name}`,
      `**Category:** ${md(category)}`,
      `**Priority:** ${priority}`,
      `**Source:** ${md(primary)}`,
    );
    if (also) cards.push(`**Also cited:** ${md(also)}`);
    cards.push(
      `**Plain English:** ${md(text(r.plainEnglish))}`,
      "**Specification:**",
      `  Given ${md(text(r.given))}`,
      `  When ${md(text(r.when))}`,
      `  Then ${md(text(r.then))}`,
    );
    if (r.and !== undefined) cards.push(`  And ${md(text(r.and))}`);
    if (r.parameters !== undefined) {
      cards.push(`**Parameters:** ${md(text(r.parameters))}`);
    }
    const edges = list(r.edgeCases ?? [], 100).map((v) => md(text(v)));
    if (edges.length) cards.push(`**Edge cases handled:** ${edges.join("; ")}`);
    if (r.suspectedDefect !== undefined) {
      cards.push(`**Suspected defect:** ${md(text(r.suspectedDefect))}`);
    }
    cards.push(`**Confidence:** ${confidence}`, "");
    if (confidence !== "High" || r.smeQuestion !== undefined) {
      questions.push(`- ${id}: ${
        md(
          r.smeQuestion === undefined
            ? "Confirm the behavior with a domain owner"
            : text(r.smeQuestion),
        )
      }`);
    }
  }
  doc.push(
    "",
    ...cards,
    "## Rules requiring domain-owner confirmation",
    "",
    ...(questions.length ? questions : [
      "No confirmation questions supplied; this does not imply human approval.",
    ]),
  );
  for (
    const [key, heading] of [
      ["rejectedRules", "Rejected candidates"],
      ["unverifiedRules", "Unverified candidates"],
      ["foldedRules", "Folded rules"],
      ["coverageGaps", "Coverage gaps"],
      ["injectionFlags", "Instruction-shaped source content"],
    ]
  ) {
    const items = list(spec[key] ?? [], 2000);
    if (items.length) {
      doc.push(
        "",
        `## ${heading}`,
        "",
        ...items.map((v) =>
          `- ${md(typeof v === "string" ? v : JSON.stringify(v))}`
        ),
      );
    }
  }
  const objects = [`# Data Objects — ${system}`, ""];
  for (const value of list(spec.dataObjects ?? [], 2000)) {
    const o = object(value);
    objects.push(
      `## ${md(text(o.name))}`,
      `Source: ${md(text(o.source))}`,
      "",
      "| Field | Type | Note |",
      "|---|---|---|",
    );
    for (const value of list(o.fields ?? [], 500)) {
      const f = object(value);
      objects.push(
        `| ${md(text(f.name))} | ${md(text(f.type))} | ${md(f.note ?? "")} |`,
      );
    }
    objects.push(
      "",
      `Used by: ${
        list(o.consumedBy ?? [], 100).map((v) => md(text(v))).join(", ")
      }`,
      "",
    );
  }
  return {
    rules: doc.join("\n") + "\n",
    dataObjects: objects.join("\n") + "\n",
    count: rules.length,
  };
}
