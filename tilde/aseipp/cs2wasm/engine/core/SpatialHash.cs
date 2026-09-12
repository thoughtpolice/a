// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;
using System.Numerics;

/// <summary>
/// A uniform grid over a bounded area for broad-phase collision: each
/// frame it is cleared and every collider inserted into the cells its
/// circle overlaps; a query visits the cells around a circle and reports
/// each overlapping collider once. Cells are linked lists threaded
/// through flat arrays, so a frame allocates nothing once it has grown.
/// </summary>
public sealed class SpatialHash
{
    private readonly float cellSize;
    private readonly int columns;
    private readonly int rows;
    private readonly int[] heads;
    private int[] next = new int[64];
    private int[] items = new int[64];
    private int links;
    private Entity[] entities = new Entity[64];
    private Vector2[] centers = new Vector2[64];
    private float[] radii = new float[64];
    private int[] layers = new int[64];
    private int[] stamps = new int[64];
    private int stamp;

    public SpatialHash(float width, float height, float cellSize)
    {
        this.cellSize = cellSize;
        columns = Math.Max(1, (int)MathF.Ceiling(width / cellSize));
        rows = Math.Max(1, (int)MathF.Ceiling(height / cellSize));
        heads = new int[columns * rows];
        Clear();
    }

    /// <summary>The colliders inserted since the last clear.</summary>
    public int Count { get; private set; }

    public void Clear()
    {
        Array.Fill(heads, -1);
        links = 0;
        Count = 0;
    }

    /// <summary>Adds a circle; <paramref name="layer"/> is a mask a query can filter by.</summary>
    public void Insert(Entity entity, Vector2 center, float radius, int layer = 1)
    {
        int id = Count++;
        if (id == entities.Length)
        {
            int size = id * 2;
            Array.Resize(ref entities, size);
            Array.Resize(ref centers, size);
            Array.Resize(ref radii, size);
            Array.Resize(ref layers, size);
            Array.Resize(ref stamps, size);
        }

        entities[id] = entity;
        centers[id] = center;
        radii[id] = radius;
        layers[id] = layer;
        stamps[id] = 0;
        Cells(center, radius, out int left, out int top, out int right, out int bottom);
        for (int row = top; row <= bottom; row++)
        {
            for (int column = left; column <= right; column++)
            {
                if (links == next.Length)
                {
                    Array.Resize(ref next, links * 2);
                    Array.Resize(ref items, links * 2);
                }

                int cell = row * columns + column;
                items[links] = id;
                next[links] = heads[cell];
                heads[cell] = links++;
            }
        }
    }

    /// <summary>
    /// The colliders of a layer whose circles overlap the given one, each
    /// once, into <paramref name="results"/> (cleared first).
    /// </summary>
    public void Query(Vector2 center, float radius, List<Entity> results, int layers = -1)
    {
        results.Clear();
        stamp++;
        Cells(center, radius, out int left, out int top, out int right, out int bottom);
        for (int row = top; row <= bottom; row++)
        {
            for (int column = left; column <= right; column++)
            {
                for (int link = heads[row * columns + column]; link >= 0; link = next[link])
                {
                    int id = items[link];
                    if (stamps[id] == stamp || (this.layers[id] & layers) == 0)
                    {
                        continue;
                    }

                    stamps[id] = stamp;
                    float reach = radius + radii[id];
                    if (Vector2.DistanceSquared(center, centers[id]) <= reach * reach)
                    {
                        results.Add(entities[id]);
                    }
                }
            }
        }
    }

    private void Cells(Vector2 center, float radius, out int left, out int top, out int right, out int bottom)
    {
        left = Math.Clamp((int)MathF.Floor((center.X - radius) / cellSize), 0, columns - 1);
        right = Math.Clamp((int)MathF.Floor((center.X + radius) / cellSize), 0, columns - 1);
        top = Math.Clamp((int)MathF.Floor((center.Y - radius) / cellSize), 0, rows - 1);
        bottom = Math.Clamp((int)MathF.Floor((center.Y + radius) / cellSize), 0, rows - 1);
    }
}
