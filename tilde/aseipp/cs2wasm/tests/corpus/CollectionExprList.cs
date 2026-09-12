// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F() { List<int> l = [1, 2, 3]; int[] a = [..l, 4]; return a.Length; } }
