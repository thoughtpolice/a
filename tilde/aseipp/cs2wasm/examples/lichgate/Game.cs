// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Lichgate: descend the Lich's crypt, floor after floor, one seeded room at
// a time. The game is a Kiln App; its scenes (title, run, pause, the end
// and the hall of the fallen) are one async flow over the frame loop, and
// the fighting is the world's systems and its creatures' scripts.
namespace Lichgate;

using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
using Gameplay;
using Kiln;
using Sdk = global::Console.Sdk;

internal enum Act
{
    Up,
    Down,
    Left,
    Right,
    AimUp,
    AimDown,
    AimLeft,
    AimRight,
    Dash,
    Pause,
    Confirm,
    Music,
    Quit,
}

internal enum Mode
{
    Title,
    Play,
    Paused,
    Moving,
    Over,
}

internal sealed record Outcome(int Score, int Floor, int Kills, int Rooms, bool Demo);

internal sealed class Game : App
{
    private static Game current;

    private readonly Autopilot pilot = new Autopilot();
    private World world;
    private InputMap<Act> input;
    private Settings settings;
    private List<Score> scores;
    private Mode mode;
    private bool demo;
    private int runs;
    private float brightness = 1;
    private float flash;
    private string banner;
    private int bannerTicks;
    private Canvas titleBackdrop;
    private Particles titleEmbers;
    private string typed = "";
    private bool entering;
    private long ticks;
    private int idle;

    public override string Title => "Lichgate";

    public override int Width => 320;

    public override int Height => 192;

    public static void Play(Sound sound)
    {
        if (current.settings.Effects)
        {
            Host.Speaker.Synth.Play(sound);
        }
    }

    public static void Flash(float amount) => current.flash = Math.Max(current.flash, amount - 1);

    public static void Log(string message) => Host.Log(message);

    public override void Start()
    {
        current = this;
        Colors.Install(Host.Screen.Palette);
        settings = Settings.Load();
        scores = HighScores.Load();
        input = new InputMap<Act>(Host.Controls)
            .Bind(Act.Up, new[] { Sdk.Input.Key.W })
            .Bind(Act.Down, new[] { Sdk.Input.Key.S })
            .Bind(Act.Left, new[] { Sdk.Input.Key.A })
            .Bind(Act.Right, new[] { Sdk.Input.Key.D })
            .Bind(Act.AimUp, new[] { Sdk.Input.Key.Up, Sdk.Input.Key.I }, Sdk.Input.Buttons.Up)
            .Bind(Act.AimDown, new[] { Sdk.Input.Key.Down, Sdk.Input.Key.K }, Sdk.Input.Buttons.Down)
            .Bind(Act.AimLeft, new[] { Sdk.Input.Key.Left, Sdk.Input.Key.J }, Sdk.Input.Buttons.Left)
            .Bind(Act.AimRight, new[] { Sdk.Input.Key.Right, Sdk.Input.Key.L }, Sdk.Input.Buttons.Right)
            .Bind(Act.Dash, new[] { Sdk.Input.Key.Space, Sdk.Input.Key.Shift }, Sdk.Input.Buttons.B, Sdk.Input.MouseButtons.Right)
            .Bind(Act.Pause, new[] { Sdk.Input.Key.Escape, Sdk.Input.Key.P })
            .Bind(Act.Confirm, new[] { Sdk.Input.Key.Enter, Sdk.Input.Key.Z }, Sdk.Input.Buttons.Start | Sdk.Input.Buttons.A)
            .Bind(Act.Music, new[] { Sdk.Input.Key.M })
            .Bind(Act.Quit, new[] { Sdk.Input.Key.Q });
        world = World.Create();
        world.View = new View { Canvas = Host.Screen.Canvas };
        titleBackdrop = TitleBackdrop();
        titleEmbers = new Particles(200);
        Host.Speaker.Synth.MusicVolume = settings.Music ? 0.5f : 0;
        Log("lichgate: seed " + Host.Seed + ", " + scores.Count + " high scores, save " + (Saves.Persistent ? "persistent" : "for the session"));
        _ = Flow();
    }

    // MARK: Scenes

