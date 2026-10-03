#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Consumer graph boundaries using the real native parser, never parser mocks.

Usage: native_graph_test.py NATIVE_COMMAND
The Buck runner depends on the packaged graph/Svelte helper library.
"""

import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import unittest

import imports as graph

COMMAND = shlex.split(sys.argv[1])


class NativeGraphTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="web-native-graph-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.types = self.file("platform.d.ts", "export {};\n")

    def file(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return os.path.relpath(path)

    def unit(self, label, srcs, deps=(), exports=None, **extra):
        return dict(label=label, srcs=srcs, deps=list(deps), exports=exports or {}, **extra)

    def manifest(self, unit, *libraries):
        return dict(unit=unit, libraries=list(libraries), platform={
            "types": [self.types],
            "externals": ["host:*"],
        })

    def reject(self, manifest, *messages, browser=False):
        with self.assertRaises(graph.GraphError) as failure:
            if browser:
                graph.check_browser_graph(manifest, COMMAND, manifest["unit"]["srcs"][0])
            else:
                graph.check_graph(manifest, COMMAND)
        for message in messages:
            self.assertIn(message, str(failure.exception))

    def runtime(self, manifest):
        # Local pinned-package fixtures exercise real filesystem confinement.
        packages = {}
        for name in ("svelte", "svelte2tsx", "clsx", "esm-env", "devalue", "esrap", "estree", "magic-string", "locate-character", "sourcemap-codec"):
            directory = self.root / "runtime" / name
            directory.mkdir(parents=True, exist_ok=True)
            packages[name] = str(directory)
        self.file("runtime/svelte/package.json", json.dumps({"exports": {".": {"types": "./types/index.d.ts", "default": "./index.js"}, "./internal/client": "./internal.js", "./server": "./server.js"}}))
        for name in ("svelte/types/index.d.ts", "svelte/index.js", "svelte/internal.js", "svelte/server.js", "svelte2tsx/svelte-shims-v4.d.ts", "svelte2tsx/svelte-jsx-v4.d.ts"):
            self.file("runtime/" + name, "export {};\n")
        manifest["runtime"] = packages
        return manifest

    def test_code_types_reexports_dynamic_json_and_comment_lookalikes(self):
        root = self.file("app/main.ts", '''import type { Item } from './types.ts';
export { value } from './value.ts';
import data from './data.json' with { type: 'json' };
export const load = () => import('./value.ts');
const text = "import('npm:pretend')";
// import 'node:pretend';
export type Other = import('./types.ts').Item;
''')
        types = self.file("app/types.ts", "export type Item = number;\n")
        value = self.file("app/value.ts", "export const value = 1;\n")
        data = self.file("app/data.json", '{"value":1}\n')
        manifest = self.manifest(self.unit("app", [root, types, value, data]))
        self.assertEqual(graph.check_graph(manifest, COMMAND), sorted([root, types, value]))

    def test_import_and_type_metadata_edges_enforce_direct_dependencies(self):
        dep = self.file("dep/mod.ts", "export type Item = number;\n")
        mid = self.file("mid/mod.ts", "export const value = 1;\n")
        libraries = [self.unit("dep", [dep], exports={"@dep": dep}), self.unit("mid", [mid], ["dep"], {"@mid": mid})]
        for text in (
            'import type { Item } from "@dep";\n',
            'export type { Item } from "@dep";\n',
            'type Item = import("@dep").Item;\n',
            'const load = () => import(`@dep`);\n',
            '/// <reference types="@dep" />\n',
            '// @ts-self-types="@dep"\nexport {};\n',
            '// @ts-types="@dep"\nexport {};\n',
            '// @deno-types="@dep"\nexport {};\n',
            '/** @type {import("@dep").Item} */\nlet item;\n',
            '/** @import { Item } from "@dep" */\nlet item;\n',
        ):
            with self.subTest(text=text):
                root = self.file("app/main.ts", text)
                manifest = self.manifest(self.unit("app", [root], ["mid"]), *libraries)
                self.reject(manifest, '"@dep" comes from dep, which is not a direct dependency of app')
                manifest["unit"]["deps"].append("dep")
                self.assertEqual(graph.check_graph(manifest, COMMAND), [root])

    def test_relative_path_type_reference_and_symlink_escape(self):
        hidden = self.file("outside/hidden.ts", "export {};\n")
        root = self.file("app/main.ts", '/// <reference path="../outside/hidden.ts" />\nexport {};\n')
        manifest = self.manifest(self.unit("app", [root]))
        self.reject(manifest, 'relative import "../outside/hidden.ts" leaves the srcs of app', "not in the srcs of any target")
        (self.root / "app" / "link.ts").symlink_to(self.root / "outside" / "hidden.ts")
        self.file("app/main.ts", 'import "./link.ts";\n')
        self.reject(manifest, 'relative import "./link.ts" leaves the srcs of app')
        manifest["unit"]["srcs"].append(hidden)
        self.assertEqual(graph.check_graph(manifest, COMMAND), sorted([root, hidden]))

    def test_computed_import_reports_authored_unicode_position(self):
        root = self.file("app/main.ts", '// café\nconst name = "./helper.ts";\nconst load = () => import(name);\n')
        self.reject(self.manifest(self.unit("app", [root])), root + ":3:", "computed dynamic import name", "literal module specifier")

    def test_protocols_and_malformed_source_fail_closed(self):
        for raw in ("npm:x", "jsr:x", "node:fs", "https://example.com/mod.ts", "data:text/javascript,export default 1"):
            with self.subTest(raw=raw):
                root = self.file("app/main.ts", "import {};\n".format(json.dumps(raw)))
                self.reject(self.manifest(self.unit("app", [root])), 'unsupported import "' + raw + '"')
        root = self.file("app/main.ts", 'import { from "./hidden.ts";\n')
        self.reject(self.manifest(self.unit("app", [root])), root)

    def test_runtime_imports_require_explicit_platform_policy(self):
        root = self.file("app/main.ts", 'import "cloudflare:workers";\n')
        manifest = self.manifest(self.unit("app", [root]))
        self.reject(manifest, 'unsupported import "cloudflare:workers"')
        manifest["platform"]["externals"] = ["cloudflare:*"]
        self.assertEqual(graph.check_graph(manifest, COMMAND), [root])
        self.reject(manifest, 'runtime import "cloudflare:workers" is not allowed in a browser graph', browser=True)

    def test_externals_cannot_exempt_sources_or_shadow_dependency_exports(self):
        outside = self.file("outside/hidden.ts", "export const value = 1;\n")
        root = self.file("app/main.ts", 'import "../outside/hidden.ts";\n')
        manifest = self.manifest(self.unit("app", [root]))
        manifest["platform"]["externals"] = ["*"]
        self.reject(manifest, 'relative import "../outside/hidden.ts" leaves the srcs of app')
        file_url = pathlib.Path(os.path.abspath(outside)).as_uri()
        for raw in (file_url, "FILE:" + file_url[len("file:"):]):
            with self.subTest(specifier=raw):
                self.file("app/main.ts", "import {};\n".format(json.dumps(raw)))
                self.reject(manifest, 'relative import "{}" leaves the srcs of app'.format(raw))
        self.file("app/main.ts", 'import { value } from "@dep";\nexport { value };\n')
        dep = self.unit("dep", [outside], exports={"@dep": outside})
        manifest["libraries"] = [dep]
        manifest["platform"]["externals"] = ["@dep"]
        manifest["unit"]["deps"] = ["dep"]
        self.reject(manifest, 'declared external "@dep" conflicts with a dependency export')

    def test_browser_ignores_unused_and_type_only_server_dependencies(self):
        server = self.file("kit/server.ts", 'import { render } from "svelte/server";\nexport { render };\n')
        client = self.file("kit/client.ts", "export const mount = () => {};\n")
        root = self.file("app/main.ts", 'import { mount } from "@kit/client";\nimport type { render } from "@kit/server";\nmount();\n')
        unused = self.file("app/unused-server.ts", 'export { HostObject } from "host:runtime";\n')
        library = self.unit("kit", [server, client], exports={"@kit/server": server, "@kit/client": client})
        manifest = self.manifest(self.unit("app", [root, unused], ["kit"]), library)
        self.assertEqual(graph.check_browser_graph(manifest, COMMAND, root), {root, client})
        self.file("app/main.ts", 'import { render } from "@kit/server";\nrender();\n')
        self.reject(manifest, server + ":1:", 'runtime import "svelte/server" is not allowed in a browser graph', browser=True)

    def test_browser_rejects_declared_host_externals_through_first_party_module(self):
        server = self.file("kit/server.ts", 'import { HostObject } from "host:runtime";\nexport { HostObject };\n')
        root = self.file("app/main.ts", 'export { HostObject } from "@kit/server";\n')
        manifest = self.manifest(self.unit("app", [root], ["kit"]), self.unit("kit", [server], exports={"@kit/server": server}))
        self.reject(manifest, 'runtime import "host:runtime" is not allowed in a browser graph', browser=True)
        self.assertEqual(graph.check_graph(manifest, COMMAND), [root])

    def test_wasm_shim_source_phase_external_preserves_direct_dependency_check(self):
        module = self.root / "dep" / "empty.wasm"
        module.parent.mkdir(parents=True)
        module.write_bytes(bytes([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0]))
        self.file("shims/empty.wasm.d.ts", "declare const module: WebAssembly.Module; export default module;\n")
        self.file("shims/empty.wasm.js", '// @ts-self-types="./empty.wasm.d.ts"\nimport source module from "../dep/empty.wasm";\nexport default module;\n')
        root = self.file("app/main.ts", 'import module from "@dep/wasm";\nexport { module };\n')
        dep = self.unit("dep", [], wasm={"@dep/wasm": {"path": os.path.relpath(module), "module": "empty.wasm"}})
        manifest = self.manifest(self.unit("app", [root], ["dep"]), dep)
        wasm_dir = str(self.root / "shims")
        self.assertEqual(graph.check_graph(manifest, COMMAND, wasm_dir), [root])
        manifest["unit"]["deps"] = []
        with self.assertRaises(graph.GraphError) as failure:
            graph.check_graph(manifest, COMMAND, wasm_dir)
        self.assertIn('"@dep/wasm" comes from dep, which is not a direct dependency of app', str(failure.exception))

    def test_pinned_runtime_is_not_an_application_relative_import_bypass(self):
        root = self.file("app/main.ts", 'import "../runtime/svelte/index.js";\n')
        manifest = self.runtime(self.manifest(self.unit("app", [root], svelte_runtime=True)))
        self.reject(manifest, 'relative import "../runtime/svelte/index.js" leaves the srcs of app')
        self.file("app/main.ts", 'import "svelte/internal/client";\n')
        self.reject(manifest, 'unsupported import "svelte/internal/client"')
        self.file("app/main.ts", 'import "svelte";\n')
        self.assertEqual(graph.check_graph(manifest, COMMAND), [root])
        self.assertEqual(graph.check_browser_graph(manifest, COMMAND, root), {root})

    def test_declared_first_party_source_never_inherits_runtime_directory_trust(self):
        root = os.path.relpath(self.root / "runtime" / "svelte" / "index.js")
        manifest = self.runtime(self.manifest(self.unit("app", [root], svelte_runtime=True)))
        self.file("runtime/svelte/index.js", 'import "./internal.js";\n')
        self.reject(manifest, 'relative import "./internal.js" leaves the srcs of app')

    def test_pinned_runtime_cannot_follow_a_symlink_outside_its_roots(self):
        root = self.file("app/main.ts", 'import "svelte";\n')
        manifest = self.runtime(self.manifest(self.unit("app", [root], svelte_runtime=True)))
        escaped = self.file("outside/module.d.ts", "export {};\n")
        (self.root / "runtime" / "svelte" / "types" / "escape.d.ts").symlink_to(os.path.abspath(escaped))
        self.file("runtime/svelte/types/index.d.ts", 'export * from "./escape.d.ts";\n')
        self.reject(manifest, 'relative import "./escape.d.ts" leaves the pinned toolchain inputs')

    def test_generated_view_does_not_hide_authored_imports(self):
        source = self.file("app/Widget.svelte", '<script>import { HostObject } from "host:runtime";</script><p>hello</p>\n')
        output = str(self.root / "generated")
        inputs = self.file("inputs.json", json.dumps({"files": [{"source": source, "name": "app/Widget.svelte"}]}))
        result = subprocess.run(COMMAND + ["compile", "--manifest", inputs, "--out-dir", output], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        generated = {"directory": output, "files": [{"source": source, "name": "app/Widget.svelte"}], "data": []}
        manifest = self.runtime(self.manifest(self.unit("app", [source], generated=generated)))
        self.reject(manifest, source, 'runtime import "host:runtime" is not allowed in a browser graph', browser=True)


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1])
