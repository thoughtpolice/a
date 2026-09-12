// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The CLR side of tests/engine.mjs: each line of the file it is given
// names a static method of a class of Kiln.Tests (Class.Method) and its
// integer arguments,
// and it prints `method(args) = result` for each, as the runner prints the
// module's.
using System;
using System.IO;
using System.Linq;
using System.Reflection;

foreach (string line in File.ReadAllLines(args[0]))
{
    string[] words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    int dot = words[0].IndexOf('.');
    var type = Assembly.GetExecutingAssembly().GetType("Kiln.Tests." + words[0][..dot], throwOnError: true);
    var method = type.GetMethod(words[0][(dot + 1)..], BindingFlags.Public | BindingFlags.Static)
        ?? throw new MissingMethodException(words[0]);
    object[] arguments = words.Skip(1).Select(word => (object)int.Parse(word)).ToArray();
    object result = method.Invoke(null, arguments);
    Console.WriteLine($"{words[0]}({string.Join(",", words.Skip(1))}) = {result}");
}
