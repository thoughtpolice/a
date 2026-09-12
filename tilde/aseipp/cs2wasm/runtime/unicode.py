# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Generates runtime/Unicode.cs, the char classification and invariant case
# mapping tables, from Python's Unicode Character Database with the
# corrections below: where Python's Unicode version is older than the
# CLR's, and where .NET's invariant casing keeps a character (U+0131,
# U+017F) or takes its simple titlecase (the Greek iota subscripts) rather
# than Python's full mapping. tests/Characters.cs checks the result against
# the CLR for every code unit; run this from anywhere after changing it:
#
#     python3 tilde/aseipp/cs2wasm/runtime/unicode.py

import os
import unicodedata


# .NET UnicodeCategory order.
CATS = ["Lu", "Ll", "Lt", "Lm", "Lo", "Mn", "Mc", "Me", "Nd", "Nl", "No", "Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Co",
        "Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po", "Sm", "Sc", "Sk", "So", "Cn"]

overrides = {
    "category": {str(key): value for key, value in {
    0x0897: 0x0005, 0x1B4E: 0x0018, 0x1B4F: 0x0018, 0x1B7F: 0x0018, 0x1C89: 0x0000, 0x1C8A: 0x0001,
    0x2427: 0x001C, 0x2428: 0x001C, 0x2429: 0x001C, 0x2FFC: 0x001C, 0x2FFD: 0x001C, 0x2FFE: 0x001C,
    0x2FFF: 0x001C, 0x31E4: 0x001C, 0x31E5: 0x001C, 0x31EF: 0x001C, 0xA7CB: 0x0000, 0xA7CC: 0x0000,
    0xA7CD: 0x0001, 0xA7DA: 0x0000, 0xA7DB: 0x0001, 0xA7DC: 0x0000,
    }.items()},
    "upper": {str(key): value for key, value in {
    0x0131: 0x0131, 0x017F: 0x017F, 0x019B: 0xA7DC, 0x0264: 0xA7CB, 0x1C8A: 0x1C89, 0x1F80: 0x1F88,
    0x1F81: 0x1F89, 0x1F82: 0x1F8A, 0x1F83: 0x1F8B, 0x1F84: 0x1F8C, 0x1F85: 0x1F8D, 0x1F86: 0x1F8E,
    0x1F87: 0x1F8F, 0x1F90: 0x1F98, 0x1F91: 0x1F99, 0x1F92: 0x1F9A, 0x1F93: 0x1F9B, 0x1F94: 0x1F9C,
    0x1F95: 0x1F9D, 0x1F96: 0x1F9E, 0x1F97: 0x1F9F, 0x1FA0: 0x1FA8, 0x1FA1: 0x1FA9, 0x1FA2: 0x1FAA,
    0x1FA3: 0x1FAB, 0x1FA4: 0x1FAC, 0x1FA5: 0x1FAD, 0x1FA6: 0x1FAE, 0x1FA7: 0x1FAF, 0x1FB3: 0x1FBC,
    0x1FC3: 0x1FCC, 0x1FF3: 0x1FFC, 0xA7CD: 0xA7CC, 0xA7DB: 0xA7DA, 0x10D70: 0x10D50, 0x10D71: 0x10D51,
    0x10D72: 0x10D52, 0x10D73: 0x10D53, 0x10D74: 0x10D54, 0x10D75: 0x10D55, 0x10D76: 0x10D56,
    0x10D77: 0x10D57, 0x10D78: 0x10D58, 0x10D79: 0x10D59, 0x10D7A: 0x10D5A, 0x10D7B: 0x10D5B,
    0x10D7C: 0x10D5C, 0x10D7D: 0x10D5D, 0x10D7E: 0x10D5E, 0x10D7F: 0x10D5F, 0x10D80: 0x10D60,
    0x10D81: 0x10D61, 0x10D82: 0x10D62, 0x10D83: 0x10D63, 0x10D84: 0x10D64, 0x10D85: 0x10D65,
    }.items()},
    "lower": {str(key): value for key, value in {
    0x1C89: 0x1C8A, 0xA7CB: 0x0264, 0xA7CC: 0xA7CD, 0xA7DA: 0xA7DB, 0xA7DC: 0x019B, 0x10D50: 0x10D70,
    0x10D51: 0x10D71, 0x10D52: 0x10D72, 0x10D53: 0x10D73, 0x10D54: 0x10D74, 0x10D55: 0x10D75,
    0x10D56: 0x10D76, 0x10D57: 0x10D77, 0x10D58: 0x10D78, 0x10D59: 0x10D79, 0x10D5A: 0x10D7A,
    0x10D5B: 0x10D7B, 0x10D5C: 0x10D7C, 0x10D5D: 0x10D7D, 0x10D5E: 0x10D7E, 0x10D5F: 0x10D7F,
    0x10D60: 0x10D80, 0x10D61: 0x10D81, 0x10D62: 0x10D82, 0x10D63: 0x10D83, 0x10D64: 0x10D84,
    0x10D65: 0x10D85,
    }.items()},
}


