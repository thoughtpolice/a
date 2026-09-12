// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public ref struct R { public int X; }
public static class P { public static int F() { var r = new R { X = 2 }; return r.X; } }
