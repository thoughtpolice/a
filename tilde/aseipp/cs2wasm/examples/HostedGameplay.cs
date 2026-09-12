// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Gameplay;

namespace Demo;

internal static class Game
{
    [WasmImport("game", "entity_count")]
    internal static extern int EntityCount();

    [WasmImport("game", "entity_at")]
    internal static extern int EntityAt(int index);

    [WasmImport("game", "is_alive")]
    internal static extern bool IsAlive(int handle);

    [WasmImport("game", "read_x")]
    internal static extern float ReadX(int handle);

    [WasmImport("game", "read_y")]
    internal static extern float ReadY(int handle);

    [WasmImport("game", "read_velocity_x")]
    internal static extern float ReadVelocityX(int handle);

    [WasmImport("game", "read_velocity_y")]
    internal static extern float ReadVelocityY(int handle);

    [WasmImport("game", "set_position")]
    internal static extern void SetPosition(int handle, float x, float y);

    [WasmImport("game", "set_velocity")]
    internal static extern void SetVelocity(int handle, float x, float y);
}

public sealed class MovingBody
{
    public float X;
    public float Y;
    public float VelocityX;
    public float VelocityY;
    public float Gravity = -2.0f;

    public MovingBody(int handle)
    {
        X = Game.ReadX(handle);
        Y = Game.ReadY(handle);
        VelocityX = Game.ReadVelocityX(handle);
        VelocityY = Game.ReadVelocityY(handle);
    }

    public void Advance(float seconds)
    {
        VelocityY += Gravity * seconds;
        X += VelocityX * seconds;
        Y += VelocityY * seconds;
    }
}

public static class HostedGameplay
{
    public static int Tick(float seconds)
    {
        var handles = new int[Game.EntityCount()];
        for (int index = 0; index < handles.Length; index++)
            handles[index] = Game.EntityAt(index);

        int moved = 0;
        foreach (int handle in handles)
        {
            if (Game.IsAlive(handle) == true)
            {
                var body = new MovingBody(handle);
                body.Advance(seconds);
                Game.SetPosition(handle, body.X, body.Y);
                Game.SetVelocity(handle, body.VelocityX, body.VelocityY);
                moved++;
            }
        }

        return moved;
    }

    // Queue a valid command, then trap: the host must discard the entire batch.
    public static void FailAfterMove(int handle)
    {
        Game.SetPosition(handle, 999, 999);
        var empty = new int[0];
        Game.SetVelocity(handle, empty[1], 0);
    }

    public static void MoveUnknownHandle() => Game.SetPosition(1234567, 0, 0);

    public static void InvalidPosition(int handle) => Game.SetPosition(handle, float.NaN, 0);
}
