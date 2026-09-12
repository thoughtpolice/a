// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { var a = new { X = x, Y = "s" }; var b = new { X = x, Y = "s" }; return a.X + a.Y.Length + (a.Equals(b) ? 10 : 0) + a.ToString().Length * 100; } }
