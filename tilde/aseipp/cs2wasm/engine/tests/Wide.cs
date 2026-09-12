// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A Kiln program of 133 components, over the Kiln library tests/plugin:
// 120 of its own (Bits.C000 to C119, every fourth a tag) take ids 0 to 119,
// the plugin's three (Spin, Stopped, Wheel) 120 to 122, and ten more of its
// own (Zone.Z00 to Z09, the odd ones tags) 123 to 132, so an entity's
// components are three words (the first word's top bit marks it alive):
// the plugin's components are all past the first word, and C062 is the
// first word's last, C063 the second word's first and Z04 the third's.
// Its systems and queries mix components of all three words, required and
// excluded. Model plays random spawns, adds, removes and despawns, some of
// them deferred inside a query, over a plain model of each entity's
// components, and counts where the world and its systems disagree with the
// model; tests/engine.mjs expects no disagreement, and compares every
// check with the CLR's.
namespace Kiln.Tests.Bits
{
[Component] public partial struct C000 { public int Value; }
[Component] public partial struct C001 { public int Value; }
[Component] public partial struct C002 { public int Value; }
[Component] public partial struct C003 { }
[Component] public partial struct C004 { public int Value; }
[Component] public partial struct C005 { public int Value; }
[Component] public partial struct C006 { public int Value; }
[Component] public partial struct C007 { }
[Component] public partial struct C008 { public int Value; }
[Component] public partial struct C009 { public int Value; }
[Component] public partial struct C010 { public int Value; }
[Component] public partial struct C011 { }
[Component] public partial struct C012 { public int Value; }
[Component] public partial struct C013 { public int Value; }
[Component] public partial struct C014 { public int Value; }
[Component] public partial struct C015 { }
[Component] public partial struct C016 { public int Value; }
[Component] public partial struct C017 { public int Value; }
[Component] public partial struct C018 { public int Value; }
[Component] public partial struct C019 { }
[Component] public partial struct C020 { public int Value; }
[Component] public partial struct C021 { public int Value; }
[Component] public partial struct C022 { public int Value; }
[Component] public partial struct C023 { }
[Component] public partial struct C024 { public int Value; }
[Component] public partial struct C025 { public int Value; }
[Component] public partial struct C026 { public int Value; }
[Component] public partial struct C027 { }
[Component] public partial struct C028 { public int Value; }
[Component] public partial struct C029 { public int Value; }
[Component] public partial struct C030 { public int Value; }
[Component] public partial struct C031 { }
[Component] public partial struct C032 { public int Value; }
[Component] public partial struct C033 { public int Value; }
[Component] public partial struct C034 { public int Value; }
[Component] public partial struct C035 { }
[Component] public partial struct C036 { public int Value; }
[Component] public partial struct C037 { public int Value; }
[Component] public partial struct C038 { public int Value; }
[Component] public partial struct C039 { }
[Component] public partial struct C040 { public int Value; }
[Component] public partial struct C041 { public int Value; }
[Component] public partial struct C042 { public int Value; }
[Component] public partial struct C043 { }
[Component] public partial struct C044 { public int Value; }
[Component] public partial struct C045 { public int Value; }
[Component] public partial struct C046 { public int Value; }
[Component] public partial struct C047 { }
[Component] public partial struct C048 { public int Value; }
[Component] public partial struct C049 { public int Value; }
[Component] public partial struct C050 { public int Value; }
[Component] public partial struct C051 { }
[Component] public partial struct C052 { public int Value; }
[Component] public partial struct C053 { public int Value; }
[Component] public partial struct C054 { public int Value; }
[Component] public partial struct C055 { }
[Component] public partial struct C056 { public int Value; }
[Component] public partial struct C057 { public int Value; }
[Component] public partial struct C058 { public int Value; }
[Component] public partial struct C059 { }
[Component] public partial struct C060 { public int Value; }
[Component] public partial struct C061 { public int Value; }
[Component] public partial struct C062 { public int Value; }
[Component] public partial struct C063 { }
[Component] public partial struct C064 { public int Value; }
[Component] public partial struct C065 { public int Value; }
[Component] public partial struct C066 { public int Value; }
[Component] public partial struct C067 { }
[Component] public partial struct C068 { public int Value; }
[Component] public partial struct C069 { public int Value; }
[Component] public partial struct C070 { public int Value; }
[Component] public partial struct C071 { }
[Component] public partial struct C072 { public int Value; }
[Component] public partial struct C073 { public int Value; }
[Component] public partial struct C074 { public int Value; }
[Component] public partial struct C075 { }
[Component] public partial struct C076 { public int Value; }
[Component] public partial struct C077 { public int Value; }
[Component] public partial struct C078 { public int Value; }
[Component] public partial struct C079 { }
[Component] public partial struct C080 { public int Value; }
[Component] public partial struct C081 { public int Value; }
[Component] public partial struct C082 { public int Value; }
[Component] public partial struct C083 { }
[Component] public partial struct C084 { public int Value; }
[Component] public partial struct C085 { public int Value; }
[Component] public partial struct C086 { public int Value; }
[Component] public partial struct C087 { }
[Component] public partial struct C088 { public int Value; }
[Component] public partial struct C089 { public int Value; }
[Component] public partial struct C090 { public int Value; }
[Component] public partial struct C091 { }
[Component] public partial struct C092 { public int Value; }
[Component] public partial struct C093 { public int Value; }
[Component] public partial struct C094 { public int Value; }
[Component] public partial struct C095 { }
[Component] public partial struct C096 { public int Value; }
[Component] public partial struct C097 { public int Value; }
[Component] public partial struct C098 { public int Value; }
[Component] public partial struct C099 { }
[Component] public partial struct C100 { public int Value; }
[Component] public partial struct C101 { public int Value; }
[Component] public partial struct C102 { public int Value; }
[Component] public partial struct C103 { }
[Component] public partial struct C104 { public int Value; }
[Component] public partial struct C105 { public int Value; }
[Component] public partial struct C106 { public int Value; }
[Component] public partial struct C107 { }
[Component] public partial struct C108 { public int Value; }
[Component] public partial struct C109 { public int Value; }
[Component] public partial struct C110 { public int Value; }
[Component] public partial struct C111 { }
[Component] public partial struct C112 { public int Value; }
[Component] public partial struct C113 { public int Value; }
[Component] public partial struct C114 { public int Value; }
[Component] public partial struct C115 { }
[Component] public partial struct C116 { public int Value; }
[Component] public partial struct C117 { public int Value; }
[Component] public partial struct C118 { public int Value; }
[Component] public partial struct C119 { }
}

