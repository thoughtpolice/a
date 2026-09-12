// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public int X { get; init; } public required int Y { get; set; } }
public static class P { public static int F() => new C { X = 1, Y = 2 }.X; }
