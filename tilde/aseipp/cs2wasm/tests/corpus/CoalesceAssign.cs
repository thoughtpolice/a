// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public string S; public List<int> L; }
public static class P { public static int F(int x) { var c = new C(); c.S ??= "abc"; c.L ??= new List<int> { x }; int? n = null; n ??= x; string t = null; t ??= "q"; return c.S.Length + c.L[0] + n.Value + t.Length; } }
