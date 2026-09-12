// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Drawing, as the world's render systems: the room, shadows, everything
// with a look sorted by depth, particles and popups, and the heads-up
// band above the room.
namespace Lichgate;

using System;
using System.Collections.Generic;
using System.Numerics;
using Kiln;

/// <summary>Where the render systems draw: the screen's canvas, and the frame count.</summary>
[Resource]
internal sealed class View
{
    public const int Band = 16;

    public Canvas Canvas;
    public long Frame;

    /// <summary>The pointer in room pixels, when the mouse aims.</summary>
    public Vector2? Pointer;

    internal readonly List<(float Depth, Entity Entity)> Order = new List<(float, Entity)>();
}

internal static partial class Paint
{
    [System(Phase.Render)]
    static void Backdrop(View view, Arena arena, Effects effects)
    {
        var canvas = view.Canvas;
        canvas.CameraX = (int)effects.Shake.X;
        canvas.CameraY = -View.Band + (int)effects.Shake.Y;
        canvas.SetClip(0, View.Band, canvas.Width, canvas.Height - View.Band);
        if (arena.Room?.Background is { } background)
        {
            canvas.Blit(background, 0, 0);
        }

        if (arena.Room is { } room)
        {
            for (int side = 0; side < 4; side++)
            {
                if (room.Doors[side])
                {
                    DrawDoor(canvas, (Side)side, arena.Locked, view.Frame);
                }
            }
        }
    }

    private static void DrawDoor(Canvas canvas, Side side, bool locked, long frame)
    {
        var point = Room.DoorPoint(side);
        bool wide = side is Side.North or Side.South;
        int x = (int)point.X - (wide ? 16 : 8);
        int y = (int)point.Y - 8;
        int width = wide ? 32 : 16;
        canvas.Rect(x - 1, y - 1, width + 2, 18, Colors.Gold);
        if (!locked)
        {
            canvas.Fill(x, y, width, 16, Colors.Black);
            return;
        }

        canvas.Fill(x, y, width, 16, Colors.Night);
        for (int bar = 2; bar < width; bar += 5)
        {
            canvas.Fill(x + bar, y, 2, 16, frame / 8 % 2 == 0 ? Colors.Silver : Colors.Gray);
        }
    }

    [System(Phase.Render, Order = 1)]
    [Without<Bullet>]
    static void Shadows(in Position position, in Body body, View view)
    {
        int width = (int)body.Radius * 2 + 2;
        view.Canvas.Remap((int)position.Value.X - width / 2, (int)(position.Value.Y + body.Radius) - 1, width, 3, Colors.Shade);
    }

    // What has a look, gathered and sorted by depth, then drawn.
    [System(Phase.Render, Order = 2)]
    static void Gather(Entity self, in Position position, in Look look, View view)
    {
        view.Order.Add((position.Value.Y + look.Lift, self));
    }

    [System(Phase.Render, Order = 3)]
    static void Actors(View view, World world, Crawl run)
    {
        var order = view.Order;
        order.Sort((left, right) => left.Depth.CompareTo(right.Depth));
        var canvas = view.Canvas;
        foreach (var (_, entity) in order)
        {
            var look = world.Get<Look>(entity);
            if (look.Frames is not { Length: > 0 } frames)
            {
                continue;
            }

            var sprite = frames[look.Frame % frames.Length];
            var at = world.Get<Position>(entity).Value;
            int solid = -1;
            var remap = look.Remap;
            if (world.TryGet<Health>(entity, out var health))
            {
                if (health.Flash > 0)
                {
                    solid = Colors.White;
                }
                else if (health.Invulnerable > 0 && world.Has<Hero>(entity) && view.Frame / 3 % 2 == 0)
                {
                    continue;
                }
            }

            if (world.Has<Spawning>(entity))
            {
                if (view.Frame / 2 % 2 == 0)
                {
                    continue;
                }

                remap = Colors.Pale;
            }

            float bob = 0;
            if (world.TryGet<Pickup>(entity, out var pickup))
            {
                bob = MathF.Sin(pickup.Age * 0.12f) * 2;
            }
            else if (world.Has<Offer>(entity) || world.Has<Gate>(entity))
            {
                bob = MathF.Sin(view.Frame * 0.08f) * 2;
            }

            if (world.Has<Offer>(entity))
            {
                canvas.Draw(Art.Altar, (int)at.X - 8, (int)at.Y + 2);
            }

            bool flip = world.Has<Hero>(entity) ? run.Facing.X < 0 : look.FlipX;
            canvas.Draw(sprite, (int)at.X - sprite.Width / 2, (int)(at.Y - sprite.Height / 2 - look.Lift + bob), flip, solid, remap);
        }

        order.Clear();
    }

