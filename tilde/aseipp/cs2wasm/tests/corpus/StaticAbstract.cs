// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public interface IZero<T> where T : IZero<T> { static abstract T Zero { get; } static abstract T operator +(T a, T b); }
public struct V : IZero<V> { public int X; public static V Zero => new V(); public static V operator +(V a, V b) => new V { X = a.X + b.X }; }
public static class P { static T Sum<T>(T[] xs) where T : IZero<T> { T s = T.Zero; foreach (var x in xs) s += x; return s; }
public static int F(int x) => Sum(new[] { new V { X = 1 }, new V { X = x } }).X; }
