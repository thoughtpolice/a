// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln
{
    using Sdk = global::Console.Sdk;

    /// <summary>
    /// Saved text files in the console's save directory, through its files
    /// interface: whole files read and written, closed at once.
    /// </summary>
    internal static class Saves
    {
        /// <summary>Whether what is written outlasts the session.</summary>
        public static bool Persistent =>
            (Sdk.SystemInterface.Info().Features & Sdk.SystemInterface.Features.PersistentStorage) != 0;

        /// <summary>A file's text, or null when there is none.</summary>
        public static string Read(string path)
        {
            var file = Sdk.Files.Open(path, false);
            if (file is null)
            {
                return null;
            }

            try
            {
                return file.ReadAt(0, (uint)file.Size()) switch
                {
                    Sdk.Game.Ok<byte[]> read => KeyValues.Decode(read.Value),
                    _ => null,
                };
            }
            finally
            {
                file.Dispose();
            }
        }

        /// <summary>Writes a file's text whole, replacing it; false when it cannot.</summary>
        public static bool Write(string path, string text)
        {
            var file = Sdk.Files.Open(path, true);
            if (file is null)
            {
                return false;
            }

            try
            {
                var bytes = KeyValues.Encode(text);
                return file.WriteAt(0, bytes) == bytes.Length;
            }
            finally
            {
                file.Dispose();
            }
        }

        public static KeyValues Load(string path) => KeyValues.Parse(Read(path) ?? "");

        public static bool Save(string path, KeyValues values) => Write(path, values.Serialize());
    }
}
