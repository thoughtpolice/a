// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A library (ProbeKinds) compiled with DescribeGenerator: what its
// generator was told of the build, for tests/generator/Built.cs.
namespace ProbeKinds;

public static class Kinds
{
    public static string OutputKind => Probe.Build.OutputKind;

    public static string AssemblyName => Probe.Build.AssemblyName;
}
