// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  buildArtifact,
  parseArtifactHTML,
} from "../skills/project-artifact/scripts/render.ts";
import {
  decodeUtf8,
  readWorkspaceFile,
  workspacePath,
  writeWorkspaceFile,
} from "../lib/files.ts";
import { result, type Tool, type ToolAPI } from "../lib/tool.ts";

interface Params {
  mode: "create" | "refresh";
  spec_file: string;
  output: string;
  previous?: string;
  overwrite?: boolean;
}
export default function projectArtifact(pi: ToolAPI): Tool<Params> {
  const T = pi.typebox.Type;
  return {
    name: "project_artifact",
    label: "Local project status artifact",
    description:
      "Render a private standalone offline status dashboard from supplied JSON evidence. Refresh reconciles the prior embedded state, preserves customizations, marks unsupplied rows stale, and reports deltas. No fetching or publishing. Read skill://project-artifact/references/spec.md for the JSON contract.",
    approval: "write",
    parameters: T.Object({
      mode: T.Union([T.Literal("create"), T.Literal("refresh")]),
      spec_file: T.String({ description: "Workspace JSON specification path" }),
      output: T.String({
        description: "Workspace HTML destination, at most 8 MiB",
      }),
      previous: T.Optional(
        T.String({
          description:
            "Previous workspace HTML for refresh; defaults to output",
        }),
      ),
      overwrite: T.Optional(
        T.Boolean({
          default: false,
          description:
            "Explicit permission to replace an existing regular file",
        }),
      ),
    }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      signal?.throwIfAborted();
      if (params.mode !== "create" && params.mode !== "refresh") {
        throw new Error("mode must be create or refresh");
      }
      if (params.mode === "create" && params.previous !== undefined) {
        throw new Error("previous is only accepted for refresh");
      }
      const input = await readWorkspaceFile(pi.cwd, params.spec_file);
      const outputPath = await workspacePath(pi.cwd, params.output);
      if (outputPath === input.path) {
        throw new Error("HTML output must not replace the JSON specification");
      }
      const previous = params.mode === "refresh"
        ? parseArtifactHTML(
          decodeUtf8(
            (await readWorkspaceFile(pi.cwd, params.previous ?? params.output))
              .bytes,
          ),
        )
        : undefined;
      const rendered = buildArtifact(
        JSON.parse(decodeUtf8(input.bytes)),
        previous,
      );
      signal?.throwIfAborted();
      const path = await writeWorkspaceFile(
        pi.cwd,
        params.output,
        rendered.html,
        params.overwrite ?? false,
      );
      return result({
        path,
        project_id: rendered.state.project_id,
        as_of: rendered.state.as_of,
        first_render: !previous,
        delta: rendered.delta,
        tabs: [
          "over",
          "work",
          ...rendered.state.sections.map((s) => s.id),
          "evidence",
        ],
        bytes: new TextEncoder().encode(rendered.html).length,
      });
    },
  };
}
