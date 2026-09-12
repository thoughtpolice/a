namespace Demo;

public sealed class Vector2
{
    public int X;
    public int Y;

    public Vector2(int x, int y)
    {
        X = x;
        Y = y;
    }

    public int LengthSquared() => X * X + Y * Y;
}

public sealed class Particle
{
    public Vector2 Position;
    public Vector2 PreviousPosition;
    public Vector2 Velocity;
    public Vector2 Acceleration;

    public Particle(Vector2 position, Vector2 velocity, Vector2 acceleration)
    {
        Position = position;
        PreviousPosition = position;
        Velocity = velocity;
        Acceleration = acceleration;
    }

    public void Advance()
    {
        Velocity.X = Velocity.X + Acceleration.X;
        Velocity.Y = Velocity.Y + Acceleration.Y;

        // Keep the previous object alive while allocating a fresh position.
        PreviousPosition = Position;
        Position = new Vector2(Position.X + Velocity.X, Position.Y + Velocity.Y);
    }
}

public sealed class SceneNode
{
    public int Weight;
    public bool Visited;
    public SceneNode[] Children;

    public SceneNode(int weight, int childCount)
    {
        Weight = weight;
        Children = new SceneNode[childCount];
    }
}

public sealed class SearchPosition
{
    public int X;
    public int Y;
    public int Distance;

    public SearchPosition(int x, int y, int distance)
    {
        X = x;
        Y = y;
        Distance = distance;
    }
}

public static class HeapGameplay
{
    // Returns a checksum of the current and previous particle positions.
    // Integer coordinates keep results identical across Wasm engines.
    public static int ParticleSimulation(int count, int steps)
    {
        if (count < 0 || steps < 0)
            return -1;

        var particles = new Particle[count];
        var gravity = new Vector2(0, 0);
        for (int i = 0; i < count; i++)
        {
            particles[i] = new Particle(
                position: new Vector2(i, -i),
                velocity: new Vector2(i + 1, 2),
                acceleration: gravity);
        }

        // Every particle holds the same acceleration object: this one mutation
        // changes all particles, including those already constructed.
        gravity.Y = -1;
        for (int step = 0; step < steps; step++)
        {
            for (int i = 0; i < particles.Length; i++)
                particles[i].Advance();
        }

        int checksum = 0;
        for (int i = 0; i < particles.Length; i++)
        {
            Particle particle = particles[i];
            checksum = checksum + 10 * particle.Position.LengthSquared()
                + particle.PreviousPosition.LengthSquared();
        }

        return checksum;
    }

    public static int SharedGraphWeight(int bonus)
    {
        var root = new SceneNode(weight: 1, childCount: 2);
        var left = new SceneNode(weight: 2, childCount: 1);
        var right = new SceneNode(weight: 3, childCount: 1);
        var shared = new SceneNode(weight: 4, childCount: 1);

        root.Children[0] = left;
        root.Children[1] = right;
        left.Children[0] = shared;
        right.Children[0] = shared;
        shared.Children[0] = root; // A cycle, so traversal needs a visited flag.

        // Mutating through the left branch also changes the right branch.
        left.Children[0].Weight = left.Children[0].Weight + bonus;
        return SumDistinct(root);
    }

    private static int SumDistinct(SceneNode node)
    {
        if (node.Visited)
            return 0;

        node.Visited = true;
        int total = node.Weight;
        for (int i = 0; i < node.Children.Length; i++)
            total = total + SumDistinct(node.Children[i]);

        return total;
    }

    // Finds the shortest four-direction path from (0, 0). A cell contains
    // 0 when open, 1 when blocked, and 2 after being queued. Returns -1 for
    // invalid or unreachable destinations. The far corner (6, 4) takes 14 steps.
    public static int MazeDistance(int targetX, int targetY)
    {
        var maze = new int[5][];
        maze[0] = new int[] { 0, 0, 0, 1, 0, 0, 0 };
        maze[1] = new int[] { 1, 1, 0, 1, 0, 1, 0 };
        maze[2] = new int[] { 0, 0, 0, 0, 0, 1, 0 };
        maze[3] = new int[] { 0, 1, 1, 1, 1, 1, 0 };
        maze[4] = new int[] { 0, 0, 0, 0, 0, 0, 0 };

        if (targetX < 0 || targetX >= maze[0].Length
            || targetY < 0 || targetY >= maze.Length)
            return -1;

        if (maze[targetY][targetX] != 0)
            return -1;

        // Each cell is queued at most once; entries are heap objects, and the
        // fixed-capacity reference array is large enough for the whole grid.
        var queue = new SearchPosition[maze.Length * maze[0].Length];
        var deltaX = new int[] { 1, 0, -1, 0 };
        var deltaY = new int[] { 0, 1, 0, -1 };
        queue[0] = new SearchPosition(0, 0, 0);
        maze[0][0] = 2;
        int head = 0;
        int tail = 1;

        while (head < tail)
        {
            SearchPosition current = queue[head];
            head++;
            if (current.X == targetX && current.Y == targetY)
                return current.Distance;

            for (int direction = 0; direction < deltaX.Length; direction++)
            {
                int x = current.X + deltaX[direction];
                int y = current.Y + deltaY[direction];
                if (x < 0 || x >= maze[0].Length || y < 0 || y >= maze.Length)
                    continue;
                if (maze[y][x] != 0)
                    continue;

                maze[y][x] = 2;
                queue[tail] = new SearchPosition(x, y, current.Distance + 1);
                tail++;
            }
        }

        return -1;
    }

    // The allocation limit counts cumulative logical units, even when an old
    // array becomes collectible. Each array costs 16 + 8 * 1024 = 8208 units:
    // 127 iterations fit the default budget; the 128th exhausts it (fault 3).
    public static int AllocationPressure(int count)
    {
        int checksum = 0;
        for (int i = 0; i < count; i++)
        {
            var samples = new int[1024];
            samples[0] = i;
            samples[samples.Length - 1] = i + 1;
            checksum = checksum + samples[0] + samples[samples.Length - 1];
        }

        return checksum;
    }
}
