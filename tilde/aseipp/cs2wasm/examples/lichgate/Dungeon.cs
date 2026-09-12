// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Floors made from a seed: rooms grown outward from the start on a 7x7
// grid, joined by doors, with the boss's lair at the dead end farthest
// from the start, a treasure room and a shrine at other dead ends, and
// every room's rocks laid out from a template, mirrored at random.
namespace Lichgate;

using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Kiln;

internal enum RoomType
{
    Start,
    Fight,
    Treasure,
    Shrine,
    Boss,
}

internal enum Side
{
    North,
    East,
    South,
    West,
}

internal enum Cell : byte
{
    Floor,
    Wall,
    Rock,
    Door,
}

internal sealed class Room
{
    public Room(int x, int y)
    {
        X = x;
        Y = y;
    }

    public int X { get; }

    public int Y { get; }

    public RoomType Type { get; set; } = RoomType.Fight;

    public int Distance { get; set; }

    public bool Visited { get; set; }

    public bool Cleared { get; set; }

    public ulong Seed { get; set; }

    public bool[] Doors { get; } = new bool[4];

    public Cell[] Cells { get; } = new Cell[Dungeon.Width * Dungeon.Height];

    /// <summary>The room's floor, walls and rocks, drawn once.</summary>
    public Canvas Background { get; set; }

    public Cell At(int x, int y) =>
        x < 0 || y < 0 || x >= Dungeon.Width || y >= Dungeon.Height ? Cell.Wall : Cells[y * Dungeon.Width + x];

    public bool Blocked(int x, int y, bool locked) => At(x, y) switch
    {
        Cell.Floor => false,
        Cell.Door => locked,
        _ => true,
    };

    /// <summary>Where a door's opening is, in room pixels.</summary>
    public static Vector2 DoorPoint(Side side) => side switch
    {
        Side.North => new Vector2(Dungeon.Width * 8, 8),
        Side.South => new Vector2(Dungeon.Width * 8, Dungeon.Height * 16 - 8),
        Side.West => new Vector2(8, Dungeon.Height * 8),
        _ => new Vector2(Dungeon.Width * 16 - 8, Dungeon.Height * 8),
    };

    /// <summary>Where the hero stands after coming in through a door.</summary>
    public static Vector2 EntryPoint(Side side) => side switch
    {
        Side.North => new Vector2(Dungeon.Width * 8, 30),
        Side.South => new Vector2(Dungeon.Width * 8, Dungeon.Height * 16 - 30),
        Side.West => new Vector2(30, Dungeon.Height * 8),
        _ => new Vector2(Dungeon.Width * 16 - 30, Dungeon.Height * 8),
    };

    public static Side Opposite(Side side) => (Side)(((int)side + 2) % 4);
}

internal sealed class Dungeon
{
    public const int Width = 20;
    public const int Height = 11;
    public const int Grid = 7;

    private static readonly (int X, int Y)[] Steps = { (0, -1), (1, 0), (0, 1), (-1, 0) };

    // Rock layouts over the 18x9 interior; '#' is a rock. Lanes to the
    // doors (the middle row and the two middle columns) stay open.
    private static readonly string[][] Layouts =
    {
        new[]
        {
            "..................",
            "..................",
            "..................",
            "..................",
            "..................",
            "..................",
            "..................",
            "..................",
            "..................",
        },
        new[]
        {
            "..................",
            "..##..........##..",
            "..##..........##..",
            "..................",
            "..................",
            "..................",
            "..##..........##..",
            "..##..........##..",
            "..................",
        },
        new[]
        {
            "..................",
            "..................",
            ".....###..###.....",
            ".....#......#.....",
            "..................",
            ".....#......#.....",
            ".....###..###.....",
            "..................",
            "..................",
        },
        new[]
        {
            "..................",
            ".#.......#........",
            "....#..........#..",
            "..........#.......",
            "..#...............",
            ".......#......#...",
            "...............#..",
            "...#......#.......",
            "..................",
        },
        new[]
        {
            "..................",
            "..................",
            "...######..######.",
            "..................",
            "..................",
            "..................",
            ".######..######...",
            "..................",
            "..................",
        },
        new[]
        {
            "##..............##",
            "#................#",
            "..................",
            "......#....#......",
            "..................",
            "......#....#......",
            "..................",
            "#................#",
            "##..............##",
        },
    };

