// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The hall of the fallen and the settings, kept in the console's save
// directory as key=value text through the engine's Saves.
namespace Lichgate;

using System.Collections.Generic;
using System.Linq;
using Kiln;

internal sealed record Score(string Name, int Points, int Floor);

internal static class HighScores
{
    public const string Path = "lichgate/scores.txt";
    public const int Kept = 8;

    public static List<Score> Parse(KeyValues values)
    {
        var scores = new List<Score>();
        int count = values.GetInt("count");
        for (int index = 0; index < count; index++)
        {
            string name = values.Get("name." + index);
            if (name.Length > 0)
            {
                scores.Add(new Score(name, values.GetInt("score." + index), values.GetInt("floor." + index, 1)));
            }
        }

        return Rank(scores);
    }

    public static KeyValues Serialize(IReadOnlyList<Score> scores)
    {
        var values = new KeyValues();
        values.Set("count", scores.Count);
        for (int index = 0; index < scores.Count; index++)
        {
            values.Set("name." + index, scores[index].Name);
            values.Set("score." + index, scores[index].Points);
            values.Set("floor." + index, scores[index].Floor);
        }

        return values;
    }

    /// <summary>Best first; ties go to the deeper floor, then the name.</summary>
    public static List<Score> Rank(IEnumerable<Score> scores) => scores
        .OrderByDescending(score => score.Points)
        .ThenByDescending(score => score.Floor)
        .ThenBy(score => score.Name, System.StringComparer.Ordinal)
        .Take(Kept)
        .ToList();

    public static bool Qualifies(IReadOnlyList<Score> scores, int points) =>
        points > 0 && (scores.Count < Kept || points > scores.Min(score => score.Points));

    public static List<Score> Load() => Parse(Saves.Load(Path));

    public static void Save(IReadOnlyList<Score> scores)
    {
        if (!Saves.Save(Path, Serialize(scores)))
        {
            Host.Warn("the high scores could not be saved");
        }
    }
}

internal sealed class Settings
{
    public const string Path = "lichgate/settings.txt";

    public bool Music { get; set; } = true;

    public bool Effects { get; set; } = true;

    public static Settings Load()
    {
        var values = Saves.Load(Path);
        return new Settings { Music = values.GetBool("music", true), Effects = values.GetBool("effects", true) };
    }

    public void Save()
    {
        var values = Saves.Load(Path);
        values.Set("music", Music);
        values.Set("effects", Effects);
        Saves.Save(Path, values);
    }
}