    private async Task Flow()
    {
        bool autopilot = Host.HasArg("--autopilot");
        while (true)
        {
            bool attract = autopilot || await Titles();
            var outcome = await Descend(attract);
            Log("run over: score=" + outcome.Score + " floor=" + outcome.Floor + " kills=" + outcome.Kills + " rooms=" + outcome.Rooms + (outcome.Demo ? " (demo)" : ""));
            if (!outcome.Demo)
            {
                await Fallen(outcome);
            }
        }
    }

    // The title: returns false to play, true after a while idle, for the
    // attract mode's demonstration.
    private async Task<bool> Titles()
    {
        mode = Mode.Title;
        Music(Sounds.Title);
        await Fade(1, 20);
        for (int tick = 0; ; tick++)
        {
            await Frames.NextFrame();
            if (input.Pressed(Act.Music))
            {
                ToggleMusic();
            }

            if (input.Pressed(Act.Confirm))
            {
                Play(Sounds.Start);
                await Fade(0, 20);
                return false;
            }

            if (Host.Controls.AnyPressed)
            {
                tick = 0;
            }

            if (tick > 60 * 20)
            {
                await Fade(0, 30);
                return true;
            }
        }
    }

    private async Task<Outcome> Descend(bool attract)
    {
        demo = attract;
        runs++;
        ulong seed = Host.Seed + (ulong)runs * 0x9E3779B9UL;
        world.Clear();
        var run = new Crawl();
        world.Crawl = run;
        world.Effects = new Effects { Rng = new Rng(seed ^ 0xEFFEC7) };
        // The run's sparks are the world's particles, which Kiln ages every tick.
        world.Particles = world.Effects.Particles;
        world.Arena = new Arena();
        world.Intent = new Intent();
        run.Dungeon = Dungeon.Generate(seed, 1);
        var hero = world.Spawn();
        world.Add(hero, new Position { Value = new Vector2(Dungeon.Width * 8, Dungeon.Height * 8) });
        world.Add(hero, new Velocity());
        world.Add(hero, new Body { Radius = 4.5f, Layer = Layers.Hero, Solid = true });
        world.Add(hero, new Health { Current = run.Stats.MaxHealth, Max = run.Stats.MaxHealth });
        world.Add(hero, new Look { Frames = Art.Player, Rate = 0 });
        world.Add(hero, new Hero());
        run.Hero = hero;
        Log("floor 1 of seed " + seed + ": " + run.Dungeon.Rooms.Count + " rooms" + (attract ? " (demo)" : ""));
        Music(Sounds.Floor(seed, 1));
        Enter(run.Dungeon.Start, null);
        Banner("FLOOR 1");
        mode = Mode.Play;
        await Fade(1, 20);
        for (int tick = 0; ; tick++)
        {
            await Frames.NextFrame();
            if (run.Over)
            {
                break;
            }

            if (attract && !Host.HasArg("--autopilot") && (Host.Controls.AnyPressed || tick > 60 * 90))
            {
                break;
            }

            if (!attract && input.Pressed(Act.Pause))
            {
                if (await Paused())
                {
                    run.Over = true;
                    break;
                }
            }

            if (world.Arena.Leaving is { } side)
            {
                await Move(side);
            }

            if (run.Descending)
            {
                await Deeper(seed);
            }
        }

        if (run.Over && world.IsAlive(run.Hero))
        {
            // The hero's end: everything stops but the sparks.
            var at = world.Get<Position>(run.Hero).Value;
            world.Effects.Particles.Burst(world.Effects.Rng, at, 60, 0.4f, 3f, 30, 70, Colors.Magic, 0.03f, 2);
            world.Despawn(run.Hero);
            Play(Sounds.Boom);
            mode = Mode.Moving;
            for (int tick = 0; tick < 70; tick++)
            {
                world.Effects.Particles.Update();
                await Frames.NextFrame();
            }
        }

        await Fade(0, 30);
        Host.Speaker.Synth.StopMusic();
        return new Outcome(run.Score, run.Floor, run.Kills, run.RoomsCleared, attract);
    }

