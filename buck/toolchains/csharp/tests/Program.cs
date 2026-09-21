// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Runtime.CompilerServices;
using Depot.CSharp.Tests;

// Prints a greeting and reports how it was compiled, so a test can check
// that each profile really produced what it claims:
//   --expect-dynamic-code true|false   JIT profiles support dynamic code,
//                                      NativeAOT does not
//   --expect-pgo true|false            whether TieredPGO is switched on
string? expectDynamicCode = null;
string? expectPgo = null;
for (int i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--expect-dynamic-code":
            expectDynamicCode = args[++i];
            break;
        case "--expect-pgo":
            expectPgo = args[++i];
            break;
        default:
            Console.Error.WriteLine($"unknown argument {args[i]}");
            return 2;
    }
}

bool dynamicCode = RuntimeFeature.IsDynamicCodeSupported;
bool pgo = AppContext.TryGetSwitch("System.Runtime.TieredPGO", out bool enabled) && enabled;

Console.WriteLine(Greeter.Greet("buck2"));
Console.WriteLine($"sum-of-squares={Greeter.SumOfSquares(5)}");
Console.WriteLine($"dynamic-code={dynamicCode}");
Console.WriteLine($"tiered-pgo={pgo}");

if (expectDynamicCode != null && bool.Parse(expectDynamicCode) != dynamicCode)
{
    Console.Error.WriteLine("dynamic code support does not match the profile");
    return 1;
}
if (expectPgo != null && bool.Parse(expectPgo) != pgo)
{
    Console.Error.WriteLine("TieredPGO does not match the profile");
    return 1;
}
return 0;
