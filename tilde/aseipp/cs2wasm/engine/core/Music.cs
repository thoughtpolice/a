// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// A voice's part of a song: a note (MIDI number) or a rest (-1) per step,
/// each held for <paramref name="Length"/> steps. A drum track has a kit
/// instead: its notes pick a piece of the kit, played at the piece's pitch.
/// </summary>
public sealed record Track(int Channel, Instrument Instrument, int[] Notes, int Length = 1, Instrument[] Kit = null, int[] KitPitches = null);

/// <summary>A song: tracks of equal step counts at a tempo, looped.</summary>
public sealed record Song(string Name, int Tempo, int Steps, IReadOnlyList<Track> Tracks);

/// <summary>
/// Plays a song on the synth's music voices: every sixteenth note (at the
/// song's tempo, counted in samples) each track starts its step's note.
/// </summary>
public sealed class Sequencer
{
    private readonly int samplesPerStep;

    public Sequencer(Song song)
    {
        Song = song;
        samplesPerStep = Synth.SampleRate * 60 / (song.Tempo * 4);
    }

    public Song Song { get; }

    /// <summary>The step playing, counted from the start.</summary>
    public int Step { get; private set; } = -1;

    // Samples until the next step; the synth counts them down and calls
    // Advance when it runs out.
    internal int Countdown { get; set; }

    internal void Advance(Synth synth)
    {
        Countdown = samplesPerStep;
        Step++;
        float stepSeconds = samplesPerStep / (float)Synth.SampleRate;
        foreach (var track in Song.Tracks)
        {
            int note = track.Notes[Step % track.Notes.Length];
            if (note < 0)
            {
                continue;
            }

            if (track.Kit is { } kit)
            {
                synth.Note(track.Channel, Synth.Frequency(track.KitPitches[note]), stepSeconds * track.Length * 0.95f, kit[note]);
            }
            else
            {
                synth.Note(track.Channel, Synth.Frequency(note), stepSeconds * track.Length * 0.95f, track.Instrument);
            }
        }
    }
}

/// <summary>
/// Songs made from a seed: a mode and a root, a chord progression in it,
/// a bass line walking the chords' roots, an arpeggio over them, a melody
/// wandering the scale on a rhythm of its own, and drums. The same seed
/// makes the same song.
/// </summary>
public static class Composer
{
    // Semitones of each mode's scale degrees.
    private static readonly int[][] Modes =
    {
        new[] { 0, 2, 3, 5, 7, 8, 10 }, // aeolian
        new[] { 0, 2, 3, 5, 7, 9, 10 }, // dorian
        new[] { 0, 1, 3, 5, 7, 8, 10 }, // phrygian
        new[] { 0, 2, 3, 5, 7, 8, 11 }, // harmonic minor
    };

    // Progressions as scale degrees, four bars each.
    private static readonly int[][] Progressions =
    {
        new[] { 0, 5, 2, 6 },
        new[] { 0, 3, 4, 0 },
        new[] { 0, 6, 5, 4 },
        new[] { 0, 3, 5, 4 },
        new[] { 0, 1, 0, 4 },
    };

    public static Instrument Bass => new(Wave.Triangle, 0.55f, Release: 0.05f);

    public static Instrument Lead => new(Wave.Square, 0.16f, Duty: 0.25f, Release: 0.1f, Pan: 0.2f);

    public static Instrument Arpeggio => new(Wave.Square, 0.09f, Duty: 0.125f, Release: 0.03f, Pan: -0.3f);

    public static Instrument Kick => new(Wave.Sine, 0.7f, Release: 0.08f, Slide: -24);

    public static Instrument Snare => new(Wave.Noise, 0.25f, Release: 0.09f);

    public static Instrument Hat => new(Wave.Noise, 0.08f, Release: 0.02f);