    // Pause: true when the player quits the run.
    private async Task<bool> Paused()
    {
        mode = Mode.Paused;
        Play(Sounds.Select);
        while (true)
        {
            await Frames.NextFrame();
            if (input.Pressed(Act.Music))
            {
                ToggleMusic();
            }

            if (input.Pressed(Act.Quit))
            {
                mode = Mode.Play;
                return true;
            }

            if (input.Pressed(Act.Pause) || input.Pressed(Act.Confirm))
            {
                Play(Sounds.Select);
                mode = Mode.Play;
                return false;
            }
        }
    }

    // Through a door: a fade, the next room, a fade back.
    private async Task Move(Side side)
    {
        mode = Mode.Moving;
        Play(Sounds.Door);
        await Fade(0, 10);
        var run = world.Crawl;
        var next = run.Dungeon.Neighbor(world.Arena.Room, side);
        Enter(next, side);
        mode = Mode.Play;
        await Fade(1, 10);
    }

    // Down the stairs: a new floor from the same seed, harder.
    private async Task Deeper(ulong seed)
    {
        var run = world.Crawl;
        mode = Mode.Moving;
        run.Descending = false;
        Play(Sounds.Teleport);
        await Fade(0, 40);
        run.Floor++;
        run.Dungeon = Dungeon.Generate(seed, run.Floor);
        ref var health = ref world.Get<Health>(run.Hero);
        health.Current = Math.Min(health.Max, health.Current + 2);
        Log("floor " + run.Floor + ": " + run.Dungeon.Rooms.Count + " rooms, score=" + run.Score);
        Music(Sounds.Floor(seed, run.Floor));
        Enter(run.Dungeon.Start, null);
        Banner("FLOOR " + run.Floor);
        mode = Mode.Play;
        await Fade(1, 30);
    }

    // The end of a run: the score, and a name for the hall if it is high.
    private async Task Fallen(Outcome outcome)
    {
        mode = Mode.Over;
        entering = HighScores.Qualifies(scores, outcome.Score);
        typed = "";
        await Fade(1, 20);
        while (true)
        {
            await Frames.NextFrame();
            if (entering)
            {
                foreach (char character in Host.Controls.Text)
                {
                    if (typed.Length < 8 && (char.IsLetterOrDigit(character) || character == ' '))
                    {
                        typed += char.ToUpperInvariant(character);
                        Play(Sounds.Select);
                    }
                }

                if (Host.Controls.Pressed(Sdk.Input.Key.Backspace) && typed.Length > 0)
                {
                    typed = typed.Substring(0, typed.Length - 1);
                }

                if (Host.Controls.Pressed(Sdk.Input.Key.Enter) && typed.Trim().Length > 0)
                {
                    scores = HighScores.Rank(scores.Append(new Score(typed.Trim(), outcome.Score, outcome.Floor)));
                    HighScores.Save(scores);
                    Log("high score " + typed.Trim() + " " + outcome.Score + " floor " + outcome.Floor);
                    entering = false;
                    Play(Sounds.Relic);
                    await Task.Delay(400);
                }

                continue;
            }

            if (input.Pressed(Act.Confirm))
            {
                Play(Sounds.Select);
                await Fade(0, 20);
                return;
            }
        }
    }

    // MARK: Rooms

