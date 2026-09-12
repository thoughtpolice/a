// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// [Describe] on a type that is not partial: DescribeGenerator reports
// PROBE001, which fails the compilation. The empty type draws PROBE002, a
// warning, which does not.
namespace Probe;

[Describe]
public partial struct Empty
{
}

[Describe]
public struct Sealed
{
    public int Value;
}
