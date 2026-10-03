#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Package reachable native component CSS and indexed authored-source maps."""

import json
import os
import pathlib

import svelte


def write_styles(manifest, reachable, output_directory, styles=()):
    parts, sections = [], []
    line = 0
    for style in styles:
        text = pathlib.Path(style).read_text()
        # Upstream generated CSS has no authored Svelte mappings. An explicit
        # unmapped section prevents inventing positions in the component map.
        sections.append({
            "offset": {"line": line, "column": 0},
            "map": {"version": 3, "sources": [], "names": [], "mappings": ""},
        })
        parts.append(text)
        line += text.count("\n") + 1
    for unit in sorted(svelte.records(manifest), key=lambda record: record["label"]):
        generated = unit.get("generated")
        if not generated:
            continue
        for item in sorted(generated["files"], key=lambda item: item["name"]):
            if not item["name"].endswith(".svelte"):
                continue
            javascript = svelte.generated_path(generated, item["source"], "client")
            if os.path.normpath(javascript) not in reachable:
                continue
            css = os.path.join(generated["directory"], "client", item["name"] + ".css")
            if not os.path.exists(css):
                continue
            text = pathlib.Path(css).read_text()
            footer = "\n/*# sourceMappingURL={}.map */\n".format(os.path.basename(css))
            if text.endswith(footer):
                text = text[:-len(footer)]
            with open(css + ".map") as stream:
                source_map = json.load(stream)
            sections.append({"offset": {"line": line, "column": 0}, "map": source_map})
            parts.append(text)
            line += text.count("\n") + 1
    pathlib.Path(output_directory, "app.css").write_text("\n".join(parts) + "\n/*# sourceMappingURL=app.css.map */\n")
    pathlib.Path(output_directory, "app.css.map").write_text(json.dumps({"version": 3, "file": "app.css", "sections": sections}, separators=(",", ":")))