    private void Enter(Room room, Side? through)
    {
        var run = world.Crawl;
        var arena = world.Arena;
        foreach (var entity in world.Query<Position>().Without<Hero>())
        {
            world.Despawn(entity);
        }

        if (arena.Director is { IsNone: false } director)
        {
            world.Despawn(director);
        }

        world.Effects.Particles.Clear();
        world.Effects.Popups.Clear();
        arena.Leaving = null;
        arena.Room = room;
        arena.Pending = 0;
        room.Visited = true;
        room.Background ??= Dungeon.Draw(room, run.Floor);
        var start = through is { } side ? Room.EntryPoint(Room.Opposite(side)) : new Vector2(Dungeon.Width * 8, Dungeon.Height * 8 + 10);
        world.Get<Position>(run.Hero).Value = start;
        world.Get<Velocity>(run.Hero).Value = Vector2.Zero;
        string doors = "";
        for (int door = 0; door < 4; door++)
        {
            doors += room.Doors[door] ? "NESW".Substring(door, 1) : "";
        }

        Log("enter room " + room.X + "," + room.Y + " " + room.Type + " doors=" + doors + (room.Cleared ? " (cleared)" : ""));
        if (room.Cleared)
        {
            arena.Locked = false;
            return;
        }

        switch (room.Type)
        {
            case RoomType.Fight:
                arena.Locked = true;
                arena.Director = world.Spawn();
                world.Scheduler.Start(arena.Director, script => Encounter(script, room, start), "encounter");
                break;
            case RoomType.Boss:
                arena.Locked = true;
                arena.Pending = 1;
                Music(Sounds.Lair(room.Seed));
                arena.Director = world.Spawn();
                world.Scheduler.Start(arena.Director, script => Confrontation(script), "lair");
                break;
            case RoomType.Treasure:
                room.Cleared = true;
                arena.Locked = false;
                Loot.Altars(world, run, new Rng(room.Seed), 2, new Vector2(Dungeon.Width * 8, Dungeon.Height * 8 - 12));
                Banner("CHOOSE A RELIC");
                break;
            case RoomType.Shrine:
                room.Cleared = true;
                arena.Locked = false;
                Loot.Drop(world, Drop.Heart, new Vector2(Dungeon.Width * 8 - 16, Dungeon.Height * 8), 2);
                Loot.Drop(world, Drop.Heart, new Vector2(Dungeon.Width * 8 + 16, Dungeon.Height * 8), 2);
                Banner("A QUIET SHRINE");
                break;
            default:
                room.Cleared = true;
                arena.Locked = false;
                break;
        }
    }

    // A fight: a wave or two from the floor's roster, placed away from
    // where the hero came in; the next wave when the last is gone.
    private async Task Encounter(Script script, Room room, Vector2 entry)
    {
        var arena = world.Arena;
        var run = world.Crawl;
        var rng = new Rng(room.Seed);
        int waves = room.Distance >= 3 && rng.Chance(0.5f) ? 2 : 1;
        arena.Pending = waves;
        var roster = Bestiary.Roster(run.Floor);
        var weights = roster.Select(entry => entry.Weight).ToArray();
        for (int wave = 0; wave < waves; wave++)
        {
            await script.Ticks(wave == 0 ? 25 : 40);
            int count = Math.Min(10, 2 + run.Floor + rng.Range(0, 3) + room.Distance / 2);
            for (int index = 0; index < count; index++)
            {
                var kind = roster[rng.Weighted(weights)].Kind;
                Bestiary.Spawn(world, kind, Place(room, rng, entry), run.Floor);
            }

            arena.Pending--;
            await script.Until(() => world.Count<Enemy>() == 0);
        }
    }

    // The Lich's entrance.
    private async Task Confrontation(Script script)
    {
        var arena = world.Arena;
        Banner("THE LICH");
        world.Effects.Kick(0.6f);
        Play(Sounds.Boom);
        await script.Ticks(45);
        Bestiary.Spawn(world, Kind.Lich, new Vector2(Dungeon.Width * 8, 44), world.Crawl.Floor);
        arena.Pending = 0;
    }

    // A free floor cell far enough from the hero.
    private static Vector2 Place(Room room, Rng rng, Vector2 away)
    {
        for (int attempt = 0; ; attempt++)
        {
            int x = rng.Range(2, Dungeon.Width - 2);
            int y = rng.Range(2, Dungeon.Height - 2);
            var point = new Vector2(x * Tiles.Size + 8, y * Tiles.Size + 8);
            if (room.At(x, y) == Cell.Floor && (Vector2.Distance(point, away) > 70 || attempt > 40))
            {
                return point;
            }
        }
    }

    // MARK: Frames

    public override void Tick()
    {
        ticks++;
        if (bannerTicks > 0)
        {
            bannerTicks--;
        }

        flash = Math.Max(0, flash - 0.08f);
        Host.Screen.Palette.Brightness = brightness + flash;
        if (mode == Mode.Title)
        {
            titleEmbers.Emit(new Vector2(world.Effects.Rng.Range(0, Width), Height), new Vector2(world.Effects.Rng.Range(-0.2f, 0.2f), -world.Effects.Rng.Range(0.3f, 1.2f)), 90, Colors.Fire, 0, 0.995f);
            titleEmbers.Update();
            return;
        }

        if (mode != Mode.Play)
        {
            return;
        }

        var intent = world.Intent;
        if (demo)
        {
            pilot.Think(world, intent);
        }
        else
        {
            Read(intent);
        }

        var effects = world.Effects;
        if (effects.Freeze > 0)
        {
            effects.Freeze--;
            return;
        }

        world.Tick();
        if (world.Crawl.Hero is var hero && world.IsAlive(hero))
        {
            ref var look = ref world.Get<Look>(hero);
            look.Frame = world.Get<Velocity>(hero).Value.LengthSquared() > 0.1f ? (int)(ticks / 8 % 2) : 0;
        }
    }

