// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Multicast;

public delegate int Scorer(int value);

public delegate void Notify(int value);

public static class Log
{
    public static int Value;

    public static void Add(int step) => Value = Value * 10 + step;
}

public class Unit
{
    public int Id;

    public virtual int Score(int value) => value + Id;

    public void Note(int value) => Log.Add(Id);

    public static int Twice(int value) => value * 2;
}

public sealed class Elite : Unit
{
    public override int Score(int value) => value * 100 + Id;
}

public sealed class Button
{
    public event Action Clicked;

    public event Notify Changed;

    public static event Action Global;

    private Notify custom;

    public event Notify Custom
    {
        add
        {
            Log.Add(8);
            custom += value;
        }
        remove
        {
            Log.Add(9);
            custom -= value;
        }
    }

    public void Click() => Clicked?.Invoke();

    public void Change(int value)
    {
        Changed?.Invoke(value);
        custom?.Invoke(value);
    }

    public static void RaiseGlobal() => Global?.Invoke();

    public static void ClearGlobal() => Global = null;

    public bool HasClicked => Clicked != null;
}

public static class Multicast
{
    private static void One() => Log.Add(1);

    private static void Two() => Log.Add(2);

    private static void Three() => Log.Add(3);

    private static int Run(Action action)
    {
        Log.Value = 0;
        action?.Invoke();
        return Log.Value;
    }

    public static int Combine(int which)
    {
        Action one = One;
        Action two = Two;
        Action three = Three;
        Action all = one + two + three;
        return which switch
        {
            0 => Run(all),
            1 => Run(all - two),
            2 => Run(all - one - three),
            3 => Run(all - (two + three)),
            4 => Run(all - (one + three)),
            5 => Run(one + one + two + one - one),
            6 => Run(all - all),
            7 => Run((one + two) + (two + one) - (two + one)),
            8 => Run(null + one + null),
            9 => Run(one - (Action)null),
            10 => Run(((Action)null) - one),
            _ => Run(all - three - two - one),
        };
    }

    public static int Compound(int count)
    {
        Action action = null;
        for (int index = 0; index < count; index++)
        {
            action += index % 2 == 0 ? One : Two;
        }

        action -= One;
        action += () => Log.Add(7);
        return Run(action);
    }

    // The last delegate's result is the combination's.
    public static int Results(int value)
    {
        Func<int, int> function = x => x + 1;
        function += x => x * 10;
        Scorer scorer = Unit.Twice;
        scorer += new Unit { Id = 3 }.Score;
        return function(value) * 1000 + scorer(value);
    }

    public static int Equality(int which)
    {
        var unit = new Unit { Id = 1 };
        var elite = new Elite { Id = 2 };
        Unit asUnit = elite;
        Action one = One;
        Action alsoOne = One;
        Func<int, int> score = unit.Score;
        Func<int, int> sameScore = unit.Score;
        Func<int, int> otherScore = new Unit { Id = 1 }.Score;
        Func<int, int> eliteScore = elite.Score;
        Func<int, int> viaBase = asUnit.Score;
        Func<int, int> lambda = x => x;
        Func<int, int> lambdaAgain = lambda;
        int bits = 0;
        bits |= one == alsoOne ? 1 : 0;
        bits |= score == sameScore ? 2 : 0;
        bits |= score == otherScore ? 4 : 0;
        bits |= eliteScore == viaBase ? 8 : 0;
        bits |= lambda == lambdaAgain ? 16 : 0;
        bits |= one.Equals(alsoOne) ? 32 : 0;
        bits |= one.Equals((object)(Action)Two) ? 64 : 0;
        bits |= (one + one) == (alsoOne + alsoOne) ? 128 : 0;
        bits |= (one + one) != alsoOne ? 256 : 0;
        bits |= one.GetHashCode() == alsoOne.GetHashCode() ? 512 : 0;
        bits |= score.GetHashCode() == sameScore.GetHashCode() ? 1024 : 0;
        bits |= one != null ? 2048 : 0;
        bits |= ((Action)null) == null ? 4096 : 0;
        return bits;
    }

    // Two delegate types of one signature are different types.
    public static int Types(int value)
    {
        Scorer scorer = Unit.Twice;
        Func<int, int> function = Unit.Twice;
        object boxed = scorer;
        return (boxed.Equals(function) ? 1 : 0) + (boxed.Equals(scorer) ? 2 : 0) + scorer(value) * 10;
    }

    public static int Names(int which)
    {
        object value = which switch
        {
            0 => (Action)One,
            1 => (Func<int, int>)(x => x),
            2 => (Scorer)Unit.Twice,
            3 => (Action)One + Two,
            4 => (Func<string, bool>)string.IsNullOrEmpty,
            _ => (Notify)(x => { }),
        };
        string text = value.ToString();
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = digest * 31 + c;
        }

        return digest;
    }

    public static int Keys(int value)
    {
        Action one = One;
        Action two = Two;
        var counts = new Dictionary<Action, int>();
        counts[one] = 1;
        counts[(Action)One] = 5;
        counts[two] = value;
        var list = new List<Action> { one, two, one + two };
        return counts.Count * 1000 + counts[one] * 100 + list.IndexOf(one + two) * 10 + (list.Contains(Three) ? 1 : 0);
    }

    public static int Events(int value)
    {
        Log.Value = 0;
        var button = new Button();
        var unit = new Unit { Id = 4 };
        Action handler = One;
        button.Clicked += handler;
        button.Clicked += Two;
        button.Clicked += () => Log.Add(value % 10);
        button.Click();
        button.Clicked -= handler;
        button.Click();
        button.Changed += unit.Note;
        button.Changed += x => Log.Add(x % 10);
        button.Change(value);
        button.Changed -= unit.Note;
        button.Change(value + 1);
        button.Custom += unit.Note;
        button.Change(3);
        button.Custom -= unit.Note;
        button.Change(5);
        return Log.Value;
    }

    public static int StaticEvents(int value)
    {
        Log.Value = 0;
        Button.ClearGlobal();
        Button.Global += One;
        Button.Global += Three;
        Button.RaiseGlobal();
        Button.Global -= One;
        Button.RaiseGlobal();
        Button.ClearGlobal();
        Button.RaiseGlobal();
        return Log.Value * 10 + value;
    }

    public static int Emptied(int value)
    {
        var button = new Button();
        Action handler = One;
        button.Clicked += handler;
        button.Clicked -= handler;
        return (button.HasClicked ? 1 : 0) + value;
    }

    public static int ArrayHashes(int length)
    {
        var first = new int[length];
        var second = new string[length];
        object boxed = first;
        var set = new HashSet<int[]> { first, first, new int[length] };
        return (first.GetHashCode() == first.GetHashCode() ? 1 : 0) + (boxed.GetHashCode() == first.GetHashCode() ? 2 : 0)
            + (second.Equals(second) ? 4 : 0) + set.Count * 10;
    }
}
