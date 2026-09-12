// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

public interface IScorer
{
    int Score(int value);
}

public interface INamed
{
    int Name { get; }
}

public interface IEntity : INamed
{
    int Health { get; set; }

    int Update(int step);
}

public class Actor : IEntity
{
    public int Name => 1;

    public int Health { get; set; }

    public virtual int Update(int step) => step;
}

// Implements IEntity through Actor, with an override, and IScorer
// explicitly.
public sealed class Player : Actor, IScorer
{
    public override int Update(int step) => step * 2;

    int IScorer.Score(int value) => value + 100;
}

// A sealed class with no base is polymorphic once it implements an interface.
public sealed class Rock : IScorer
{
    public int Score(int value) => -value;
}

// An abstract class implements the interface with an abstract method.
public abstract class Scored : IScorer
{
    public abstract int Score(int value);
}

public sealed class Doubler : Scored
{
    public override int Score(int value) => value * 2;
}

public sealed class ScorerHolder
{
    public IScorer Scorer;
}

// A class implementing nothing, and a subclass that adds an interface.
public class Marker
{
}

public sealed class MarkedScorer : Marker, IScorer
{
    public int Score(int value) => value;
}

public static class Interfaces
{
    private static IScorer Scorer(int kind) => kind switch
    {
        0 => new Player(),
        1 => new Rock(),
        2 => new Doubler(),
        _ => null,
    };

    private static int Apply(IScorer scorer, int value) => scorer.Score(value);

    public static int Score(int kind, int value) => Scorer(kind).Score(value);

    public static int Entities()
    {
        IEntity[] entities = { new Actor(), new Player() };
        int total = 0;
        foreach (IEntity entity in entities)
        {
            entity.Health = 5;
            entity.Health += 1;
            total = total * 1000 + entity.Update(3) * 10 + entity.Health + entity.Name;
        }

        return total;
    }

    public static int BaseInterface()
    {
        INamed named = new Player();
        return named.Name;
    }

    public static int Is(int kind)
    {
        IScorer scorer = Scorer(kind);
        return (scorer is Player ? 1 : 0) + (scorer is INamed ? 10 : 0) + (scorer is IEntity entity ? 100 + entity.Name : 0);
    }

    public static int As(int kind)
    {
        var named = Scorer(kind) as INamed;
        return named == null ? -1 : named.Name;
    }

    public static int CastToInterface(int kind) => ((IEntity)Scorer(kind)).Update(4);

    public static int CastToClass(int kind) => ((Rock)Scorer(kind)).Score(1);

    public static int Switch(int kind) => Scorer(kind) switch
    {
        IEntity entity => entity.Update(1),
        Rock rock => rock.Score(7),
        null => -1,
        _ => 0,
    };

    public static int Field()
    {
        var holder = new ScorerHolder { Scorer = new Doubler() };
        return holder.Scorer.Score(21);
    }

    public static int Parameter(int value) => Apply(new Rock(), value) + Apply(new Doubler(), value);

    public static int Identity()
    {
        IScorer scorer = new Rock();
        IScorer same = scorer;
        Rock rock = (Rock)scorer;
        return (scorer == same ? 1 : 0) + (rock == scorer ? 10 : 0) + (scorer != Scorer(1) ? 100 : 0);
    }

    public static int Unimplemented(int kind)
    {
        Marker marker = kind == 0 ? new Marker() : new MarkedScorer();
        return marker is IScorer scorer ? scorer.Score(kind) : -1;
    }

    public static int ClassReceiver()
    {
        var player = new Player();
        IScorer scorer = player;
        return player.Update(5) * 1000 + scorer.Score(1);
    }
}