    // The player's keys and mouse as an intent.
    private void Read(Intent intent)
    {
        intent.Move = input.Axis(Act.Left, Act.Right, Act.Up, Act.Down);
        intent.Aim = input.Axis(Act.AimLeft, Act.AimRight, Act.AimUp, Act.AimDown);
        intent.Fire = intent.Aim != Vector2.Zero;
        intent.Dash = input.Pressed(Act.Dash);
        var controls = Host.Controls;
        if (controls.Down(Sdk.Input.MouseButtons.Left) && world.IsAlive(world.Crawl.Hero))
        {
            var pointer = controls.Pointer - new Vector2(0, View.Band);
            intent.Aim = pointer - world.Get<Position>(world.Crawl.Hero).Value;
            intent.Fire = intent.Aim != Vector2.Zero;
            world.View.Pointer = pointer;
        }
        else if (controls.PointerMoved)
        {
            world.View.Pointer = controls.Pointer - new Vector2(0, View.Band);
        }
    }

    public override void Draw()
    {
        var screen = Host.Screen;
        var canvas = screen.Canvas;
        switch (mode)
        {
            case Mode.Title:
                DrawTitle(screen, canvas);
                return;
            case Mode.Over:
                DrawFallen(screen, canvas);
                return;
        }

        world.View.Frame = ticks;
        world.Render();
        if (bannerTicks > 0)
        {
            var tween = Ease.OutBack(Math.Min(1f, (120 - bannerTicks) / 20f));
            int y = (int)Interpolate.Lerp(-10f, 70f, tween);
            screen.ShadowedCentered(y, banner, Colors.Yellow, Colors.Black);
        }

        if (mode == Mode.Paused)
        {
            screen.Panel(100, 70, 120, 52, Colors.Night);
            screen.TextCentered(76, "PAUSED", Colors.White);
            screen.TextCentered(90, "ENTER  RESUME", Colors.Silver);
            screen.TextCentered(100, "M  MUSIC " + (settings.Music ? "ON" : "OFF"), Colors.Silver);
            screen.TextCentered(110, "Q  QUIT RUN", Colors.Silver);
        }

        if (demo && ticks / 30 % 2 == 0)
        {
            screen.Text(210, 5, "DEMO", Colors.Gray);
        }
    }

    private void DrawTitle(Screen screen, Canvas canvas)
    {
        canvas.CameraX = 0;
        canvas.CameraY = 0;
        canvas.ResetClip();
        canvas.Blit(titleBackdrop, 0, 0);
        titleEmbers.Draw(canvas);
        // The name, each letter bobbing on its own beat.
        const string Name = "LICHGATE";
        int left = (Width - Name.Length * 22) / 2;
        for (int index = 0; index < Name.Length; index++)
        {
            int bob = (int)(MathF.Sin(ticks * 0.06f + index * 0.7f) * 3);
            Big(canvas, Name[index].ToString(), left + index * 22 + 2, 32 + bob + 2, Colors.Black);
            Big(canvas, Name[index].ToString(), left + index * 22, 32 + bob, index % 2 == 0 ? Colors.Rose : Colors.Red);
        }

        screen.ShadowedCentered(66, "A DESCENT INTO THE LICH'S CRYPT", Colors.Frost, Colors.Black);
        if (ticks / 30 % 2 == 0)
        {
            screen.ShadowedCentered(84, "PRESS ENTER", Colors.Yellow, Colors.Black);
        }

        screen.ShadowedCentered(100, "HALL OF THE FALLEN", Colors.Gold, Colors.Black);
        for (int index = 0; index < Math.Min(5, scores.Count); index++)
        {
            var score = scores[index];
            string line = (index + 1) + ". " + score.Name.PadRight(8) + " " + score.Points.ToString().PadLeft(6) + "  F" + score.Floor;
            screen.ShadowedCentered(112 + index * 9, line, Colors.Silver, Colors.Black);
        }

        if (scores.Count == 0)
        {
            screen.ShadowedCentered(112, "NO ONE YET", Colors.Gray, Colors.Black);
        }

        screen.Shadowed(4, Height - 22, "WASD MOVE  ARROWS/MOUSE SHOOT", Colors.Gray, Colors.Black);
        screen.Shadowed(4, Height - 12, "SPACE DASH  ESC PAUSE  M MUSIC", Colors.Gray, Colors.Black);
    }

