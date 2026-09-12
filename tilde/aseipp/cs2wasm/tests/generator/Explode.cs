// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DescribeGenerator throws for this type; a generator that throws fails the
// compilation.
namespace Probe;

[Describe(Explode = true)]
public partial struct Bomb
{
    public int Fuse;
}
