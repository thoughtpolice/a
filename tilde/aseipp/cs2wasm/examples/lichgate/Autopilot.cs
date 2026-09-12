// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The attract mode's player (and the headless tests'): it reads the world
// as any system would and writes the same Intent a player's keys do. It
// fights at a distance, dodges shots coming at it, dashes through the
// close ones, picks up what helps, takes a relic, and walks the floor
// room by room (a breadth-first search over the doors, then over the
// room's tiles) until the Lich, then the stairs.
namespace Lichgate;

using System;
using System.Collections.Generic;
using System.Numerics;
using Kiln;

internal sealed class Autopilot
{
    private readonly List<(int X, int Y)> path = new List<(int, int)>();
    private int replan;
    private Vector2 last;
    private int stuck;
    private int strafe = 1;
    private int strafeTimer;

    public void Think(World world, Intent intent)
    {
        intent.Move = Vector2.Zero;
        intent.Aim = Vector2.Zero;
        intent.Fire = false;
        intent.Dash = false;
        var run = world.Crawl;
        var arena = world.Arena;
        if (!world.IsAlive(run.Hero) || arena.Room is null)
        {
            return;
        }

        var me = world.Get<Position>(run.Hero).Value;
        var avoid = Vector2.Zero;
        bool danger = false;
        foreach (var shot in world.Query<Bullet, Position>())
        {
            var bullet = world.Get<Bullet>(shot);
            if (bullet.Friendly)
            {
                continue;
            }

            var at = world.Get<Position>(shot).Value;
            var velocity = world.Get<Velocity>(shot).Value;
            var offset = me - at;
            float distance = offset.Length();
            if (distance > 56 || Vector2.Dot(velocity, offset) <= 0)
            {
                continue;
            }

            // Sideways out of the shot's line, harder the closer it is.
            var side = new Vector2(-velocity.Y, velocity.X);
            if (Vector2.Dot(side, offset) < 0)
            {
                side = -side;
            }

            avoid += Vector2.Normalize(side) * (56 - distance) / 56 * 2.2f;
            danger |= distance < 13;
        }

        var target = Entity.None;
        float nearest = float.MaxValue;
        foreach (var enemy in world.Query<Enemy, Position>().Without<Spawning>())
        {
            var at = world.Get<Position>(enemy).Value;
            float distance = Vector2.Distance(at, me);
            if (distance < 30)
            {
                avoid += Vector2.Normalize(me - at + new Vector2(0.01f, 0)) * (30 - distance) / 30 * 2.5f;
            }

            if (distance < nearest)
            {
                nearest = distance;
                target = enemy;
            }
        }

        Vector2 goal;
        if (!target.IsNone)
        {
            var at = world.Get<Position>(target).Value;
            var aim = at - me;
            // Lead a moving target by the shot's flight.
            if (world.TryGet<Velocity>(target, out var moving))
            {
                aim += moving.Value * (aim.Length() / run.Stats.ShotSpeed) * 0.6f;
            }

            intent.Aim = aim;
            intent.Fire = true;
            if (--strafeTimer <= 0)
            {
                strafe = -strafe;
                strafeTimer = 100;
            }

            var toward = Vector2.Normalize(at - me);
            float keep = world.Has<Boss>(target) ? 90 : 64;
            goal = toward * (nearest > keep + 10 ? 1 : nearest < keep - 10 ? -1 : 0) + new Vector2(-toward.Y, toward.X) * strafe * 0.6f;
        }
        else
        {
            goal = Wander(world, me);
        }

        // Walls push back, so the dodging does not pin it in a corner.
        var wall = Vector2.Zero;
        for (int side = 0; side < 4; side++)
        {
            var probe = me + side switch { 0 => new Vector2(14, 0), 1 => new Vector2(-14, 0), 2 => new Vector2(0, 14), _ => new Vector2(0, -14) };
            if (arena.Blocked(probe))
            {
                wall -= (probe - me) / 14;
            }
        }

        if (!target.IsNone)
        {
            goal += wall * 0.8f;
        }

        var move = goal + avoid;
        intent.Move = move.LengthSquared() > 0.04f ? Vector2.Normalize(move) : Vector2.Zero;
        intent.Dash = danger;

        // Unstick: if it has not moved for a while, try another way.
        if (Vector2.DistanceSquared(me, last) < 0.01f && intent.Move != Vector2.Zero)
        {
            if (++stuck > 40)
            {
                intent.Move = new Vector2(-intent.Move.Y, intent.Move.X);
                replan = 0;
                if (stuck > 70)
                {
                    stuck = 0;
                }
            }
        }
        else
        {
            stuck = 0;
        }

        last = me;
    }

