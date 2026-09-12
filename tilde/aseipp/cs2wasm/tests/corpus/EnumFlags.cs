// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
[Flags] public enum E { A = 1, B = 2 }
public static class P { public static int F() => (E.A | E.B).HasFlag(E.B) ? 1 : 0; }