def category(c):
    key = str(c)
    if key in overrides.get("category", {}):
        return overrides["category"][key]
    return CATS.index(unicodedata.category(chr(c)))


def simple_upper(c):
    key = str(c)
    if key in overrides.get("upper", {}):
        return overrides["upper"][key]
    if 0xD800 <= c <= 0xDFFF:
        return c
    u = chr(c).upper()
    return ord(u) if len(u) == 1 and ord(u) < 0x10000 else c


def simple_lower(c):
    key = str(c)
    if key in overrides.get("lower", {}):
        return overrides["lower"][key]
    if 0xD800 <= c <= 0xDFFF:
        return c
    l = chr(c).lower()
    return ord(l) if len(l) == 1 and ord(l) < 0x10000 else c


def ranges(values):
    starts, vals = [], []
    prev = None
    for c in range(0x10000):
        v = values(c)
        if v != prev:
            starts.append(c)
            vals.append(v)
            prev = v
    return starts, vals


def case_ranges(mapping):
    # Runs of (start, count, delta, stride): code points start, start+stride, ... map by +delta.
    runs = []
    c = 0
    while c < 0x10000:
        d = mapping(c) - c
        if d == 0:
            c += 1
            continue
        # try stride 1
        n = 1
        while c + n < 0x10000 and mapping(c + n) - (c + n) == d:
            n += 1
        # try stride 2 (alternating: c+1 maps to itself or elsewhere)
        m = 1
        while (c + 2 * m < 0x10000 and mapping(c + 2 * m) - (c + 2 * m) == d
               and mapping(c + 2 * m - 1) - (c + 2 * m - 1) != d):
            m += 1
        if m > n and m > 1:
            runs.append((c, m, d, 2))
            c = c + 2 * (m - 1) + 1
        else:
            runs.append((c, n, d, 1))
            c += n
    return runs


def lit(chars):
    return '"' + ''.join('\\u%04X' % x for x in chars) + '"'


cat_starts, cat_vals = ranges(category)
upper = case_ranges(simple_upper)
lower = case_ranges(simple_lower)

# verify decoding
def decode(runs, c):
    for (s, n, d, stride) in runs:
        if s <= c <= s + stride * (n - 1) and (c - s) % stride == 0:
            return c + d
    return c

for c in range(0x10000):
    assert decode(upper, c) == simple_upper(c), c
    assert decode(lower, c) == simple_lower(c), c


out = []
out.append("""// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Unicode data for char's classification and invariant case mapping, as
// .NET has it, for the UTF-16 code units (and string casing above them),
// generated by runtime/unicode.py and checked against the CLR for every
// code unit by tests/Characters.cs. The tables are string literals, which
// reach a module only with a function that reads them.

namespace Gameplay.Runtime
{
    internal static class Unicode
    {""")

