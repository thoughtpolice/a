// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public readonly struct R { public readonly int X; public R(int x) { X = x; } public int Twice() => X * 2; }
public static class P { public static int F() => new R(3).Twice(); }
