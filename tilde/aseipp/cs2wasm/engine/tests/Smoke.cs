// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The smallest Kiln app on the console: a world with a system, a sprite
// bouncing through the canvas, sparks, a sound, a coroutine, the input
// map, and a save file written and read back. :smoke-test runs it under
// the console's headless host and checks what it logs and saves.
namespace Kiln.Smoke;

using System.Numerics;
using System.Threading.Tasks;
using Gameplay;
using Kiln;
using Sdk = global::Console.Sdk;

[Component]
internal partial struct Place
{
    public Vector2 Value;
    public Vector2 Speed;
}

[Resource]
internal sealed class Stage
{
    public Canvas Canvas;
    public Particles Sparks = new Particles(64);
    public Rng Rng = new Rng(3);
    public int Bounces;
}

internal static partial class Bouncing
{
    [System]
    static void Bounce(ref Place place, Stage stage)
    {
        place.Value += place.Speed;
        if (place.Value.X < 0 || place.Value.X > 56)
        {
            place.Speed.X = -place.Speed.X;
            stage.Bounces++;
            stage.Sparks.Burst(stage.Rng, place.Value, 6, 0.5f, 1.5f, 8, 16, new byte[] { 3, 2, 1 });
            Host.Speaker.Synth.Play(new Sound(Wave.Square, 440, 880, 0.05f));
        }

        if (place.Value.Y < 0 || place.Value.Y > 40)
        {
            place.Speed.Y = -place.Speed.Y;
        }
    }

    [System(Phase.Render)]
    static void Paint(in Place place, Stage stage)
    {
        stage.Canvas.Clear(0);
        stage.Sparks.Update();
        stage.Sparks.Draw(stage.Canvas);
        stage.Canvas.Draw(Smoker.Ball, (int)place.Value.X, (int)place.Value.Y);
        stage.Canvas.Text("KILN", 2, 2, 3);
    }
}

internal enum Action
{
    Go,
}

internal sealed class Smoker : App
{
    public static readonly Sprite Ball = Sprite.Parse(".33.", "3223", "3223", ".33.");

    private readonly World world = World.Create();
    private InputMap<Action> input;

    public override int Width => 64;

    public override int Height => 48;

    public override void Start()
    {
        var palette = Host.Screen.Palette;
        palette[0] = 0x101020;
        palette[1] = 0x803020;
        palette[2] = 0xF0A030;
        palette[3] = 0xFFFFFF;
        world.Stage.Canvas = Host.Screen.Canvas;
        world.Spawn(new Place { Value = new Vector2(10, 10), Speed = new Vector2(1.5f, 0.75f) });
        input = new InputMap<Action>(Host.Controls).Bind(Action.Go, new[] { Sdk.Input.Key.Space });
        var saved = Saves.Load("smoke/state.txt");
        Host.Log("smoke: runs before " + saved.GetInt("runs"));
        saved.Set("runs", saved.GetInt("runs") + 1);
        Saves.Save("smoke/state.txt", saved);
        _ = Countdown();
    }

    // A coroutine on the frame loop: game time, not wall time.
    private async Task Countdown()
    {
        await Task.Delay(500);
        Host.Log("smoke: half a second at tick " + Host.Ticks);
        await world.Scheduler.Seconds(0.5f);
        Host.Log("smoke: a second at tick " + Host.Ticks + ", " + world.Stage.Bounces + " bounces");
    }

    public override void Tick()
    {
        if (input.Pressed(Action.Go))
        {
            Host.Log("smoke: space at tick " + Host.Ticks);
        }

        world.Tick();
        if (Host.Ticks == 120)
        {
            Running = false;
        }
    }

    public override void Draw() => world.Render();
}

