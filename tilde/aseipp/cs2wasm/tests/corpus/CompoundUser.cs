// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public int X; public static C operator +(C a, int b) => new C { X = a.X + b }; }
public static class P { public static int F() { var c = new C(); c += 3; return c.X; } }
