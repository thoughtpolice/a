// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public List<int> L = new(); public Dictionary<int, string> D = new(); public C Inner = new C2(); }
public class C2 : C { }
public static class P { public static int F(int x) { var c = new C { L = { 1, 2 }, D = { [1] = "a", [2] = "b" } }; return c.L.Count + c.D.Count; } }