def emit_table(name, chars):
    # A literal holds at most 10000 characters.
    assert len(chars) <= 10000, name
    out.append(f"        private static string {name}() => {lit(chars)};\n")

emit_table("Latin1Categories", [category(c) for c in range(256)])
emit_table("CategoryStarts", cat_starts)
emit_table("CategoryValues", cat_vals)
for name, runs in (("Upper", upper), ("Lower", lower)):
    emit_table(name + "Starts", [r[0] for r in runs])
    emit_table(name + "Counts", [r[1] for r in runs])
    emit_table(name + "Deltas", [r[2] & 0xFFFF for r in runs])
    emit_table(name + "Strides", [r[3] for r in runs])

def supplementary(name, mapping):
    lines = [f"        public static int {name}(int point)", "        {"]
    c = 0x10000
    while c < 0x110000:
        d = mapping(c) - c
        if d == 0:
            c += 1
            continue
        n = 1
        while mapping(c + n) - (c + n) == d:
            n += 1
        m = 1
        while mapping(c + 2 * m) - (c + 2 * m) == d and mapping(c + 2 * m - 1) - (c + 2 * m - 1) != d:
            m += 1
        if m > n and m > 1:
            lines.append(f"            if (point >= 0x{c:X} && point <= 0x{c + 2 * (m - 1):X} && (point - 0x{c:X}) % 2 == 0)")
            lines.append("            {")
            lines.append(f"                return point + {d};")
            lines.append("            }")
            lines.append("")
            c = c + 2 * (m - 1) + 1
        else:
            lines.append(f"            if (point >= 0x{c:X} && point <= 0x{c + n - 1:X})")
            lines.append("            {")
            lines.append(f"                return point + {d};")
            lines.append("            }")
            lines.append("")
            c += n
    lines.append("            return point;")
    lines.append("        }")
    lines.append("")
    out.append(chr(10).join(lines))


def point_upper(c):
    key = str(c)
    if key in overrides.get("upper", {}):
        return overrides["upper"][key]
    u = chr(c).upper()
    return ord(u) if len(u) == 1 else c


def point_lower(c):
    key = str(c)
    if key in overrides.get("lower", {}):
        return overrides["lower"][key]
    l = chr(c).lower()
    return ord(l) if len(l) == 1 else c


supplementary("ToUpperSupplementary", point_upper)
supplementary("ToLowerSupplementary", point_lower)

out.append("""        // The last index whose start is at most the value.
        private static int Find(string starts, char value)
        {
            int low = 0;
            int high = starts.Length - 1;
            while (low < high)
            {
                int middle = (low + high + 1) >> 1;
                if (starts[middle] <= value)
                {
                    low = middle;
                }
                else
                {
                    high = middle - 1;
                }
            }

            return low;
        }

        // System.Globalization.UnicodeCategory's value.
        public static int Category(char value) =>
            value < 256 ? Latin1Categories()[value] : CategoryValues()[Find(CategoryStarts(), value)];

        private static char Map(char value, string starts, string counts, string deltas, string strides)
        {
            if (value < starts[0])
            {
                return value;
            }

            int index = Find(starts, value);
            int offset = value - starts[index];
            int stride = strides[index];
            return offset % stride == 0 && offset / stride < counts[index] ? (char)(value + deltas[index]) : value;
        }

        public static char ToUpper(char value) =>
            value < 128 ? (value >= 'a' && value <= 'z' ? (char)(value - 32) : value)
            : Map(value, UpperStarts(), UpperCounts(), UpperDeltas(), UpperStrides());

        public static char ToLower(char value) =>
            value < 128 ? (value >= 'A' && value <= 'Z' ? (char)(value + 32) : value)
            : Map(value, LowerStarts(), LowerCounts(), LowerDeltas(), LowerStrides());
    }
}
""")
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Unicode.cs'), 'w').write("\n".join(out))
