// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln
{
    using Sdk = global::Console.Sdk;

    /// <summary>
    /// The synthesizer's output: after every frame the console's audio
    /// queue is topped up to a few frames ahead, which the host plays a
    /// frame's worth of at a time.
    /// </summary>
    internal sealed class Speaker
    {
        private const int FramesPerTick = Synth.SampleRate / Host.TicksPerSecond;
        private const int Ahead = FramesPerTick * 3;

        // The usual top-up is one frame's worth; other sizes get their own
        // buffer, since a list crosses the boundary whole.
        private readonly short[] usual = new short[FramesPerTick * 2];

        public Synth Synth { get; } = new Synth();

        public bool Muted { get; set; }

        internal void Pump()
        {
            int queued = (int)Sdk.Audio.Queued();
            if (queued >= Ahead)
            {
                return;
            }

            int frames = Ahead - queued;
            short[] samples = frames == FramesPerTick ? usual : new short[frames * 2];
            Synth.Render(samples, frames);
            if (Muted)
            {
                System.Array.Clear(samples);
            }

            Sdk.Audio.Write(samples);
        }
    }
}