namespace Kiln.Tests.Zone
{
[Component] public partial struct Z00 { public int Value; }
[Component] public partial struct Z01 { }
[Component] public partial struct Z02 { public int Value; }
[Component] public partial struct Z03 { }
[Component] public partial struct Z04 { public int Value; }
[Component] public partial struct Z05 { }
[Component] public partial struct Z06 { public int Value; }
[Component] public partial struct Z07 { }
[Component] public partial struct Z08 { public int Value; }
[Component] public partial struct Z09 { }
}

namespace Kiln.Tests
{
    using System.Collections.Generic;
    using System.Linq;
    using Kiln;
    using Kiln.Tests.Bits;
    using Kiln.Tests.Plugin;
    using Kiln.Tests.Zone;

    // The entities each system of the program ran over, by system.
    [Resource]
    internal sealed class Tally
    {
        public readonly Dictionary<string, HashSet<Entity>> Seen = new Dictionary<string, HashSet<Entity>>();

        public readonly List<string> Lines = new List<string>();

        public void See(string system, Entity entity)
        {
            if (!Seen.TryGetValue(system, out var set))
            {
                Seen[system] = set = new HashSet<Entity>();
            }

            set.Add(entity);
        }

        public HashSet<Entity> Of(string system) => Seen.TryGetValue(system, out var set) ? set : new HashSet<Entity>();
    }

    internal static partial class Cross
    {
        // Required in all three words, excluded in the second and third.
        [System(Phase.Update)]
        [Without<C063>]
        [Without<Z09>]
        static void Carry(Entity self, ref C000 low, in C070 middle, in Z04 high, Tally tally)
        {
            low.Value += middle.Value + high.Value;
            tally.See("carry", self);
        }

        // Tags alone: every slot, a tag required in the second word and
        // one excluded in the first.
        [System(Phase.Update)]
        [With<C119>]
        [Without<C003>]
        static void Mark(Entity self, Tally tally) => tally.See("mark", self);

