// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The CLR's answers for Probe.cs's exports, one `name value` line each, in
// the form tests/generators.mjs prints the module's.
using System;

Console.WriteLine("FieldCounts " + Probe.Checks.FieldCounts());
Console.WriteLine("DescriptionLength " + Probe.Checks.DescriptionLength());
Console.WriteLine("DescriptionHash " + Probe.Checks.DescriptionHash());
Console.WriteLine("DescribesPoint " + (Probe.Checks.DescribesPoint() ? 1 : 0));
