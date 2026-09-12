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

// A temporary Wasm GC object. Persistent state belongs to the host; these
// objects and the array containing them become collectible after each Tick.
internal sealed class Body
{
    internal int Handle;
    internal int Kind;
    internal bool Alive;
    internal float X;
    internal float Y;
    internal float VelocityX;
    internal float VelocityY;
    internal float HalfWidth = 31;
    internal float HalfHeight = 10;

    internal Body(int handle)
    {
        Handle = handle;
        Kind = Host.Kind(handle);
        Alive = Host.IsAlive(handle);
        X = Host.ReadX(handle);
        Y = Host.ReadY(handle);
        VelocityX = Host.ReadVelocityX(handle);
        VelocityY = Host.ReadVelocityY(handle);

        if (Kind == 0)
        {
            HalfWidth = 55;
            HalfHeight = 9;
        }
        else if (Kind == 1)
        {
            HalfWidth = 8;
            HalfHeight = 8;
        }
    }
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

        var bodies = new Body[Host.EntityCount()];
        for (int index = 0; index < bodies.Length; index++)
            bodies[index] = new Body(Host.EntityAt(index));

        Body paddle = null;
        Body ball = null;
        int remainingBricks = 0;
        foreach (Body body in bodies)
        {
            if (!body.Alive)
                continue;

            if (body.Kind == 0)
                paddle = body;
            else if (body.Kind == 1)
                ball = body;
            else if (body.Kind == 2)
                remainingBricks++;
        }

        // The supplied host always creates both. Treat an incomplete custom
        // world as finished instead of dereferencing an absent body.
        if (paddle == null || ball == null)
        {
            Host.SetStatus(2);
            return 2;
        }

        MovePaddle(paddle, seconds);

        float previousX = ball.X;
        float previousY = ball.Y;
        ball.X += ball.VelocityX * seconds;
        ball.Y += ball.VelocityY * seconds;

        BounceOffWalls(ball);
        BounceOffPaddle(ball, paddle, previousY);

        foreach (Body brick in bodies)
        {
            if (brick.Kind != 2 || !brick.Alive)
                continue;

            // Expand the rectangle by the ball radius, then test its center.
            // This uses a square approximation at the four brick corners.
            float left = brick.X - brick.HalfWidth - ball.HalfWidth;
            float right = brick.X + brick.HalfWidth + ball.HalfWidth;
            float top = brick.Y - brick.HalfHeight - ball.HalfHeight;
            float bottom = brick.Y + brick.HalfHeight + ball.HalfHeight;
            if (ball.X < left || ball.X > right || ball.Y < top || ball.Y > bottom)
                continue;

            BounceOffBrick(ball, previousX, previousY, left, right, top, bottom);
            brick.Alive = false;
            Host.SetAlive(brick.Handle, false);
            Host.SetScore(Host.Score() + 10);
            remainingBricks--;
            break;
        }

        Host.SetPosition(paddle.Handle, paddle.X, paddle.Y);
        Host.SetPosition(ball.Handle, ball.X, ball.Y);
        Host.SetVelocity(ball.Handle, ball.VelocityX, ball.VelocityY);

        if (remainingBricks == 0)
            status = 1;
        else if (ball.Y - ball.HalfHeight > 600)
            status = 2;

        if (status != 0)
            Host.SetStatus(status);

        return status;
    }

    private static void MovePaddle(Body paddle, float seconds)
    {
        float target = Clamp(Host.PaddleTarget(), paddle.HalfWidth, 800 - paddle.HalfWidth);
        float maximumMove = 600 * seconds;
        paddle.X += Clamp(target - paddle.X, -maximumMove, maximumMove);
    }

    private static void BounceOffWalls(Body ball)
    {
        if (ball.X < ball.HalfWidth)
        {
            ball.X = ball.HalfWidth;
            if (ball.VelocityX < 0)
                ball.VelocityX = -ball.VelocityX;
        }
        else if (ball.X > 800 - ball.HalfWidth)
        {
            ball.X = 800 - ball.HalfWidth;
            if (ball.VelocityX > 0)
                ball.VelocityX = -ball.VelocityX;
        }

        if (ball.Y < ball.HalfHeight)
        {
            ball.Y = ball.HalfHeight;
            if (ball.VelocityY < 0)
                ball.VelocityY = -ball.VelocityY;
        }
    }

    private static void BounceOffPaddle(Body ball, Body paddle, float previousY)
    {
        float top = paddle.Y - paddle.HalfHeight;
        if (ball.VelocityY <= 0 || previousY + ball.HalfHeight > top
            || ball.Y + ball.HalfHeight < top
            || ball.X < paddle.X - paddle.HalfWidth - ball.HalfWidth
            || ball.X > paddle.X + paddle.HalfWidth + ball.HalfWidth)
            return;

        // Hitting near an edge sends the ball sideways. Move it above the
        // paddle before reflecting, so the next step cannot hit it again.
        ball.Y = top - ball.HalfHeight;
        float offset = Clamp((ball.X - paddle.X) / paddle.HalfWidth, -1, 1);
        ball.VelocityX = offset * 280;
        ball.VelocityY = -260;
    }

    private static void BounceOffBrick(
        Body ball, float previousX, float previousY,
        float left, float right, float top, float bottom)
    {
        // The previous center tells us which face the ball crossed.
        if (previousY <= top)
        {
            ball.Y = top;
            ball.VelocityY = -Absolute(ball.VelocityY);
        }
        else if (previousY >= bottom)
        {
            ball.Y = bottom;
            ball.VelocityY = Absolute(ball.VelocityY);
        }
        else if (previousX <= left)
        {
            ball.X = left;
            ball.VelocityX = -Absolute(ball.VelocityX);
        }
        else if (previousX >= right)
        {
            ball.X = right;
            ball.VelocityX = Absolute(ball.VelocityX);
        }
        else
        {
            // A custom initial world may place the ball inside a brick.
            // Resolve through its nearest face so it does not stay embedded.
            float horizontalOverlap = Minimum(ball.X - left, right - ball.X);
            float verticalOverlap = Minimum(ball.Y - top, bottom - ball.Y);
            if (horizontalOverlap < verticalOverlap)
            {
                if (ball.X - left < right - ball.X)
                {
                    ball.X = left;
                    ball.VelocityX = -Absolute(ball.VelocityX);
                }
                else
                {
                    ball.X = right;
                    ball.VelocityX = Absolute(ball.VelocityX);
                }
            }
            else if (ball.Y - top < bottom - ball.Y)
            {
                ball.Y = top;
                ball.VelocityY = -Absolute(ball.VelocityY);
            }
            else
            {
                ball.Y = bottom;
                ball.VelocityY = Absolute(ball.VelocityY);
            }
        }
    }

    private static float Clamp(float value, float minimum, float maximum)
    {
        if (value < minimum)
            return minimum;
        if (value > maximum)
            return maximum;
        return value;
    }

    private static float Minimum(float left, float right)
    {
        if (left < right)
            return left;
        return right;
    }

    private static float Absolute(float value)
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