    [System(Phase.Render, Order = 4)]
    static void Sparks(View view, Effects effects)
    {
        var canvas = view.Canvas;
        effects.Particles.Draw(canvas);
        foreach (var popup in effects.Popups)
        {
            if (popup.Life > 8 || popup.Life % 2 == 0)
            {
                canvas.Text(popup.Text, (int)popup.At.X - Font.Measure(popup.Text) / 2 + 1, (int)popup.At.Y + 1, Colors.Black);
                canvas.Text(popup.Text, (int)popup.At.X - Font.Measure(popup.Text) / 2, (int)popup.At.Y, popup.Color);
            }
        }

        if (view.Pointer is { } pointer)
        {
            canvas.Draw(Art.Crosshair, (int)pointer.X - 2, (int)pointer.Y - 2);
        }
    }

    // The Lich's curse: in its last phase the room goes red, and a hero
    // on its last heart sees the edges of the room pulse.
    [System(Phase.Render, Order = 4)]
    [After(nameof(Sparks))]
    static void Omens(View view, Crawl run, World world)
    {
        var canvas = view.Canvas;
        foreach (var boss in world.Query<Boss>())
        {
            if (Lich.Phase(world.Get<Health>(boss)) == 3)
            {
                canvas.Remap(-8, -8, Dungeon.Width * Tiles.Size + 16, Dungeon.Height * Tiles.Size + 16, Colors.Cursed);
            }
        }

        if (world.IsAlive(run.Hero) && world.Get<Health>(run.Hero).Current <= 2 && view.Frame / 12 % 2 == 0)
        {
            canvas.Rect(0, 0, Dungeon.Width * Tiles.Size, Dungeon.Height * Tiles.Size, Colors.Red);
            canvas.Rect(1, 1, Dungeon.Width * Tiles.Size - 2, Dungeon.Height * Tiles.Size - 2, Colors.Plum);
        }
    }

    // The band above the room: hearts, the floor's map, score and combo,
    // and the Lich's health when it is here.
    [System(Phase.Render, Order = 5)]
    static void Band(View view, Crawl run, World world, Arena arena)
    {
        var canvas = view.Canvas;
        canvas.CameraX = 0;
        canvas.CameraY = 0;
        canvas.ResetClip();
        canvas.Fill(0, 0, canvas.Width, View.Band, Colors.Night);
        canvas.Fill(0, View.Band - 1, canvas.Width, 1, Colors.Plum);
        if (world.IsAlive(run.Hero))
        {
            var health = world.Get<Health>(run.Hero);
            for (int heart = 0; heart < (health.Max + 1) / 2; heart++)
            {
                int left = health.Current - heart * 2;
                var sprite = left >= 2 ? Art.Heart : left == 1 ? Art.HeartHalf : Art.HeartEmpty;
                canvas.Draw(sprite, 4 + heart * 8, 5);
            }
        }

        string score = run.Score.ToString();
        canvas.Text("SCORE", 118, 3, Colors.Gray);
        canvas.Text(score, 118, 9, Colors.Frost);
        canvas.Text("FLOOR " + run.Floor, 160, 3, Colors.Gray);
        if (run.Combo >= 4)
        {
            canvas.Text("COMBO X" + Math.Min(8, 1 + run.Combo / 4), 160, 9, view.Frame / 4 % 2 == 0 ? Colors.Yellow : Colors.Orange);
        }

        DrawMap(canvas, run, arena, view.Frame);
        foreach (var boss in world.Query<Boss>())
        {
            var health = world.Get<Health>(boss);
            int width = 120;
            int filled = Math.Max(0, health.Current) * width / health.Max;
            canvas.Fill(100, canvas.Height - 8, width + 2, 5, Colors.Black);
            canvas.Fill(101, canvas.Height - 7, filled, 3, Lich.Phase(health) == 3 ? Colors.Rose : Colors.Purple);
        }
    }

    // The explored rooms, the current one blinking, the lair marked once seen.
    private static void DrawMap(Canvas canvas, Crawl run, Arena arena, long frame)
    {
        if (run.Dungeon is not { } dungeon)
        {
            return;
        }

        const int Cell = 4;
        int left = canvas.Width - Dungeon.Grid * Cell - 6;
        canvas.Fill(left - 1, 0, Dungeon.Grid * Cell + 2, Dungeon.Grid * 2 + 2, Colors.Black);
        foreach (var room in dungeon.Rooms)
        {
            bool known = room.Visited || NextToVisited(dungeon, room);
            if (!known)
            {
                continue;
            }

            byte color = room == arena.Room
                ? (frame / 10 % 2 == 0 ? Colors.White : Colors.Frost)
                : room.Type == RoomType.Boss ? Colors.Red
                : room.Type == RoomType.Treasure ? Colors.Gold
                : room.Type == RoomType.Shrine ? Colors.Cyan
                : room.Visited ? Colors.Gray : Colors.Stone;
            canvas.Fill(left + room.X * Cell, 1 + room.Y * 2, Cell - 1, 1, color);
        }
    }

    private static bool NextToVisited(Dungeon dungeon, Room room)
    {
        for (int side = 0; side < 4; side++)
        {
            if (dungeon.Neighbor(room, (Side)side) is { Visited: true })
            {
                return true;
            }
        }

        return false;
    }
}
