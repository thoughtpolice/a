// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;

/// <summary>An oscillator's shape.</summary>
public enum Wave : byte
{
    Square,
    Triangle,
    Saw,
    Sine,
    Noise,
}

/// <summary>
/// A sound effect, as data: a wave swept from one pitch to another over a
/// duration, with a short attack and a decay to silence, and optional
/// vibrato and stereo position.
/// </summary>
public readonly record struct Sound(
    Wave Wave,
    float From,
    float To,
    float Seconds,
    float Volume = 0.5f,
    float Duty = 0.5f,
    float Vibrato = 0,
    float Pan = 0);

/// <summary>A voice's timbre for notes: a wave and an envelope.</summary>
public readonly record struct Instrument(Wave Wave, float Volume, float Duty = 0.5f, float Attack = 0.005f, float Release = 0.08f, float Slide = 0, float Pan = 0);

/// <summary>
/// A small software synthesizer: a handful of voices (square with a duty
/// cycle, triangle, saw, sine, and a linear-feedback noise), mixed to the
/// console's 44.1 kHz interleaved stereo. The first voices belong to the
/// music, the rest are taken round-robin by sound effects. Everything is
/// arithmetic on floats, so the samples are the same on every engine.
/// </summary>
public sealed class Synth
{
    public const int SampleRate = 44100;
    public const int MusicVoices = 4;
    private const int VoiceCount = 10;

    private readonly Voice[] voices = new Voice[VoiceCount];
    private int nextEffect = MusicVoices;

    public Synth()
    {
        for (int index = 0; index < VoiceCount; index++)
        {
            voices[index] = new Voice();
        }
    }

    public float MusicVolume { get; set; } = 0.5f;

    public float EffectsVolume { get; set; } = 0.7f;

    /// <summary>The song playing, advanced sample by sample as the synth renders.</summary>
    public Sequencer Music { get; set; }

    /// <summary>Plays a sound effect on the next effects voice.</summary>
    public void Play(Sound sound)
    {
        var voice = voices[nextEffect];
        nextEffect = nextEffect + 1 == VoiceCount ? MusicVoices : nextEffect + 1;
        voice.Start(sound.Wave, sound.From, sound.To, sound.Seconds, sound.Volume, sound.Duty, 0.004f, sound.Seconds * 0.6f, sound.Vibrato, sound.Pan, effect: true);
    }

    /// <summary>Plays a note on a music voice.</summary>
    public void Note(int channel, float frequency, float seconds, Instrument instrument)
    {
        float target = instrument.Slide == 0 ? frequency : frequency * MathF.Pow(2, instrument.Slide / 12f);
        voices[channel % MusicVoices].Start(
            instrument.Wave, frequency, target, seconds, instrument.Volume, instrument.Duty, instrument.Attack, instrument.Release, 0, instrument.Pan, effect: false);
    }

    public void StopMusic()
    {
        for (int index = 0; index < MusicVoices; index++)
        {
            voices[index].Active = false;
        }
    }

    /// <summary>The frequency of a MIDI note number.</summary>
    public static float Frequency(int note) => 440f * MathF.Pow(2, (note - 69) / 12f);

    /// <summary>Renders <paramref name="frames"/> stereo frames into the start of <paramref name="samples"/>.</summary>
    public void Render(short[] samples, int frames)
    {
        float musicVolume = MusicVolume;
        float effects = EffectsVolume;
        for (int frame = 0; frame < frames; frame++)
        {
            if (Music is { } music && --music.Countdown <= 0)
            {
                music.Advance(this);
            }

            float left = 0;
            float right = 0;
            for (int index = 0; index < VoiceCount; index++)
            {
                var voice = voices[index];
                if (!voice.Active)
                {
                    continue;
                }

                float value = voice.Sample() * (voice.Effect ? effects : musicVolume);
                left += value * (1 - voice.Pan);
                right += value * (1 + voice.Pan);
            }

            samples[frame * 2] = Clip(left);
            samples[frame * 2 + 1] = Clip(right);
        }
    }

    // A soft limit, so a pile of effects saturates rather than wrapping.
    private static short Clip(float value)
    {
        float limited = value / (1 + MathF.Abs(value) * 0.35f);
        return (short)Math.Clamp((int)(limited * 26000), -32767, 32767);
    }

    private sealed class Voice
    {
        private Wave wave;
        private float phase;
        private float frequency;
        private float slide;
        private float duty;
        private float volume;
        private int age;
        private int length;
        private int attack;
        private int release;
        private float vibrato;
        private uint noise = 1;
        private float held;

        public bool Active { get; set; }

        public bool Effect { get; private set; }

        public float Pan { get; private set; }

        public void Start(Wave wave, float from, float to, float seconds, float volume, float duty, float attackSeconds, float releaseSeconds, float vibrato, float pan, bool effect)
        {
            this.wave = wave;
            length = Math.Max(1, (int)(seconds * SampleRate));
            frequency = from;
            // A per-sample ratio, so a sweep is even in pitch.
            slide = MathF.Pow(to / MathF.Max(from, 1f), 1f / length);
            this.duty = duty;
            this.volume = volume;
            attack = Math.Max(1, (int)(attackSeconds * SampleRate));
            release = Math.Max(1, Math.Min(length, (int)(releaseSeconds * SampleRate)));
            this.vibrato = vibrato;
            Pan = Math.Clamp(pan, -1f, 1f);
            Effect = effect;
            age = 0;
            Active = true;
        }

        public float Sample()
        {
            float step = frequency / SampleRate;
            if (vibrato != 0)
            {
                step *= 1 + vibrato * MathF.Sin(age * (MathF.Tau * 6f / SampleRate));
            }

            phase += step;
            if (phase >= 1)
            {
                phase -= MathF.Floor(phase);
                if (wave == Wave.Noise)
                {
                    // A 15-bit linear-feedback shift register, as the old
                    // sound chips had, clocked once a cycle.
                    uint bit = (noise ^ (noise >> 1)) & 1;
                    noise = (noise >> 1) | (bit << 14);
                    held = (noise & 1) == 0 ? 1 : -1;
                }
            }

            float value = wave switch
            {
                Wave.Square => phase < duty ? 1 : -1,
                Wave.Triangle => 4 * MathF.Abs(phase - 0.5f) - 1,
                Wave.Saw => 2 * phase - 1,
                Wave.Sine => MathF.Sin(phase * MathF.Tau),
                _ => held,
            };

            float envelope = age < attack ? age / (float)attack : 1;
            int left = length - age;
            if (left < release)
            {
                envelope *= left / (float)release;
            }

            frequency *= slide;
            if (++age >= length)
            {
                Active = false;
            }

            return value * envelope * volume;
        }
    }
}