    public static Song Compose(ulong seed, string name, bool intense)
    {
        var rng = new Rng(seed);
        int[] mode = intense ? Modes[3] : Modes[rng.Range(0, 3)];
        int[] progression = rng.Pick(Progressions);
        int root = 45 + rng.Range(0, 7);
        int tempo = intense ? 150 + rng.Range(0, 20) : 108 + rng.Range(0, 24);
        const int StepsPerBar = 16;
        int bars = progression.Length * 2;
        int steps = bars * StepsPerBar;

        int Degree(int degree) => root + mode[((degree % 7) + 7) % 7] + 12 * (int)Math.Floor(degree / 7.0);

        var bass = new int[steps];
        var arpeggio = new int[steps];
        var lead = new int[steps];
        var drums = new int[steps];
        Array.Fill(bass, -1);
        Array.Fill(arpeggio, -1);
        Array.Fill(lead, -1);
        Array.Fill(drums, -1);

        // The bass: the chord's root on the beat, an octave or a fifth off it.
        int[] bassRhythm = intense
            ? new[] { 0, 2, 4, 6, 8, 10, 12, 14 }
            : rng.Pick(new[] { new[] { 0, 6, 8, 14 }, new[] { 0, 3, 8, 11 }, new[] { 0, 4, 8, 12 } });
        // The arpeggio: the chord's tones cycling, a pattern per song.
        int[] shape = rng.Pick(new[] { new[] { 0, 2, 4, 7 }, new[] { 0, 4, 2, 4 }, new[] { 0, 2, 4, 2 }, new[] { 4, 2, 0, 2 } });
        for (int bar = 0; bar < bars; bar++)
        {
            int chord = progression[bar % progression.Length];
            foreach (int step in bassRhythm)
            {
                int offset = step % 8 == 6 ? 4 : step % 16 == 8 && rng.Chance(0.3f) ? 7 : 0;
                bass[bar * StepsPerBar + step] = Degree(chord + offset) - 12;
            }

            int rate = intense ? 1 : 2;
            for (int step = 0; step < StepsPerBar; step += rate)
            {
                arpeggio[bar * StepsPerBar + step] = Degree(chord + shape[(step / rate) % shape.Length]) + 12;
            }
        }

        // The melody: a walk over the scale, landing on chord tones on the
        // strong beats, silent for the first half so the song builds.
        int position = 7 + rng.Range(0, 3);
        var rhythm = Enumerable.Range(0, StepsPerBar).Where(step => step % 4 == 0 || rng.Chance(0.35f)).ToArray();
        for (int bar = bars / 2; bar < bars; bar++)
        {
            int chord = progression[bar % progression.Length];
            foreach (int step in rhythm)
            {
                if (step % 8 == 0)
                {
                    position = chord + 7 + rng.Pick(new[] { 0, 2, 4 });
                }
                else
                {
                    position += rng.Pick(new[] { -2, -1, -1, 1, 1, 2 });
                    position = Math.Clamp(position, 4, 14);
                }

                if (!rng.Chance(0.12f))
                {
                    lead[bar * StepsPerBar + step] = Degree(position) + 12;
                }
            }
        }

        // Drums: a kick on the downbeats (every beat when intense), a snare
        // on the backbeat, hats between; one voice plays the kit.
        for (int step = 0; step < steps; step++)
        {
            int beat = step % StepsPerBar;
            if (beat % 8 == 0 || (intense && beat % 4 == 0) || (beat == 10 && rng.Chance(0.4f)))
            {
                drums[step] = 0;
            }
            else if (beat % 8 == 4)
            {
                drums[step] = 1;
            }
            else if (beat % 2 == 0)
            {
                drums[step] = 2;
            }
        }

        var tracks = new List<Track>
        {
            new Track(0, Bass, bass, 2),
            new Track(1, Arpeggio, arpeggio),
            new Track(2, Lead, lead, 2),
            new Track(3, Kick, drums, 1, new[] { Kick, Snare, Hat }, new[] { 45, 98, 122 }),
        };

        return new Song(name, tempo, steps, tracks);
    }
}