        // No component: every living entity, by the first word's alive bit.
        [System(Phase.Update)]
        static void Census(Entity self, Tally tally) => tally.See("census", self);

        // The third word required (a tag too), the plugin's tag excluded in
        // the second.
        [System(Phase.Update)]
        [With<Z05>]
        [Without<Stopped>]
        static void Rise(Entity self, ref Z08 rising, Tally tally)
        {
            rising.Value++;
            tally.See("rise", self);
        }
    }

    public static class Wide
    {
        // The components the model plays with, in id order: of the first
        // word (C000, C003, C062), the second (C063 to Wheel) and the third
        // (Z04 to Z09); every other one is a tag.
        private static readonly string[] Names =
        {
            "C000", "C003", "C062", "C063", "C070", "C119", "Spin", "Stopped", "Wheel", "Z04", "Z05", "Z06", "Z08", "Z09",
        };

        static World NewWorld()
        {
            _ = Gameplay.Frames.Count;
            return World.Create();
        }

        // 1 when the world has 133 components in three words, and their ids
        // and bits are where the program's order puts them.
        public static int Shape()
        {
            var world = NewWorld();
            bool ids = Storage<C000>.Id == 0 && Storage<C062>.Id == 62 && Storage<C063>.Id == 63 && Storage<C119>.Id == 119
                       && Storage<Spin>.Id == 120 && Storage<Stopped>.Id == 121 && Storage<Wheel>.Id == 122
                       && Storage<Z00>.Id == 123 && Storage<Z04>.Id == 127 && Storage<Z09>.Id == 132;
            bool stores = world.Store<C062>().Word == 0 && world.Store<C062>().Bit == 1UL << 62
                          && world.Store<C070>().Word == 1 && world.Store<C070>().Bit == 1UL << 7
                          && world.Store<Wheel>().Word == 1 && world.Store<Wheel>().Bit == 1UL << 59
                          && world.Store<Z04>().Word == 2 && world.Store<Z04>().Bit == 1UL
                          && world.Store<Z08>().Word == 2 && world.Store<Z08>().Bit == 1UL << 4;
            return (world.Schedule.ComponentNames.Count == 133 && world.MaskWords == 3 ? 1 : 0) + (ids ? 10 : 0) + (stores ? 100 : 0);
        }

        // The schedule the generator wrote, as names in run order.
        public static int ScheduleHash()
        {
            var lines = new List<string>();
            foreach (var system in NewWorld().Systems)
            {
                lines.Add(system.Phase + " " + system.Name + " r=" + system.Reads + " w=" + system.Writes);
            }

            return Hash(lines);
        }

        // A component, a tag and the plugin's components in each word, and
        // the names Describe lists.
        public static int Describe()
        {
            var world = NewWorld();
            var entity = world.Spawn(new C000 { Value = 1 });
            world.Add(entity, new C062 { Value = 2 });
            world.Add(entity, new C063());
            world.Add(entity, new Spin { Speed = 3 });
            world.Add(entity, new Z04 { Value = 4 });
            world.Add(entity, new Z09());
            world.Remove<C062>(entity);
            var lines = new List<string> { world.Describe(entity) };
            lines.Add(world.Get<C000>(entity).Value + " " + world.Get<Spin>(entity).Speed + " " + world.Get<Z04>(entity).Value
                      + " " + world.Has<C062>(entity) + " " + world.Has<Z09>(entity) + " " + world.Has<Z05>(entity));
            world.Despawn(entity);
            var reused = world.Spawn();
            lines.Add(world.Describe(reused) + " " + world.Count<Z04>() + " " + world.Count<Z09>() + " " + world.Count<Spin>());
            return Hash(lines) == Hash(new List<string>
            {
                "#0.1 [C000, C063, Spin, Z04, Z09]",
                "1 3 4 False True False",
                "#0.2 [] 0 0 0",
            }) ? 1 : 0;
        }

