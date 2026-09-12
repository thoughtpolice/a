// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F() { int[] a = {1,2,3}; return a is [1, .. var rest] ? rest.Length : 0; } }
