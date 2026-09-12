<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# bclscan

Measures how much of the .NET class library's IL could be imported onto
Wasm GC without linear memory. Starting from an allowlist of public API
entry points, it walks the IL call graph (with a rough RTA for virtual calls),
classifies every reachable method body by what blocks a Wasm GC lowering
(pointers, pinning, byte reinterpretation, hardware intrinsics, runtime
calls, reflection, threading, GC APIs), and reports the result under four
scenarios: raw, constant-folded feature switches and intrinsics, folded plus
the byref forms gameplayc can represent, and that plus whole-type proxies. It
also reports which assemblies were built with runtime async.

It informed the decision to import IL above a gameplay-specific CoreLib rather
than the framework's own CoreLib; rerun it when the pinned .NET release
changes to see what moved (and `tools/ilinspect` for one assembly's
references and IL).

```sh
buck2 run tilde//aseipp/cs2wasm/tools/bclscan:bclscan -- \
  <sdk>/shared/Microsoft.NETCore.App/<version> out.md \
  <asyncprobe_default.dll> <asyncprobe_runtime_async.dll>
```

`<sdk>` is the toolchain's SDK directory under `buck-out`
(`buck2 build toolchains//csharp:... --show-full-output`), and the two probe
assemblies are this package's `:asyncprobe_default` and
`:asyncprobe_runtime_async`. For a NativeAOT framework, pass colon-separated
directories as the first argument. `BCLSCAN_WHY='<group>|<method>'` prints why
a method is reached; a trailing `|tp` applies the type proxies.
