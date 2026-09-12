// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The console SDK's `game` world, implemented by Kiln: `init` makes the
// game's App and `frame` runs it at a fixed step.
namespace Console.Sdk
{
    public static partial class Game
    {
        public static partial void Init()
        {
            try
            {
                Kiln.Host.Init();
            }
            catch (System.Exception error)
            {
                Kiln.Host.Report(error);
                throw;
            }
        }

        public static partial bool Frame(uint dtMs)
        {
            try
            {
                return Kiln.Host.Frame(dtMs);
            }
            catch (System.Exception error)
            {
                Kiln.Host.Report(error);
                throw;
            }
        }
    }
}

namespace Kiln
{
    using System;
    using System.Collections.Generic;
    using Gameplay;
    using Sdk = global::Console.Sdk;

    /// <summary>
    /// A game: the engine calls <see cref="Start"/> once, <see cref="Tick"/>
    /// once per fixed step (60 a second, whatever the display's rate), and
    /// <see cref="Draw"/> once per displayed frame. The game declares
    /// <c>static partial App Create()</c> to make itself.
    /// </summary>
    internal abstract partial class App
    {
        /// <summary>Makes the game; a program implements it once.</summary>
        public static partial App Create();

        public virtual string Title => "Kiln";

        public virtual int Width => 320;

        public virtual int Height => 180;

        /// <summary>False once the game is over and the host should stop.</summary>
        public bool Running { get; protected set; } = true;

        public abstract void Start();

        public abstract void Tick();

        public abstract void Draw();
    }

    /// <summary>
    /// The engine's side of the console: the fixed-step loop, and the
    /// platform services a game uses (screen, speaker, controls, saves).
    /// </summary>
    internal static class Host
    {
        /// <summary>Fixed steps per second.</summary>
        public const int TicksPerSecond = Scheduler.TicksPerSecond;

        // Frames longer than this are cut short rather than caught up.
        private const uint LongestFrameMs = 100;

        private static App app;
        private static long accumulator;

        public static Screen Screen { get; private set; }

        public static Speaker Speaker { get; private set; }

        public static Controls Controls { get; private set; }

        /// <summary>The arguments the host was started with, the application's name first.</summary>
        public static IReadOnlyList<string> Args { get; private set; }

        /// <summary>Entropy from the host (a headless run's --seed).</summary>
        public static ulong Seed { get; private set; }

        /// <summary>The fixed steps run so far.</summary>
        public static long Ticks { get; private set; }

        /// <summary>The frames displayed so far.</summary>
        public static long Frames { get; private set; }

        public static void Log(string message) => Sdk.Log.Log_(Sdk.Log.Level.Info, message);

        public static void Warn(string message) => Sdk.Log.Log_(Sdk.Log.Level.Warn, message);

        // An exception escaping the game ends it (the module traps); its
        // type and message are logged first, since a host sees only the trap.
        internal static void Report(Exception error)
        {
            string message = "kiln: " + error.GetType().Name + ": " + error.Message;
            for (var inner = error.InnerException; inner is not null; inner = inner.InnerException)
            {
                message += " <- " + inner.GetType().Name + ": " + inner.Message;
            }

            Sdk.Log.Log_(Sdk.Log.Level.Error, message);
        }

        internal static void Init()
        {
            app = App.Create();
            Sdk.Gfx.SetMode((uint)app.Width, (uint)app.Height);
            Sdk.Clock.SetFrameRate(TicksPerSecond);
            Sdk.SystemInterface.SetTitle(app.Title);
            var args = new List<string>();
            uint count = Sdk.Process.ArgCount();
            for (uint index = 0; index < count; index++)
            {
                args.Add(Sdk.Process.Arg(index));
            }

            Args = args;
            Seed = Sdk.SystemInterface.RandomSeed();
            Screen = new Screen(app.Width, app.Height);
            Speaker = new Speaker();
            Controls = new Controls();
            app.Start();
        }

        internal static bool Frame(uint dtMs)
        {
            Frames++;
            Controls.Poll();
            accumulator += Math.Min(dtMs, LongestFrameMs) * TicksPerSecond;
            while (accumulator >= 1000)
            {
                accumulator -= 1000;
                Ticks++;
                // Game time for the frame loop's delays, in whole
                // milliseconds that add up to the ticks' exact time.
                long elapsed = Ticks * 1000 / TicksPerSecond - (Ticks - 1) * 1000 / TicksPerSecond;
                global::Gameplay.Frames.Advance(TimeSpan.FromMilliseconds(elapsed));
                app.Tick();
                Controls.EndTick();
            }

            app.Draw();
            Screen.Present();
            Speaker.Pump();
            return app.Running;
        }

        /// <summary>Whether a flag was given on the command line.</summary>
        public static bool HasArg(string flag)
        {
            for (int index = 1; index < Args.Count; index++)
            {
                if (Args[index] == flag)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