    private readonly Room[] grid = new Room[Grid * Grid];

    private Dungeon(int floor)
    {
        Floor = floor;
    }

    public int Floor { get; }

    public List<Room> Rooms { get; } = new List<Room>();

    public Room Start { get; private set; }

    public Room Lair { get; private set; }

    public Room At(int x, int y) => x < 0 || y < 0 || x >= Grid || y >= Grid ? null : grid[y * Grid + x];

    public Room Neighbor(Room room, Side side) => room.Doors[(int)side]
        ? At(room.X + Steps[(int)side].X, room.Y + Steps[(int)side].Y)
        : null;

    public static Dungeon Generate(ulong seed, int floor)
    {
        var rng = new Rng(seed * 7919 + (ulong)floor);
        for (int attempt = 0; ; attempt++)
        {
            var dungeon = new Dungeon(floor);
            if (dungeon.Grow(rng, Math.Min(7 + floor * 2, 15)) || attempt > 20)
            {
                dungeon.Decorate(rng);
                return dungeon;
            }
        }
    }

    // Grows rooms from the middle: a room is added beside an existing one
    // whose empty cell has no other neighbour, so the floor branches rather
    // than clumps. Fails when the boss would have no dead end of its own.
    private bool Grow(Rng rng, int count)
    {
        Start = Add(Grid / 2, Grid / 2);
        Start.Type = RoomType.Start;
        for (int tries = 0; Rooms.Count < count && tries < 500; tries++)
        {
            var from = Rooms[rng.Range(Math.Max(0, Rooms.Count - 4), Rooms.Count)];
            if (rng.Chance(0.35f))
            {
                from = rng.Pick(Rooms);
            }

            var side = (Side)rng.Range(0, 4);
            int x = from.X + Steps[(int)side].X;
            int y = from.Y + Steps[(int)side].Y;
            if (x < 0 || y < 0 || x >= Grid || y >= Grid || At(x, y) is not null || Neighbours(x, y) > 1)
            {
                continue;
            }

            var room = Add(x, y);
            from.Doors[(int)side] = true;
            room.Doors[(int)Room.Opposite(side)] = true;
        }

        // Distances from the start, by breadth-first search over the doors.
        var queue = new Queue<Room>();
        queue.Enqueue(Start);
        Start.Distance = 0;
        var seen = new HashSet<Room> { Start };
        while (queue.Count > 0)
        {
            var room = queue.Dequeue();
            for (int side = 0; side < 4; side++)
            {
                if (Neighbor(room, (Side)side) is { } next && seen.Add(next))
                {
                    next.Distance = room.Distance + 1;
                    queue.Enqueue(next);
                }
            }
        }

        var ends = Rooms.Where(room => room != Start && room.Doors.Count(open => open) == 1)
            .OrderByDescending(room => room.Distance)
            .ThenBy(room => room.Y * Grid + room.X)
            .ToList();
        if (ends.Count < 2)
        {
            return false;
        }

        Lair = ends[0];
        Lair.Type = RoomType.Boss;
        ends[1].Type = RoomType.Treasure;
        if (ends.Count > 2)
        {
            ends[^1].Type = RoomType.Shrine;
        }

        return true;
    }

    private Room Add(int x, int y)
    {
        var room = new Room(x, y);
        grid[y * Grid + x] = room;
        Rooms.Add(room);
        return room;
    }

    private int Neighbours(int x, int y)
    {
        int count = 0;
        foreach (var (dx, dy) in Steps)
        {
            if (At(x + dx, y + dy) is not null)
            {
                count++;
            }
        }

        return count;
    }

