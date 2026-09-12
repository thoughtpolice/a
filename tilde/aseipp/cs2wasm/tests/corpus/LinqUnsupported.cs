// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;
public static class P { public static int F(int x) { var xs = new List<string> { "b", "a" + x }; int s = 0; foreach (var w in xs.OrderBy(w => w, StringComparer.Ordinal)) s += w.Length; foreach (var o in xs.Cast<object>()) s++; return s + xs.Select(w => new { w, n = w.Length }).Sum(p => p.n); } }
