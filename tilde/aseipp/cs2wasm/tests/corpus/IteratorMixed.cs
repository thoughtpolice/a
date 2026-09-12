// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { static IEnumerable<int> Gen(int n) { lock (typeof(P)) { using var d = (IDisposable)null; for (int i = 0; i < n; i++) { try { yield return i; } finally { n--; } } } }
 static IEnumerable<string> Pairs(Dictionary<string, int> map) { foreach (var (k, v) in map) { if (v > 0) yield return k + v; else continue; } }
public static int F(int x) { int s = 0; foreach (var v in Gen(x)) s += v; foreach (var p in Pairs(new() { ["a"] = x, ["b"] = -1 })) s += p.Length; return s; } }
