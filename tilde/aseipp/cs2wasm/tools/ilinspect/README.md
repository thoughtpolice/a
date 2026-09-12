<!--
SPDX-FileCopyrightText: © 2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# ilinspect

Prints what an assembly's metadata says, for working on the CIL importer
(`docs/IMPORTER.md`): what a framework assembly references, which types a
facade forwards, and the IL of the methods that fail to import.

```sh
buck2 run tilde//aseipp/cs2wasm/tools/ilinspect:ilinspect -- <assembly> [mode]
```

The modes:

- `all` (the default): all of the below but `il`.
- `refs`: the assembly references, with versions.
- `types`: the types defined (visibility, name, method count) and the types
  forwarded elsewhere (a reference assembly's facades).
- `typerefs`: the type references, each with the assembly it resolves
  through.
- `memberrefs`: the member references, by their type (a generic instance by
  its definition).
- `il METHOD`: the exception regions and IL of each method whose
  `Type::Method` contains `METHOD`, tokens by name.

When the pinned .NET SDK changes, the framework assemblies gameplayc imports
(`$(location toolchains//csharp:dotnet)/shared/Microsoft.NETCore.App/*/`)
are the ones to look at: `refs` and `typerefs` show what a new version
reaches that the CoreLib may not define, next to the member lists that
`GAMEPLAYC_DUMP_REFERENCES` writes for `corelib/framework/*.txt`; `il`
shows the body behind an import error. Its sibling `tools/bclscan` measures
what of the whole class library could be imported.