        // Each system's and query's words, required and excluded, one entity
        // at a time: 1 when each ran over exactly the entities it must.
        public static int Queries()
        {
            var world = NewWorld();
            var carried = world.Spawn(new C000()).With(new C070()).With(new Z04()).Entity;
            var lowExcluded = world.Spawn(new C000()).With(new C070()).With(new Z04()).With(new C063()).Entity;
            world.Spawn(new C000()).With(new C070()).With(new Z04()).With(new Z09());
            world.Spawn(new C000()).With(new C070());
            var marked = world.Spawn(new C119()).Entity;
            world.Spawn(new C119()).With(new C003());
            var risen = world.Spawn(new Z05()).With(new Z08()).Entity;
            world.Spawn(new Z05()).With(new Z08()).With(new Stopped());
            var lone = world.Spawn(new Z08()).Entity;
            world.Spawn(new Spin { Speed = 5 }).With(new Wheel { Size = 100 });
            world.Spawn(new Spin { Speed = 7 }).With(new Wheel { Size = 100 }).With(new Stopped());
            world.Tick();
            var tally = world.Tally;
            bool systems = Same(tally.Of("carry"), new List<Entity> { carried }) == 0
                           && Same(tally.Of("mark"), new List<Entity> { marked }) == 0
                           && Same(tally.Of("rise"), new List<Entity> { risen }) == 0
                           && tally.Of("census").Count == 11
                           && world.Odometer.Total == 5
                           && world.Get<Z08>(risen).Value == 1 && world.Get<Z08>(lone).Value == 0;
            var free = new List<Entity>();
            foreach (var entity in world.Query<Z08>().Without<Stopped>())
            {
                free.Add(entity);
            }

            var low = new List<Entity>();
            foreach (var entity in world.Query<C000, Z04>().Without<Z09>())
            {
                low.Add(entity);
            }

            bool queries = Same(free, new List<Entity> { risen, lone }) == 0 && Same(low, new List<Entity> { carried, lowExcluded }) == 0;
            return (systems ? 1 : 0) + (queries ? 10 : 0);
        }

        // How far the world and its systems stray from the model over a
        // number of ticks of random changes (0 when they agree).
        public static int Model(int seed, int ticks) => Play(seed, ticks).Mismatches;

        // A hash of what the systems saw and the world holds, for the CLR's.
        public static int ModelHash(int seed, int ticks) => Play(seed, ticks).Hash;

        private sealed class Mirror
        {
            public readonly Dictionary<Entity, SortedSet<int>> Has = new Dictionary<Entity, SortedSet<int>>();
            public readonly Dictionary<Entity, int> Speeds = new Dictionary<Entity, int>();
            public readonly List<Entity> Dead = new List<Entity>();

            public bool Holds(Entity entity, int component) => Has.TryGetValue(entity, out var set) && set.Contains(component);

            public IEnumerable<Entity> Matching(int[] required, int[] excluded) =>
                Has.Keys.Where(entity => required.All(component => Holds(entity, component)) && !excluded.Any(component => Holds(entity, component)));
        }

        private static (int Mismatches, int Hash) Play(int seed, int ticks)
        {
            var world = NewWorld();
            var model = new Mirror();
            var rng = new Rng((ulong)seed);
            var lines = new List<string>();
            int mismatches = 0;
            for (int tick = 0; tick < ticks; tick++)
            {
                // Changes at once: spawns, adds, removes and despawns.
                for (int change = 0; change < 12; change++)
                {
                    Change(world, model, rng, lines, deferred: null);
                }

                // Changes inside a query, deferred until it ends.
                if (tick % 3 == 2)
                {
                    var deferred = new List<(int Kind, Entity Entity, int Component, int Value)>();
                    foreach (var entity in world.Query<C070>())
                    {
                        Change(world, model, rng, lines, deferred, entity);
                    }

                    foreach (var (kind, entity, component, value) in deferred)
                    {
                        Apply(model, kind, entity, component, value);
                    }
                }

                mismatches += Check(world, model, lines, describe: tick % 4 == 3);
                world.Tally.Seen.Clear();
                int before = world.Odometer.Total;
                var carry = model.Matching(new[] { 0, 4, 9 }, new[] { 3, 13 }).ToList();
                var mark = model.Matching(new[] { 5 }, new[] { 1 }).ToList();
                var rise = model.Matching(new[] { 10, 12 }, new[] { 7 }).ToList();
                int turned = model.Matching(new[] { 6, 8 }, new[] { 7 }).Sum(entity => model.Speeds[entity]);
                world.Tick();
                var tally = world.Tally;
                mismatches += Same(tally.Of("carry"), carry) + Same(tally.Of("mark"), mark) + Same(tally.Of("rise"), rise)
                              + Same(tally.Of("census"), model.Has.Keys.ToList());
                mismatches += world.Odometer.Total - before == turned ? 0 : 1;
                lines.Add("tick " + tick + " " + carry.Count + " " + mark.Count + " " + rise.Count + " " + turned);
            }

            foreach (var entity in model.Has.Keys.OrderBy(entity => entity.Index))
            {
                lines.Add(world.Describe(entity) + (world.Has<C000>(entity) ? " " + world.Get<C000>(entity).Value : "")
                          + (world.Has<Z08>(entity) ? " " + world.Get<Z08>(entity).Value : ""));
            }

            return (mismatches, Hash(lines));
        }

