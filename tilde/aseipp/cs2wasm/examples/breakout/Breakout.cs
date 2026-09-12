// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Generic;
using Gameplay;

namespace Demo;

// These declarations describe the complete boundary between C# and the host.
// Each call reads the current frame snapshot or queues a command for its commit.
internal static class Host
{
    [WasmImport("breakout", "entity_count")]
    internal static extern int EntityCount();

    [WasmImport("breakout", "entity_at")]
    internal static extern int EntityAt(int index);

    [WasmImport("breakout", "kind")]
    internal static extern int Kind(int handle);

    [WasmImport("breakout", "is_alive")]
    internal static extern bool IsAlive(int handle);

    [WasmImport("breakout", "read_x")]
    internal static extern float ReadX(int handle);

    [WasmImport("breakout", "read_y")]
    internal static extern float ReadY(int handle);

    [WasmImport("breakout", "read_velocity_x")]
    internal static extern float ReadVelocityX(int handle);

    [WasmImport("breakout", "read_velocity_y")]
    internal static extern float ReadVelocityY(int handle);

    [WasmImport("breakout", "paddle_target")]
    internal static extern float PaddleTarget();

    [WasmImport("breakout", "score")]
    internal static extern int Score();

    [WasmImport("breakout", "status")]
    internal static extern int Status();

    [WasmImport("breakout", "set_position")]
    internal static extern void SetPosition(int handle, float x, float y);

    [WasmImport("breakout", "set_velocity")]
    internal static extern void SetVelocity(int handle, float x, float y);

    [WasmImport("breakout", "set_alive")]
    internal static extern void SetAlive(int handle, bool alive);

    [WasmImport("breakout", "set_score")]
    internal static extern void SetScore(int score);

    [WasmImport("breakout", "set_status")]
    internal static extern void SetStatus(int status);
}

// A point or velocity, a value: copies are independent, and the operators
// work component by component.
internal struct Vector2
{
    internal float X;
    internal float Y;

    internal Vector2(float x, float y)
    {
        X = x;
        Y = y;
    }

    public static Vector2 operator +(Vector2 left, Vector2 right) => new(left.X + right.X, left.Y + right.Y);

    public static Vector2 operator -(Vector2 left, Vector2 right) => new(left.X - right.X, left.Y - right.Y);

    public static Vector2 operator *(Vector2 vector, float scale) => new(vector.X * scale, vector.Y * scale);
}

// A temporary Wasm GC object. Persistent state belongs to the host; these
// objects and the list containing them become collectible after each Tick.
// Each host kind is a class; what a body does in a frame is dispatched on it.
internal abstract class Body
{
    internal int Handle;
    internal bool Alive;
    internal Vector2 Position;
    internal Vector2 Velocity;

    protected Body(int handle)
    {
        Handle = handle;
        Alive = Host.IsAlive(handle);
        Position = new Vector2(Host.ReadX(handle), Host.ReadY(handle));
        Velocity = new Vector2(Host.ReadVelocityX(handle), Host.ReadVelocityY(handle));
    }

    // Half the body's width and height.
    internal virtual Vector2 Extent => new Vector2(31, 10);

    internal static Body Read(int handle) => Host.Kind(handle) switch
    {
        0 => new Paddle(handle),
        1 => new Ball(handle),
        2 => new Brick(handle),
        _ => new Scenery(handle),
    };

    // A live body's part in the frame: the paddle, the ball, or a brick
    // still to break.
    internal virtual void Enlist(Frame frame)
    {
    }

    // Whether the ball, having moved from its previous center, hits this
    // body; a hit also bounces the ball and settles the body's side of it.
    internal virtual bool Collide(Ball ball, Vector2 previous) => false;
}

internal sealed class Paddle : Body
{
    internal Paddle(int handle) : base(handle)
    {
    }

    internal override Vector2 Extent => new Vector2(55, 9);

    internal override void Enlist(Frame frame) => frame.Paddle = this;

    internal void Move(float seconds)
    {
        float halfWidth = Extent.X;
        float target = Breakout.Clamp(Host.PaddleTarget(), halfWidth, 800 - halfWidth);
        float maximumMove = 600 * seconds;
        Position.X += Breakout.Clamp(target - Position.X, -maximumMove, maximumMove);
    }
}

internal sealed class Ball : Body
{
    internal Ball(int handle) : base(handle)
    {
    }

    internal override Vector2 Extent => new Vector2(8, 8);

    internal override void Enlist(Frame frame) => frame.Ball = this;

    internal void BounceOffWalls()
    {
        var extent = Extent;
        if (Position.X < extent.X)
        {
            Position.X = extent.X;
            if (Velocity.X < 0)
                Velocity.X = -Velocity.X;
        }
        else if (Position.X > 800 - extent.X)
        {
            Position.X = 800 - extent.X;
            if (Velocity.X > 0)
                Velocity.X = -Velocity.X;
        }

        if (Position.Y < extent.Y)
        {
            Position.Y = extent.Y;
            if (Velocity.Y < 0)
                Velocity.Y = -Velocity.Y;
        }
    }

    internal void BounceOffPaddle(Paddle paddle, float previousY)
    {
        var extent = Extent;
        var paddleExtent = paddle.Extent;
        float top = paddle.Position.Y - paddleExtent.Y;
        if (Velocity.Y <= 0 || previousY + extent.Y > top
            || Position.Y + extent.Y < top
            || Position.X < paddle.Position.X - paddleExtent.X - extent.X
            || Position.X > paddle.Position.X + paddleExtent.X + extent.X)
            return;

        // Hitting near an edge sends the ball sideways. Move it above the
        // paddle before reflecting, so the next step cannot hit it again.
        Position.Y = top - extent.Y;
        float offset = Breakout.Clamp((Position.X - paddle.Position.X) / paddleExtent.X, -1, 1);
        Velocity = new Vector2(offset * 280, -260);
    }

