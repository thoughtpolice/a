// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.MultiArrays;

public struct Cell
{
    public int Value;
    public bool Seen;

    public void Mark(int by)
    {
        Value += by;
        Seen = true;
    }
}

public sealed class Tile
{
    public int Id;

    public Tile(int id)
    {
        Id = id;
    }
}

public static class MultiArrays
{
    private static int log;

    private static int Log(int value)
    {
        log = log * 10 + (value & 7) + 1;
        return value;
    }

    public static int Grid(int x)
    {
        int rows = (x & 3) + 1;
        int columns = ((x >> 2) & 3) + 2;
        var grid = new int[rows, columns];
        for (int r = 0; r < rows; r++)
        {
            for (int c = 0; c < columns; c++)
            {
                grid[r, c] = r * 10 + c + x;
            }
        }

        grid[rows - 1, columns - 1] += 100;
        grid[0, 0]++;
        int sum = 0;
        foreach (int value in grid)
        {
            sum = sum * 3 + value;
        }

        return sum + grid.Length * 1000 + grid.Rank * 7 + grid.GetLength(0) * 11 + grid.GetLength(1) * 13
            + grid.GetUpperBound(1) * 17 + grid.GetLowerBound(0);
    }

    public static int Initialized(int x)
    {
        int[,] square = { { 1, 2, 3 }, { 4, 5, x } };
        var cube = new long[,,] { { { 1, 2 }, { 3, 4 } }, { { 5, 6 }, { 7, x } } };
        string[,] words = new string[2, 2] { { "a", "b" }, { "c" + x, null } };
        int digest = 0;
        foreach (long value in cube)
        {
            digest = digest * 5 + (int)value;
        }

        foreach (string word in words)
        {
            digest = digest * 7 + (word?.Length ?? -1);
        }

        return digest + square[1, 2] * 100 + (int)cube[1, 1, 1] + square.Length + cube.GetLength(2);
    }

    public static int Elements(int x)
    {
        var cells = new Cell[2, 3];
        cells[1, 2].Mark(x);
        cells[0, (x & 1) + 1].Value = 9;
        ref Cell cell = ref cells[1, 0];
        cell.Mark(3);
        var tiles = new Tile[2, 2];
        tiles[1, 1] = new Tile(x);
        int digest = 0;
        foreach (Cell c in cells)
        {
            digest = digest * 3 + c.Value + (c.Seen ? 50 : 0);
        }

        foreach (Tile t in tiles)
        {
            digest = digest * 3 + (t?.Id ?? -2);
        }

        var jagged = new int[2][,];
        jagged[1] = new int[1, 2];
        jagged[1][0, 1] = x;
        var ofArrays = new int[][,] { new int[,] { { 1 } }, jagged[1] };
        return digest + jagged[1][0, 1] + ofArrays[0][0, 0] + ofArrays.Length;
    }

    public static int Faults(int which)
    {
        var grid = new int[2, 3];
        int[,] none = null;
        switch (which)
        {
            case 0:
                return grid[2, 0];
            case 1:
                return grid[0, 3];
            case 2:
                return grid[-1, 0];
            case 3:
                return none[0, 0];
            case 4:
                return new int[which - 5, 2].Length;
            case 5:
                return grid.GetLength(2);
            case 6:
                grid[1, 5] = 3;
                return 0;
            case 7:
                return none.Length;
            default:
                return grid[1, 2];
        }
    }

    // A simple assignment evaluates its value before checking the index,
    // as the CLR's Set does.
    public static int Order(int x)
    {
        log = 0;
        var grid = new int[2, 2];
        try
        {
            grid[Log(x), Log(1)] = Log(x > 1 ? throw new InvalidOperationException() : 5);
        }
        catch (IndexOutOfRangeException)
        {
            log = log * 10 + 9;
        }
        catch (InvalidOperationException)
        {
            log = log * 10 + 8;
        }

        return log;
    }

    public static int Generic(int x)
    {
        var grid = Make(x, 3);
        return Sum(grid) + Make("s" + x, 2).GetLength(1) + (Make(new List<int>(), 1)[0, 0].Count);
    }

    public static int Objects(int x)
    {
        object[] values = [new int[2, 2], new int[1, 1, 1], new long[1, 2], new int[3], x, null];
        int digest = 0;
        foreach (object value in values)
        {
            digest = digest * 2 + (value is int[,] ? 1 : 0);
            digest = digest * 2 + (value is int[,,] ? 1 : 0);
            digest = digest * 2 + (value is long[,] ? 1 : 0);
        }

        var list = new List<int[,]> { new int[1, 1], (int[,])values[0] };
        list[1][1, 1] = x;
        return digest * 10 + ((int[,])values[0])[1, 1] + list.Count;
    }

    private static T[,] Make<T>(T value, int size)
    {
        var grid = new T[size, size];
        for (int i = 0; i < size; i++)
        {
            grid[i, size - 1 - i] = value;
        }

        return grid;
    }

    private static int Sum(int[,] grid)
    {
        int sum = 0;
        for (int i = 0; i < grid.GetLength(0); i++)
        {
            for (int j = 0; j < grid.GetLength(1); j++)
            {
                sum = sum * 2 + grid[i, j];
            }
        }

        return sum;
    }
}