        // A random change; inside a query (deferred not null), of the
        // query's entity, recorded to be applied to the model when the
        // query ends, as the world applies it.
        private static void Change(World world, Mirror model, Rng rng, List<string> lines, List<(int, Entity, int, int)> deferred, Entity current = default)
        {
            var living = model.Has.Keys.ToList();
            int roll = rng.Range(0, 20);
            if (roll < 4 || living.Count == 0)
            {
                var spawned = world.Spawn();
                model.Has[spawned] = new SortedSet<int>();
                lines.Add("spawn " + spawned);
                if (deferred is null)
                {
                    return;
                }

                // Spawned at once inside the query; what is added to it waits.
                living = new List<Entity> { spawned };
                current = spawned;
            }

            var entity = deferred is not null ? current : living[rng.Range(0, living.Count)];
            int component = rng.Range(0, Names.Length);
            int value = rng.Range(1, 100);
            int kind = roll < 13 ? 0 : roll < 18 ? 1 : 2;
            if (deferred is not null)
            {
                // What the world checks when it is asked, before it defers.
                if (kind == 1 && !model.Holds(entity, component))
                {
                    return;
                }

                deferred.Add((kind, entity, component, value));
            }
            else
            {
                Apply(model, kind, entity, component, value);
            }

            lines.Add((kind == 0 ? "add " : kind == 1 ? "remove " : "despawn ") + entity + " " + Names[component]);
            switch (kind)
            {
                case 0:
                    Add(world, entity, component, value);
                    break;
                case 1:
                    Remove(world, entity, component);
                    break;
                default:
                    world.Despawn(entity);
                    break;
            }
        }

        // A change to the model, as the world makes it when it is applied.
        private static void Apply(Mirror model, int kind, Entity entity, int component, int value)
        {
            if (!model.Has.TryGetValue(entity, out var set))
            {
                return;
            }

            switch (kind)
            {
                case 0:
                    set.Add(component);
                    if (component == 6)
                    {
                        model.Speeds[entity] = value;
                    }

                    break;
                case 1:
                    set.Remove(component);
                    break;
                default:
                    model.Has.Remove(entity);
                    model.Dead.Add(entity);
                    break;
            }
        }

        // Where the world disagrees with the model: its entities, their
        // components (and every few ticks their descriptions, which walk
        // every id), their counts and the queries over them.
        private static int Check(World world, Mirror model, List<string> lines, bool describe)
        {
            int mismatches = 0;
            foreach (var (entity, set) in model.Has)
            {
                mismatches += world.IsAlive(entity) ? 0 : 1;
                for (int component = 0; component < Names.Length; component++)
                {
                    mismatches += Has(world, entity, component) == set.Contains(component) ? 0 : 1;
                }

                if (describe)
                {
                    string expected = entity + " [" + string.Join(", ", set.Select(component => Names[component])) + "]";
                    mismatches += world.Describe(entity) == expected ? 0 : 1;
                }
            }

            foreach (var entity in model.Dead)
            {
                mismatches += world.IsAlive(entity) || world.Has<Z04>(entity) || world.Has<C000>(entity) ? 1 : 0;
            }

            mismatches += world.EntityCount == model.Has.Count ? 0 : 1;
            for (int component = 0; component < Names.Length; component++)
            {
                mismatches += Count(world, component) == model.Has.Values.Count(set => set.Contains(component)) ? 0 : 1;
            }

            mismatches += Same(world.Query<C000, Z04>().Without<C063>().ToList(), model.Matching(new[] { 0, 9 }, new[] { 3 }).ToList());
            mismatches += Same(world.Query<C119>().ToList(), model.Matching(new[] { 5 }, new int[0]).ToList());
            mismatches += Same(world.Query<Z08, Spin>().Without<Z09>().Without<C003>().ToList(), model.Matching(new[] { 12, 6 }, new[] { 13, 1 }).ToList());
            mismatches += Same(world.Query<C062, Wheel, Z06>().ToList(), model.Matching(new[] { 2, 8, 11 }, new int[0]).ToList());
            mismatches += Same(world.Query<C003>().Without<Stopped>().ToList(), model.Matching(new[] { 1 }, new[] { 7 }).ToList());
            lines.Add("entities " + world.EntityCount + " " + world.Count<Z04>() + " " + world.Count<C063>());
            return mismatches;
        }