    private void DrawFallen(Screen screen, Canvas canvas)
    {
        canvas.CameraX = 0;
        canvas.CameraY = 0;
        canvas.ResetClip();
        canvas.Clear(Colors.Black);
        world.Effects.Particles.Draw(canvas);
        var run = world.Crawl;
        screen.ShadowedCentered(40, "YOU HAVE FALLEN", Colors.Rose, Colors.Black);
        screen.ShadowedCentered(60, "SCORE " + run.Score, Colors.White, Colors.Black);
        screen.ShadowedCentered(72, "FLOOR " + run.Floor + "  KILLS " + run.Kills + "  ROOMS " + run.RoomsCleared, Colors.Silver, Colors.Black);
        if (run.Upgrades.Count > 0)
        {
            screen.ShadowedCentered(84, string.Join(" ", run.Upgrades.Select(upgrade => upgrade.Name.Split(' ')[0])), Colors.Gold, Colors.Black);
        }

        if (entering)
        {
            screen.ShadowedCentered(108, "A NEW RECORD! YOUR NAME:", Colors.Yellow, Colors.Black);
            screen.ShadowedCentered(122, typed + (ticks / 20 % 2 == 0 ? "_" : " "), Colors.White, Colors.Black);
            screen.ShadowedCentered(140, "TYPE, THEN ENTER", Colors.Gray, Colors.Black);
        }
        else if (ticks / 30 % 2 == 0)
        {
            screen.ShadowedCentered(130, "PRESS ENTER", Colors.Yellow, Colors.Black);
        }
    }

    // The canvas font three times over.
    private static void Big(Canvas canvas, string text, int x, int y, byte color)
    {
        foreach (char character in text)
        {
            ushort glyph = Font.Glyph(character);
            for (int bit = 0; bit < 15; bit++)
            {
                if ((glyph & (1 << (14 - bit))) != 0)
                {
                    canvas.Fill(x + bit % 3 * 6, y + bit / 3 * 5, 6, 5, color);
                }
            }

            x += 22;
        }
    }

    private Canvas TitleBackdrop()
    {
        var room = Dungeon.Generate(0x7171E, 1).Lair;
        var drawn = Dungeon.Draw(room, 3);
        var backdrop = new Canvas(Width, Height);
        backdrop.Clear(Colors.Black);
        backdrop.Blit(drawn, 0, View.Band);
        backdrop.Remap(0, 0, Width, Height, Colors.Shade);
        backdrop.Remap(0, 0, Width, Height, Colors.Shade);
        return backdrop;
    }

    // MARK: Presentation

    private void Banner(string text)
    {
        banner = text;
        bannerTicks = 120;
    }

    private void Music(Song song)
    {
        Host.Speaker.Synth.StopMusic();
        Host.Speaker.Synth.Music = new Sequencer(song);
    }

    private void ToggleMusic()
    {
        settings.Music = !settings.Music;
        Host.Speaker.Synth.MusicVolume = settings.Music ? 0.5f : 0;
        settings.Save();
        Log("music " + (settings.Music ? "on" : "off"));
    }

    // Brightness towards a target over some ticks, eased.
    private async Task Fade(float to, int duration)
    {
        var tween = new Tween<float>(brightness, to, duration, Ease.InOutQuad);
        while (!tween.Done)
        {
            brightness = tween.Step();
            await Frames.NextFrame();
        }

        brightness = to;
    }
}
