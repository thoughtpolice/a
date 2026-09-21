// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Depot.CSharp.Tests;

// A csharp_test is a program: a non-zero exit status fails the test.
int failures = 0;

void Check(bool condition, string what)
{
    if (!condition)
    {
        Console.Error.WriteLine($"FAIL {what}");
        failures++;
    }
    else
    {
        Console.WriteLine($"ok   {what}");
    }
}

Check(Greeter.Greet("world") == "hello, world", "Greet");
Check(Greeter.SumOfSquares(5) == 30, "SumOfSquares");
Check(typeof(Greeter).Assembly.GetName().Name == "greeter", "assembly name follows the target name");
Check(Environment.GetEnvironmentVariable("CSHARP_TEST_ENV") == "set", "env reaches the test");
Check(args.Length == 1 && args[0] == "--from-build-file", "args reach the test");

return failures == 0 ? 0 : 1;