        private static int Same(IEnumerable<Entity> actual, List<Entity> expected) =>
            new HashSet<Entity>(actual).SetEquals(expected) && actual.Count() == expected.Count ? 0 : 1;

        private static void Add(World world, Entity entity, int component, int value)
        {
            switch (component)
            {
                case 0: world.Add(entity, new C000 { Value = value }); break;
                case 1: world.Add(entity, new C003()); break;
                case 2: world.Add(entity, new C062 { Value = value }); break;
                case 3: world.Add(entity, new C063()); break;
                case 4: world.Add(entity, new C070 { Value = value }); break;
                case 5: world.Add(entity, new C119()); break;
                case 6: world.Add(entity, new Spin { Speed = value }); break;
                case 7: world.Add(entity, new Stopped()); break;
                case 8: world.Add(entity, new Wheel { Size = value }); break;
                case 9: world.Add(entity, new Z04 { Value = value }); break;
                case 10: world.Add(entity, new Z05()); break;
                case 11: world.Add(entity, new Z06 { Value = value }); break;
                case 12: world.Add(entity, new Z08 { Value = value }); break;
                default: world.Add(entity, new Z09()); break;
            }
        }

        private static void Remove(World world, Entity entity, int component)
        {
            switch (component)
            {
                case 0: world.Remove<C000>(entity); break;
                case 1: world.Remove<C003>(entity); break;
                case 2: world.Remove<C062>(entity); break;
                case 3: world.Remove<C063>(entity); break;
                case 4: world.Remove<C070>(entity); break;
                case 5: world.Remove<C119>(entity); break;
                case 6: world.Remove<Spin>(entity); break;
                case 7: world.Remove<Stopped>(entity); break;
                case 8: world.Remove<Wheel>(entity); break;
                case 9: world.Remove<Z04>(entity); break;
                case 10: world.Remove<Z05>(entity); break;
                case 11: world.Remove<Z06>(entity); break;
                case 12: world.Remove<Z08>(entity); break;
                default: world.Remove<Z09>(entity); break;
            }
        }

        private static bool Has(World world, Entity entity, int component) => component switch
        {
            0 => world.Has<C000>(entity),
            1 => world.Has<C003>(entity),
            2 => world.Has<C062>(entity),
            3 => world.Has<C063>(entity),
            4 => world.Has<C070>(entity),
            5 => world.Has<C119>(entity),
            6 => world.Has<Spin>(entity),
            7 => world.Has<Stopped>(entity),
            8 => world.Has<Wheel>(entity),
            9 => world.Has<Z04>(entity),
            10 => world.Has<Z05>(entity),
            11 => world.Has<Z06>(entity),
            12 => world.Has<Z08>(entity),
            _ => world.Has<Z09>(entity),
        };

        private static int Count(World world, int component) => component switch
        {
            0 => world.Count<C000>(),
            1 => world.Count<C003>(),
            2 => world.Count<C062>(),
            3 => world.Count<C063>(),
            4 => world.Count<C070>(),
            5 => world.Count<C119>(),
            6 => world.Count<Spin>(),
            7 => world.Count<Stopped>(),
            8 => world.Count<Wheel>(),
            9 => world.Count<Z04>(),
            10 => world.Count<Z05>(),
            11 => world.Count<Z06>(),
            12 => world.Count<Z08>(),
            _ => world.Count<Z09>(),
        };

        private static int Hash(List<string> lines)
        {
            uint hash = 2166136261;
            foreach (string line in lines)
            {
                foreach (char character in line)
                {
                    hash = (hash ^ character) * 16777619;
                }

                hash = (hash ^ '\n') * 16777619;
            }

            return unchecked((int)hash);
        }
    }
}
