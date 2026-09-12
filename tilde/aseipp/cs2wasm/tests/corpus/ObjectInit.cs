// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public int X; public List<int> L = new(); public C Inner; }
public static class P { public static int F() { var c = new C { X = 1, L = { 1, 2 }, Inner = new C { X = 2 } }; return c.X + c.L.Count + c.Inner.X; } }
