// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A module over tests/generator/Kinds.cs's library, both compiled with
// DescribeGenerator: each export is 1 when the generator was told the
// build it ran in, a module here and a library there, and their names.
namespace Probe;

public static class Built
{
    public static int ModuleKind() => Build.OutputKind == "module" ? 1 : 0;

    public static int LibraryKind() => ProbeKinds.Kinds.OutputKind == "library" ? 1 : 0;

    public static int Names() => Build.AssemblyName == "Gameplay" && ProbeKinds.Kinds.AssemblyName == "ProbeKinds" ? 1 : 0;
}
