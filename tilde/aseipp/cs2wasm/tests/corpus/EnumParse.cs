// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public enum E { A = 1, B = 2 }
public static class P { public static int F(int x) => (int)Enum.Parse<E>("B") + (Enum.TryParse<E>("A", out var e) ? (int)e : 0) + (Enum.IsDefined((E)x) ? 10 : 0) + Enum.GetName((E)x).Length + Enum.GetValues<E>().Length; }
