// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Breakout as a console:sdk game. The module owns every bit of game state in
// static fields, draws through gfx and reads the buttons through input; the
// host only ever sees `init`, `frame` and the SDK calls they make.
namespace Console.Sdk;

public static partial class Game
{
    const int Width = 320;
    const int Height = 240;
    const int Columns = 10;
    const int Rows = 5;
    const int BrickWidth = 28;
    const int BrickHeight = 10;
    const int BrickTop = 30;
    const int PaddleWidth = 48;
    const int PaddleHeight = 6;
    const int PaddleY = Height - 20;
    const int BallSize = 5;
    const float PaddleSpeed = 220;
    const uint LongestFrameMs = 50;

    static readonly Gfx.Color Background = new Gfx.Color(16, 16, 32, 255);
    static readonly Gfx.Color PaddleColor = new Gfx.Color(230, 230, 230, 255);
    static readonly Gfx.Color BallColor = new Gfx.Color(255, 220, 64, 255);
    static readonly Gfx.Color ScoreColor = new Gfx.Color(96, 200, 255, 255);
    static readonly Gfx.Color LifeColor = new Gfx.Color(255, 96, 96, 255);
    static readonly Gfx.Color[] RowColors = new Gfx.Color[]
    {
        new Gfx.Color(240, 80, 80, 255),
        new Gfx.Color(240, 160, 64, 255),
        new Gfx.Color(240, 220, 64, 255),
        new Gfx.Color(96, 200, 96, 255),
        new Gfx.Color(96, 128, 240, 255),
    };

    static readonly bool[] bricks = new bool[Columns * Rows];
    static float paddleX;
    static float ballX;
    static float ballY;
    static float ballDx;
    static float ballDy;
    static int remaining;
    static int score;
    static int lives;
    static bool over;
    static ulong frames;

    public static partial void Init()
    {
        Gfx.SetMode(Width, Height);
        Clock.SetFrameRate(60);
        for (int index = 0; index < bricks.Length; index++)
            bricks[index] = true;
        remaining = bricks.Length;
        paddleX = (Width - PaddleWidth) / 2f;
        score = 0;
        lives = 3;
        over = false;
        Serve();
    }

    // Advances the game and draws the frame; false once the round is over.
    public static partial bool Frame(uint dtMs)
    {
        frames++;
        if (!over)
        {
            float seconds = System.Math.Min(dtMs, LongestFrameMs) / 1000f;
            Input.Buttons buttons = Input.Poll();
            float direction = 0;
            if ((buttons & Input.Buttons.Left) != 0)
                direction -= 1;
            if ((buttons & Input.Buttons.Right) != 0)
                direction += 1;
            paddleX = System.Math.Clamp(paddleX + direction * PaddleSpeed * seconds, 0, Width - PaddleWidth);

            // Small steps keep the ball from tunnelling through a brick.
            const int steps = 4;
            for (int step = 0; step < steps && !over; step++)
                Advance(seconds / steps);
        }

        Draw();
        return !over;
    }

    static void Serve()
    {
        ballX = Width / 2f;
        ballY = PaddleY - 30;
        ballDx = (frames % 2 == 0) ? 70 : -70;
        ballDy = -130;
    }

    static void Advance(float seconds)
    {
        float previousY = ballY;
        ballX += ballDx * seconds;
        ballY += ballDy * seconds;

        if (ballX < 0)
        {
            ballX = 0;
            ballDx = System.Math.Abs(ballDx);
        }
        else if (ballX > Width - BallSize)
        {
            ballX = Width - BallSize;
            ballDx = -System.Math.Abs(ballDx);
        }

        if (ballY < 0)
        {
            ballY = 0;
            ballDy = System.Math.Abs(ballDy);
        }

        // The paddle: the hit position steers the rebound.
        if (ballDy > 0 && previousY + BallSize <= PaddleY && ballY + BallSize >= PaddleY
            && ballX + BallSize >= paddleX && ballX <= paddleX + PaddleWidth)
        {
            ballY = PaddleY - BallSize;
            float offset = (ballX + BallSize / 2f - (paddleX + PaddleWidth / 2f)) / (PaddleWidth / 2f);
            ballDx = System.Math.Clamp(offset, -1, 1) * 140;
            ballDy = -System.Math.Abs(ballDy);
        }

        int column = (int)((ballX + BallSize / 2f) - (Width - Columns * (BrickWidth + 2)) / 2f) / (BrickWidth + 2);
        int row = ((int)ballY + BallSize / 2 - BrickTop) / (BrickHeight + 2);
        if (column >= 0 && column < Columns && row >= 0 && row < Rows && bricks[row * Columns + column])
        {
            bricks[row * Columns + column] = false;
            remaining--;
            score += (Rows - row) * 10;
            ballDy = -ballDy;
            if (remaining == 0)
                over = true;
        }

        if (ballY > Height)
        {
            lives--;
            if (lives == 0)
                over = true;
            else
                Serve();
        }
    }

    static void Draw()
    {
        Gfx.Clear(Background);
        int left = (Width - Columns * (BrickWidth + 2)) / 2;
        for (int row = 0; row < Rows; row++)
        {
            for (int column = 0; column < Columns; column++)
            {
                if (!bricks[row * Columns + column])
                    continue;
                Gfx.FillRect(
                    new Gfx.Rect(left + column * (BrickWidth + 2), BrickTop + row * (BrickHeight + 2), BrickWidth, BrickHeight),
                    RowColors[row]);
            }
        }

        Gfx.FillRect(new Gfx.Rect((int)paddleX, PaddleY, PaddleWidth, PaddleHeight), PaddleColor);
        Gfx.FillRect(new Gfx.Rect((int)ballX, (int)ballY, BallSize, BallSize), BallColor);

        // The score is a bar along the bottom; the lives are squares at the top.
        Gfx.FillRect(new Gfx.Rect(4, Height - 6, (uint)System.Math.Min(score / 4, Width - 8), 3), ScoreColor);
        for (int life = 0; life < lives; life++)
            Gfx.FillRect(new Gfx.Rect(4 + life * 8, 4, 5, 5), LifeColor);
    }
}
