// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `files` in files.wit, which tests/wit-tasks.mjs
// has Wasmtime run over a directory of its own when it is installed.
using System.Collections.Generic;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace Test.Files;

public static partial class Files
{
    public static partial async Task<string> Probe(string link)
    {
        var directory = Preopens.GetDirectories()[0].Item0;

        // An async method whose result the host allocates.
        string target = await directory.ReadlinkAt(link) switch
        {
            Ok<string>(var path) => path,
            _ => "?",
        };

        // A stream of records holding strings, and its outcome.
        var listing = directory.ReadDirectory();
        var names = new List<string>();
        await foreach (var entry in listing.Item0)
        {
            names.Add(entry.Type is WasiFilesystemTypes.DescriptorTypeSymbolicLink ? entry.Name + "@" : entry.Name);
        }

        listing.Item0.Dispose();
        bool listed = await listing.Item1.ReadAsync() is Ok<Unit>;
        names.Sort((a, b) => string.CompareOrdinal(a, b));
        string summary = target + "|" + string.Join(",", names) + "|" + listed;

        // A stream the module writes: its bytes to standard output.
        var (bytes, output) = NewStreamU8();
        var written = Stdout.WriteViaStream(bytes);
        var text = new byte[summary.Length + 1];
        for (int index = 0; index < summary.Length; index++)
        {
            text[index] = (byte)summary[index];
        }

        text[summary.Length] = (byte)'\n';
        int count = await output.WriteAsync(text);
        output.Dispose();
        bool flushed = await written.ReadAsync() is Ok<Unit>;
        return summary + "|" + count + "|" + flushed;
    }
}