    // With nothing to fight: what is worth picking up, the relic, the
    // stairs, or the way to the next room worth visiting.
    private Vector2 Wander(World world, Vector2 me)
    {
        var run = world.Crawl;
        var arena = world.Arena;
        if (arena.Locked)
        {
            // Enemies are on their way: the middle of the room.
            var middle = new Vector2(Dungeon.Width * 8, Dungeon.Height * 8) - me;
            return middle.LengthSquared() > 400 ? Vector2.Normalize(middle) : Vector2.Zero;
        }

        var health = world.Get<Health>(run.Hero);
        var point = Vector2.Zero;
        bool found = false;
        foreach (var item in world.Query<Pickup, Position>())
        {
            var pickup = world.Get<Pickup>(item);
            if (pickup.Drop == Drop.Heart && health.Current >= health.Max)
            {
                continue;
            }

            point = world.Get<Position>(item).Value;
            found = true;
            break;
        }

        if (!found && world.Query<Offer>().First() is { IsNone: false } altar)
        {
            point = world.Get<Position>(altar).Value;
            found = true;
        }

        if (!found && world.Query<Gate>().First() is { IsNone: false } gate)
        {
            point = world.Get<Position>(gate).Value;
            found = true;
        }

        if (!found)
        {
            if (NextDoor(run.Dungeon, arena.Room) is not { } side)
            {
                return Vector2.Zero;
            }

            point = Room.DoorPoint(side);
            // Through the door, not onto it.
            point += side switch
            {
                Side.North => new Vector2(0, -8),
                Side.South => new Vector2(0, 8),
                Side.West => new Vector2(-8, 0),
                _ => new Vector2(8, 0),
            };
        }

        return Steer(arena.Room, me, point);
    }

    // The door towards the nearest unvisited room, or the lair once all are.
    private static Side? NextDoor(Dungeon dungeon, Room from)
    {
        var previous = new Dictionary<Room, (Room Room, Side Side)>();
        var queue = new Queue<Room>();
        queue.Enqueue(from);
        previous[from] = (null, Side.North);
        Room goal = null;
        while (queue.Count > 0 && goal is null)
        {
            var room = queue.Dequeue();
            for (int side = 0; side < 4; side++)
            {
                if (dungeon.Neighbor(room, (Side)side) is not { } next || previous.ContainsKey(next))
                {
                    continue;
                }

                previous[next] = (room, (Side)side);
                if (!next.Visited)
                {
                    goal = next;
                    break;
                }

                queue.Enqueue(next);
            }
        }

        goal ??= dungeon.Lair == from ? null : dungeon.Lair;
        if (goal is null || !previous.ContainsKey(goal))
        {
            return null;
        }

        // Back from the goal to the first step out of this room.
        var step = goal;
        while (previous[step].Room != from)
        {
            step = previous[step].Room;
        }

        return previous[step].Side;
    }

    // A breadth-first path over the room's tiles, followed a waypoint at a time.
    private Vector2 Steer(Room room, Vector2 me, Vector2 point)
    {
        int goalX = Math.Clamp((int)(point.X / Tiles.Size), 0, Dungeon.Width - 1);
        int goalY = Math.Clamp((int)(point.Y / Tiles.Size), 0, Dungeon.Height - 1);
        int startX = (int)(me.X / Tiles.Size);
        int startY = (int)(me.Y / Tiles.Size);
        if (--replan <= 0 || path.Count == 0)
        {
            replan = 20;
            Plan(room, startX, startY, goalX, goalY);
        }

        while (path.Count > 1 && path[0] == (startX, startY))
        {
            path.RemoveAt(0);
        }

        var next = path.Count > 0 && path[0] != (goalX, goalY)
            ? new Vector2(path[0].X * Tiles.Size + 8, path[0].Y * Tiles.Size + 8)
            : point;
        var offset = next - me;
        return offset.LengthSquared() > 1 ? Vector2.Normalize(offset) : Vector2.Zero;
    }

    private void Plan(Room room, int startX, int startY, int goalX, int goalY)
    {
        path.Clear();
        var previous = new int[Dungeon.Width * Dungeon.Height];
        Array.Fill(previous, -1);
        var queue = new Queue<int>();
        int start = startY * Dungeon.Width + startX;
        if ((uint)start >= (uint)previous.Length)
        {
            return;
        }

        previous[start] = start;
        queue.Enqueue(start);
        int goal = goalY * Dungeon.Width + goalX;
        while (queue.Count > 0)
        {
            int cell = queue.Dequeue();
            if (cell == goal)
            {
                break;
            }

            int x = cell % Dungeon.Width;
            int y = cell / Dungeon.Width;
            foreach (var (dx, dy) in new[] { (1, 0), (-1, 0), (0, 1), (0, -1) })
            {
                int nx = x + dx;
                int ny = y + dy;
                int next = ny * Dungeon.Width + nx;
                if (nx < 0 || ny < 0 || nx >= Dungeon.Width || ny >= Dungeon.Height || previous[next] >= 0
                    || (room.Blocked(nx, ny, false) && next != goal))
                {
                    continue;
                }

                previous[next] = cell;
                queue.Enqueue(next);
            }
        }

        if (previous[goal] < 0)
        {
            return;
        }

        for (int cell = goal; cell != start; cell = previous[cell])
        {
            path.Insert(0, (cell % Dungeon.Width, cell / Dungeon.Width));
        }
    }
}
