// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Structural subset of OMP's injected CustomToolAPI; no runtime SDK dependency.
export interface SchemaBuilder {
  Object(fields: Record<string, object>, options?: Record<string, unknown>): object;
  String(options?: Record<string, unknown>): object;
  Integer(options?: Record<string, unknown>): object;
  Boolean(options?: Record<string, unknown>): object;
  Array(items: object, options?: Record<string, unknown>): object;
  Union(items: object[]): object;
  Literal(value: string): object;
  Optional(schema: object): object;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface ToolAPI {
  cwd: string;
  typebox: { Type: SchemaBuilder };
  exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<ExecResult>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

export interface Tool<P> {
  name: string;
  label: string;
  description: string;
  parameters: object;
  approval: "read" | "write" | "exec";
  execute(id: string, params: P, onUpdate?: (result: ToolResult) => void, ctx?: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export function result(details: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

export async function run(pi: ToolAPI, args: string[], signal?: AbortSignal): Promise<ExecResult> {
  signal?.throwIfAborted();
  const output = await pi.exec("buck2", args, { cwd: pi.cwd, signal });
  if (output.killed || signal?.aborted) throw new Error("Buck2 command cancelled");
  return output;
}

export async function checked(pi: ToolAPI, args: string[], signal?: AbortSignal): Promise<string> {
  const output = await run(pi, args, signal);
  if (output.code !== 0) {
    throw new Error(`buck2 ${args.join(" ")} failed (${output.code}): ${output.stderr || output.stdout}`);
  }
  return output.stdout;
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function literal(value: string): string {
  return JSON.stringify(value);
}