    private void Decorate(Rng rng)
    {
        foreach (var room in Rooms)
        {
            room.Seed = ((ulong)rng.Next() << 32) | rng.Next();
            var layout = room.Type == RoomType.Fight ? Layouts[rng.Range(0, Layouts.Length)] : Layouts[0];
            bool mirrorX = rng.Chance(0.5f);
            bool mirrorY = rng.Chance(0.5f);
            for (int y = 0; y < Height; y++)
            {
                for (int x = 0; x < Width; x++)
                {
                    Cell cell;
                    if (x == 0 || y == 0 || x == Width - 1 || y == Height - 1)
                    {
                        cell = Cell.Wall;
                    }
                    else
                    {
                        int lx = mirrorX ? Width - 2 - x : x - 1;
                        int ly = mirrorY ? Height - 2 - y : y - 1;
                        cell = layout[ly][lx] == '#' ? Cell.Rock : Cell.Floor;
                    }

                    room.Cells[y * Width + x] = cell;
                }
            }

            // The lanes to the doors stay open, and the doors are doors.
            for (int x = 1; x < Width - 1; x++)
            {
                if (room.Doors[(int)Side.West] || room.Doors[(int)Side.East])
                {
                    room.Cells[Height / 2 * Width + x] = x is > 3 and < Width - 4 ? room.Cells[Height / 2 * Width + x] : Cell.Floor;
                }
            }

            for (int y = 1; y < Height - 1; y++)
            {
                if (room.Doors[(int)Side.North] || room.Doors[(int)Side.South])
                {
                    for (int x = Width / 2 - 1; x <= Width / 2; x++)
                    {
                        if (y is < 3 or > Height - 4)
                        {
                            room.Cells[y * Width + x] = Cell.Floor;
                        }
                    }
                }
            }

            if (room.Doors[(int)Side.North])
            {
                room.Cells[Width / 2 - 1] = Cell.Door;
                room.Cells[Width / 2] = Cell.Door;
            }

            if (room.Doors[(int)Side.South])
            {
                room.Cells[(Height - 1) * Width + Width / 2 - 1] = Cell.Door;
                room.Cells[(Height - 1) * Width + Width / 2] = Cell.Door;
            }

            if (room.Doors[(int)Side.West])
            {
                room.Cells[Height / 2 * Width] = Cell.Door;
            }

            if (room.Doors[(int)Side.East])
            {
                room.Cells[Height / 2 * Width + Width - 1] = Cell.Door;
            }
        }
    }

    /// <summary>The room's floor, walls and rocks, from its seed.</summary>
    public static Canvas Draw(Room room, int floor)
    {
        var rng = new Rng(room.Seed);
        var canvas = new Canvas(Width * Tiles.Size, Height * Tiles.Size);
        // Each floor its own stone.
        (byte ground, byte speck, byte grout, byte face, byte light, byte mortar) = (floor % 3) switch
        {
            1 => (Colors.Slate, Colors.Moss, Colors.Night, Colors.Umber, Colors.Brown, Colors.Night),
            2 => (Colors.Indigo, Colors.Plum, Colors.Night, Colors.Navy, Colors.Blue, Colors.Night),
            _ => (Colors.Ash, Colors.Stone, Colors.Night, Colors.Plum, Colors.Purple, Colors.Night),
        };
        if (room.Type == RoomType.Boss)
        {
            (ground, speck, face, light) = (Colors.Plum, Colors.Umber, Colors.Night, Colors.Plum);
        }

        var floors = Enumerable.Range(0, 6).Select(_ => Tiles.Floor(rng, ground, speck, grout)).ToArray();
        var walls = Enumerable.Range(0, 3).Select(_ => Tiles.Wall(rng, face, light, mortar)).ToArray();
        var rock = Tiles.Rock(rng);
        for (int y = 0; y < Height; y++)
        {
            for (int x = 0; x < Width; x++)
            {
                int px = x * Tiles.Size;
                int py = y * Tiles.Size;
                switch (room.At(x, y))
                {
                    case Cell.Wall:
                        canvas.Draw(walls[rng.Range(0, walls.Length)], px, py);
                        break;
                    case Cell.Door:
                        canvas.Fill(px, py, Tiles.Size, Tiles.Size, Colors.Night);
                        break;
                    default:
                        canvas.Draw(floors[rng.Range(0, floors.Length)], px, py);
                        if (room.At(x, y) == Cell.Rock)
                        {
                            canvas.Remap(px + 2, py + 12, 14, 4, Colors.Shade);
                            canvas.Draw(rock, px, py);
                        }

                        break;
                }
            }
        }

        // The walls' shadow on the floor below them.
        for (int x = 1; x < Width - 1; x++)
        {
            canvas.Remap(x * Tiles.Size, Tiles.Size, Tiles.Size, 3, Colors.Shade);
        }

        return canvas;
    }
}
