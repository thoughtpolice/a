// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { string a = "ab" + x; string b = "ab" + x; return a.GetHashCode() == b.GetHashCode() ? 1 : 0; } }
