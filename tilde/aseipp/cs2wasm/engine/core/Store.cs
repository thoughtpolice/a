// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

/// <summary>
/// Saved data as text: <c>key=value</c> lines, keys in order, which the
/// platform keeps in a file of the save directory. Unknown keys survive a
/// load and a save, so an older game keeps a newer one's settings.
/// </summary>
public sealed class KeyValues
{
    private readonly SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.Ordinal);

    public int Count => values.Count;

    public static KeyValues Parse(string text)
    {
        var parsed = new KeyValues();
        foreach (string line in (text ?? "").Split('\n'))
        {
            int equals = line.IndexOf('=');
            if (equals > 0)
            {
                parsed.values[line.Substring(0, equals).Trim()] = line.Substring(equals + 1).Trim();
            }
        }

        return parsed;
    }

    public string Serialize()
    {
        var text = new StringBuilder();
        foreach (var (key, value) in values)
        {
            text.Append(key).Append('=').Append(value).Append('\n');
        }

        return text.ToString();
    }

    public string Get(string key, string fallback = "") => values.TryGetValue(key, out string value) ? value : fallback;

    public int GetInt(string key, int fallback = 0) =>
        values.TryGetValue(key, out string value) && int.TryParse(value, out int parsed) ? parsed : fallback;

    public bool GetBool(string key, bool fallback = false) => values.TryGetValue(key, out string value) ? value == "1" : fallback;

    public void Set(string key, string value) => values[key] = value.Replace('\n', ' ');

    public void Set(string key, int value) => values[key] = value.ToString();

    public void Set(string key, bool value) => values[key] = value ? "1" : "0";

    public IEnumerable<string> Keys => values.Keys;

    /// <summary>ASCII bytes of the text; anything else becomes '?'.</summary>
    public static byte[] Encode(string text)
    {
        var bytes = new byte[text.Length];
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            bytes[index] = character < 128 ? (byte)character : (byte)'?';
        }

        return bytes;
    }

    public static string Decode(byte[] bytes)
    {
        var text = new StringBuilder(bytes.Length);
        foreach (byte value in bytes)
        {
            text.Append(value < 128 ? (char)value : '?');
        }

        return text.ToString();
    }
}