    internal void BounceOff(Vector2 previous, float left, float right, float top, float bottom)
    {
        // The previous center tells us which face the ball crossed.
        if (previous.Y <= top)
        {
            Position.Y = top;
            Velocity.Y = -Breakout.Absolute(Velocity.Y);
        }
        else if (previous.Y >= bottom)
        {
            Position.Y = bottom;
            Velocity.Y = Breakout.Absolute(Velocity.Y);
        }
        else if (previous.X <= left)
        {
            Position.X = left;
            Velocity.X = -Breakout.Absolute(Velocity.X);
        }
        else if (previous.X >= right)
        {
            Position.X = right;
            Velocity.X = Breakout.Absolute(Velocity.X);
        }
        else
        {
            // A custom initial world may place the ball inside a brick.
            // Resolve through its nearest face so it does not stay embedded.
            float horizontalOverlap = Breakout.Minimum(Position.X - left, right - Position.X);
            float verticalOverlap = Breakout.Minimum(Position.Y - top, bottom - Position.Y);
            if (horizontalOverlap < verticalOverlap)
            {
                if (Position.X - left < right - Position.X)
                {
                    Position.X = left;
                    Velocity.X = -Breakout.Absolute(Velocity.X);
                }
                else
                {
                    Position.X = right;
                    Velocity.X = Breakout.Absolute(Velocity.X);
                }
            }
            else if (Position.Y - top < bottom - Position.Y)
            {
                Position.Y = top;
                Velocity.Y = -Breakout.Absolute(Velocity.Y);
            }
            else
            {
                Position.Y = bottom;
                Velocity.Y = Breakout.Absolute(Velocity.Y);
            }
        }
    }
}

internal sealed class Brick : Body
{
    internal Brick(int handle) : base(handle)
    {
    }

    internal override void Enlist(Frame frame) => frame.RemainingBricks++;

    internal override bool Collide(Ball ball, Vector2 previous)
    {
        // Expand the rectangle by the ball radius, then test its center.
        // This uses a square approximation at the four brick corners.
        var extent = Extent;
        var ballExtent = ball.Extent;
        float left = Position.X - extent.X - ballExtent.X;
        float right = Position.X + extent.X + ballExtent.X;
        float top = Position.Y - extent.Y - ballExtent.Y;
        float bottom = Position.Y + extent.Y + ballExtent.Y;
        if (ball.Position.X < left || ball.Position.X > right || ball.Position.Y < top || ball.Position.Y > bottom)
            return false;

        ball.BounceOff(previous, left, right, top, bottom);
        Alive = false;
        Host.SetAlive(Handle, false);
        Host.SetScore(Host.Score() + 10);
        return true;
    }
}

// A body of a kind this script does not know; it takes part in nothing.
internal sealed class Scenery : Body
{
    internal Scenery(int handle) : base(handle)
    {
    }
}

internal sealed class Frame
{
    internal Paddle Paddle;
    internal Ball Ball;
    internal int RemainingBricks;
}

public static class Breakout
{
    // The host advances at 120 steps per second. Small, bounded steps keep
    // this deliberately simple collision model from skipping thin bricks.
    // Status values: 0 = playing, 1 = won, 2 = lost.
    public static int Tick(float seconds)
    {
        int status = Host.Status();
        if (status != 0)
            return status;

        int count = Host.EntityCount();
        var bodies = new List<Body>(count);
        for (int index = 0; index < count; index++)
            bodies.Add(Body.Read(Host.EntityAt(index)));

        var frame = new Frame();
        foreach (Body body in bodies)
        {
            if (body.Alive)
                body.Enlist(frame);
        }

        // The supplied host always creates both. Treat an incomplete custom
        // world as finished instead of dereferencing an absent body.
        Paddle paddle = frame.Paddle;
        Ball ball = frame.Ball;
        if (paddle == null || ball == null)
        {
            Host.SetStatus(2);
            return 2;
        }

        paddle.Move(seconds);

        Vector2 previous = ball.Position;
        ball.Position += ball.Velocity * seconds;

        ball.BounceOffWalls();
        ball.BounceOffPaddle(paddle, previous.Y);

        int remainingBricks = frame.RemainingBricks;
        foreach (Body body in bodies)
        {
            if (!body.Alive || !body.Collide(ball, previous))
                continue;

            remainingBricks--;
            break;
        }

        Host.SetPosition(paddle.Handle, paddle.Position.X, paddle.Position.Y);
        Host.SetPosition(ball.Handle, ball.Position.X, ball.Position.Y);
        Host.SetVelocity(ball.Handle, ball.Velocity.X, ball.Velocity.Y);

        if (remainingBricks == 0)
            status = 1;
        else if (ball.Position.Y - ball.Extent.Y > 600)
            status = 2;

        if (status != 0)
            Host.SetStatus(status);

        return status;
    }

    internal static float Clamp(float value, float minimum, float maximum)
    {
        if (value < minimum)
            return minimum;
        if (value > maximum)
            return maximum;
        return value;
    }

    internal static float Minimum(float left, float right)
    {
        if (left < right)
            return left;
        return right;
    }

    internal static float Absolute(float value)
    {
        if (value < 0)
            return -value;
        return value;
    }

    // The browser's rollback demo invokes this deliberately broken frame.
    // The valid command is queued first; the bounds trap must discard it.
    public static void FailAfterMove()
    {
        Host.SetPosition(1, 55, 550);
        var empty = new int[0];
        Host.SetScore(empty[0]);
    }
}
