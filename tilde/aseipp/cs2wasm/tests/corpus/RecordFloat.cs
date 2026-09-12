// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public record R(float X, double Y);
public static class P { public static int F(int x) { object o = new R(x / 3f, x / 7.0); return o.ToString().Length; } }
