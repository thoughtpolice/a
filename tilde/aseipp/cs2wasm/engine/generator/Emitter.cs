// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln.Generator;

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;

// Writes what the pipeline read, after checking it: for a program, its
// schedule (Kiln.Generated.GameSchedule) over its own declarations and
// those of the Kiln libraries it references, and for a program or a Kiln
// library, what its own declarations need. What fails a check is reported
// and left out, and the rest is still written, so one mistake is one
// diagnostic rather than a cascade of missing members.
internal static class Emitter
{
    private const string World = "global::Kiln.World";
    private const string Entity = "global::Kiln.Entity";
    private const string ScheduleClass = "global::Kiln.Generated.GameSchedule";
    private const ulong AliveBit = 1UL << 63;

    private static readonly string[] Phases = ["Startup", "PreUpdate", "Update", "PostUpdate", "Render"];

    // World's own members (and the program's Create), which a resource's
    // world property must not be named: a member of World hides it.
    private static readonly HashSet<string> Reserved =
    [
        "Add", "BeginIteration", "Clear", "Count", "Create", "Describe", "Despawn", "Dispose", "EndIteration",
        "EntityAt", "EntityCount", "Equals", "Get", "GetHashCode", "GetType", "Has", "Index", "IsAlive", "IsIterating",
        "BitOf", "MaskWords", "Masks", "Query", "Reader", "Remove", "Render", "Resource", "Run", "Schedule", "Scheduler", "Send", "SetResource",
        "SlotCount", "Spawn", "Startup", "Store", "Systems", "Tick", "Ticks", "ToString", "TryGet", "WordsFor", "Writer",
    ];

    public static void Emit(
        SourceProductionContext output,
        Target target,
        ImmutableArray<ComponentModel> components,
        ImmutableArray<ResourceModel> resources,
        ImmutableArray<EventModel> events,
        ImmutableArray<BundleModel> bundles,
        ImmutableArray<SystemModel> systems,
        LibraryModel libraries)
    {
        bool program = !target.IsLibrary;
        var world = new WorldModel();

        foreach (var component in components.Concat(libraries.Components).OrderBy(component => component.Type, System.StringComparer.Ordinal))
        {
            if (!component.Origin.IsLibrary && (!component.IsStruct || !component.Shell.Partial || component.Shell.Generic))
            {
                output.ReportDiagnostic(Diagnostic.Create(
                    Diagnostics.ComponentShape,
                    component.Location,
                    component.Name,
                    component.Shell.Headers.Count > 1 ? ", in partial types" : ""));
                world.Rejected.Add(component.Type);
                continue;
            }

            if (Refused(output, target, "Component", component.Name, component.Origin, component.Location))
            {
                world.Rejected.Add(component.Type);
                continue;
            }

            world.Components.Add(component);
        }

        for (int id = 0; id < world.Components.Count; id++)
        {
            world.ComponentIds[world.Components[id].Type] = id;
        }

        // The libraries' resources first: a program's own resource is the
        // one to rename when their world properties would clash.
        foreach (var resource in resources.Concat(libraries.Resources)
                     .OrderBy(resource => resource.Origin.IsLibrary ? 0 : 1)
                     .ThenBy(resource => resource.Type, System.StringComparer.Ordinal))
        {
            if (!resource.IsClass)
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.DeclarationShape, resource.Location, resource.Name, "a non-generic class to be a resource"));
                world.Rejected.Add(resource.Type);
            }
            else if (!resource.Origin.IsLibrary && (Reserved.Contains(resource.Name) || world.Resources.Any(other => other.Name == resource.Name)))
            {
                output.ReportDiagnostic(Diagnostic.Create(
                    Diagnostics.DeclarationShape, resource.Location, resource.Name, "named unlike the World's members and every other resource, since it is the World's property of that name"));
                world.Rejected.Add(resource.Type);
            }
            else if (Refused(output, target, "Resource", resource.Name, resource.Origin, resource.Location))
            {
                world.Rejected.Add(resource.Type);
            }
            else
            {
                world.Resources.Add(resource);
                world.ResourceTypes[resource.Type] = resource;
            }
        }

        world.Resources.Sort((left, right) => System.StringComparer.Ordinal.Compare(left.Type, right.Type));

        foreach (var @event in events.Concat(libraries.Events).OrderBy(@event => @event.Type, System.StringComparer.Ordinal))
        {
            if (!@event.Origin.IsLibrary && (!@event.IsStruct || !@event.Shell.Partial || @event.Shell.Generic))
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.DeclarationShape, @event.Location, @event.Name, "a partial, non-generic struct to be an event"));
                world.Rejected.Add(@event.Type);
                continue;
            }

            if (Refused(output, target, "Event", @event.Name, @event.Origin, @event.Location))
            {
                world.Rejected.Add(@event.Type);
                continue;
            }

            world.EventIds[@event.Type] = world.Events.Count;
            world.Events.Add(@event);
        }

        foreach (var bundle in bundles.Concat(libraries.Bundles).OrderBy(bundle => bundle.Type, System.StringComparer.Ordinal))
        {
            var stray = bundle.Members.FirstOrDefault(member => !world.ComponentIds.ContainsKey(member.Type));
            if (!bundle.IsStruct)
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.DeclarationShape, bundle.Location, bundle.Name, "a record struct to be a bundle"));
            }
            else if (stray.Name is not null)
            {
                output.ReportDiagnostic(Diagnostic.Create(
                    Diagnostics.DeclarationShape, bundle.Location, bundle.Name, "a bundle of components, and its member '" + stray.Name + "' is not one"));
            }
            else if (!Refused(output, target, "Bundle", bundle.Name, bundle.Origin, bundle.Location))
            {
                world.Bundles.Add(bundle);
            }
        }

        // A library's systems are checked where it is compiled and join
        // the schedule of the programs that reference it.
        var plans = new List<SystemPlan>();
        foreach (var system in systems.Concat(program ? libraries.Systems : [])
                     .OrderBy(system => system.Class, System.StringComparer.Ordinal)
                     .ThenBy(system => system.Method, System.StringComparer.Ordinal))
        {
            if (Plan(output, target, world, system, plans.Count) is { } plan)
            {
                plans.Add(plan);
            }
        }

        var ordered = new List<SystemPlan>();
        if (program)
        {
            for (int phase = 0; phase < Phases.Length; phase++)
            {
                ordered.AddRange(Schedule.Order(output, plans, phase));
            }
        }

        output.AddSource("Kiln.World.g.cs", Write(target, world, ordered));
    }

    // Whether a declaration cannot join the schedule because of where it is:
    // a library's (for a program) that it cannot use, or a Kiln library's
    // own that is not public.
    private static bool Refused(SourceProductionContext output, Target target, string kind, string name, Origin origin, Location location)
    {
        if (origin.Problem is null || (!origin.IsLibrary && !target.IsLibrary))
        {
            return false;
        }

        output.ReportDiagnostic(Diagnostic.Create(
            Diagnostics.LibraryDeclaration, location, kind, name, (origin.Kiln ? "the Kiln library " : "the library ") + (origin.Library ?? target.Assembly), origin.Problem));
        return true;
    }

    // Classifies a system's parameters, or reports why it cannot run.
    private static SystemPlan? Plan(SourceProductionContext output, Target target, WorldModel world, SystemModel system, int id)
    {
        bool valid = true;
        if (!target.IsLibrary && !system.Origin.IsLibrary && (!system.Shell.Partial || system.Shell.Generic))
        {
            // A program's system is run from its own class.
            output.ReportDiagnostic(Diagnostic.Create(Diagnostics.SystemClass, system.Location, system.FullName));
            valid = false;
        }

        if (!system.Static || !system.ReturnsVoid || system.Generic)
        {
            output.ReportDiagnostic(Diagnostic.Create(Diagnostics.SystemShape, system.Location, system.FullName));
            valid = false;
        }

        if (Refused(output, target, "System", system.FullName, system.Origin, system.Location))
        {
            valid = false;
        }

        var plan = new SystemPlan(system, id);
        foreach (var parameter in system.Parameters)
        {
            var argument = Classify(output, world, system, parameter, isCondition: false);
            if (argument is null)
            {
                valid = false;
                continue;
            }

            if (argument.Kind == ArgumentKind.Component)
            {
                if (plan.Reads.Contains(argument.Type) || plan.Writes.Contains(argument.Type))
                {
                    output.ReportDiagnostic(Diagnostic.Create(Diagnostics.DuplicateParameter, system.Location, system.FullName, argument.Type));
                    valid = false;
                }

                (argument.Writes ? plan.Writes : plan.Reads).Add(argument.Type);
            }

            plan.Arguments.Add(argument);
        }

        foreach (string type in system.With.Concat(system.Without))
        {
            if (!world.ComponentIds.ContainsKey(type))
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.ParameterType, system.Location, "[With]/[Without]", system.FullName, type));
                valid = false;
            }
        }

        if (system.RunIf is not null)
        {
            if (!system.RunIfValid)
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.RunIf, system.Location, system.RunIf, system.FullName));
                valid = false;
            }
            else
            {
                foreach (var parameter in system.RunIfParameters)
                {
                    var argument = Classify(output, world, system, parameter, isCondition: true);
                    if (argument is null)
                    {
                        valid = false;
                    }
                    else
                    {
                        plan.Condition.Add(argument);
                    }
                }
            }
        }

        return valid ? plan : null;
    }

    private static Argument? Classify(SourceProductionContext output, WorldModel world, SystemModel system, ParameterModel parameter, bool isCondition)
    {
        if (parameter.Type == World)
        {
            return new Argument(ArgumentKind.World, parameter.Type, false);
        }

        if (world.ResourceTypes.ContainsKey(parameter.Type))
        {
            return new Argument(ArgumentKind.Resource, parameter.Type, false);
        }

        if (!isCondition && parameter.Type == Entity && parameter.Passing is Passing.Value or Passing.In)
        {
            return new Argument(ArgumentKind.Entity, parameter.Type, false);
        }

        if (!isCondition && parameter.Generic != "" && world.EventIds.ContainsKey(parameter.Argument))
        {
            return new Argument(parameter.Generic == "EventReader" ? ArgumentKind.Reader : ArgumentKind.Writer, parameter.Argument, false);
        }

        if (!isCondition && world.ComponentIds.TryGetValue(parameter.Type, out int id))
        {
            var component = world.Components[id];
            if (component.IsTag)
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.TagParameter, system.Location, parameter.Name, system.FullName, component.Name));
                return null;
            }

            if (parameter.Passing == Passing.Out)
            {
                output.ReportDiagnostic(Diagnostic.Create(Diagnostics.ParameterKind, system.Location, parameter.Name, system.FullName, "out"));
                return null;
            }

            return new Argument(ArgumentKind.Component, parameter.Type, parameter.Passing == Passing.Ref);
        }

        if (world.Rejected.Contains(parameter.Type) || world.Rejected.Contains(parameter.Argument))
        {
            // Its declaration's error is the one to fix; the system is left
            // out without another.
            return null;
        }

        output.ReportDiagnostic(Diagnostic.Create(
            isCondition ? Diagnostics.RunIf : Diagnostics.ParameterType,
            system.Location,
            isCondition ? system.RunIf! : parameter.Name,
            system.FullName,
            parameter.Type));
        return null;
    }

    // MARK: Writing

    private static string Write(Target target, WorldModel world, List<SystemPlan> ordered)
    {
        var text = new StringBuilder();
        text.AppendLine("// <auto-generated/>");
        text.AppendLine(target.IsLibrary
            ? "// Written by Kiln.Generator.WorldGenerator for this Kiln library's [Component], [Resource],"
              + "\n// [Event] and [Bundle] declarations; the programs referencing it schedule its systems."
            : "// The program's Kiln schedule, written by Kiln.Generator.WorldGenerator from its [Component],"
              + "\n// [Resource], [Event], [Bundle] and [System] declarations and those of its Kiln libraries.");
        text.AppendLine("#nullable disable");
        text.AppendLine();
        if (target.Marks)
        {
            text.AppendLine("[assembly: global::Kiln.Generated.KilnLibrary]");
            text.AppendLine();
        }

        foreach (var component in world.Components.Where(component => !component.Origin.IsLibrary))
        {
            WriteShell(text, component.Shell, " : global::Kiln.IComponent<" + component.Type + ">", _ => { });
        }

        foreach (var @event in world.Events.Where(@event => !@event.Origin.IsLibrary))
        {
            WriteShell(text, @event.Shell, " : global::Kiln.IEvent<" + @event.Type + ">", _ => { });
        }

        WriteExtensions(text, target, world);
        if (target.IsLibrary)
        {
            return text.ToString();
        }

        foreach (var group in ordered.Where(plan => !plan.Model.Origin.IsLibrary).GroupBy(plan => plan.Model.Class))
        {
            var shell = group.First().Model.Shell;
            WriteShell(text, shell, "", body =>
            {
                foreach (var plan in group)
                {
                    WriteRunner(body, world, plan, "internal");
                }
            });
        }

        WriteSchedule(text, world, ordered);
        return text.ToString();
    }

    // The world properties of the declaration's own resources, its
    // bundles' Spawn and Add, and a program's World.Create(), as C# 14
    // extension members of World.
    private static void WriteExtensions(StringBuilder text, Target target, WorldModel world)
    {
        var resources = world.Resources.Where(resource => !resource.Origin.IsLibrary).ToList();
        var bundles = world.Bundles.Where(bundle => !bundle.Origin.IsLibrary).ToList();
        if (target.IsLibrary && resources.Count == 0 && bundles.Count == 0)
        {
            return;
        }

        string name = new string(target.Assembly.Select(character => char.IsLetterOrDigit(character) ? character : '_').ToArray());
        var lines = new List<string>();
        lines.Add("/// <summary>The World's members for " + (target.IsLibrary ? "the Kiln library " + target.Assembly : "the program") + "'s resources and bundles.</summary>");
        lines.Add((target.IsLibrary ? "public" : "internal") + " static class " + name + "WorldExtensions");
        lines.Add("{");
        lines.Add("    extension(" + World + " world)");
        lines.Add("    {");
        foreach (var resource in resources)
        {
            lines.Add("        /// <summary>The world's " + resource.Name + " resource.</summary>");
            lines.Add("        public " + resource.Type + " " + resource.Name);
            lines.Add("        {");
            lines.Add("            get => world.Resource<" + resource.Type + ">();");
            lines.Add("            set => world.SetResource<" + resource.Type + ">(value);");
            lines.Add("        }");
            lines.Add("");
        }

        foreach (var bundle in bundles)
        {
            lines.Add("        /// <summary>A new entity with the components of a " + bundle.Name + ".</summary>");
            lines.Add("        public " + Entity + " Spawn(" + bundle.Type + " bundle)");
            lines.Add("        {");
            lines.Add("            var entity = world.Spawn();");
            lines.Add("            world.Add(entity, bundle);");
            lines.Add("            return entity;");
            lines.Add("        }");
            lines.Add("");
            lines.Add("        /// <summary>Adds the components of a " + bundle.Name + ".</summary>");
            lines.Add("        public void Add(" + Entity + " entity, " + bundle.Type + " bundle)");
            lines.Add("        {");
            foreach (var (member, type) in bundle.Members)
            {
                lines.Add("            world.Add<" + type + ">(entity, bundle." + member + ");");
            }

            lines.Add("        }");
            lines.Add("");
        }

        if (lines[lines.Count - 1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }

        lines.Add("    }");
        if (!target.IsLibrary)
        {
            lines.Add("");
            lines.Add("    extension(" + World + ")");
            lines.Add("    {");
            lines.Add("        /// <summary>A new world, run by the program's schedule.</summary>");
            lines.Add("        public static " + World + " Create() => new " + World + "(new " + ScheduleClass + "());");
            lines.Add("    }");
        }

        lines.Add("}");
        text.AppendLine("namespace Kiln");
        text.AppendLine("{");
        foreach (string line in lines)
        {
            text.AppendLine(line.Length == 0 ? "" : "    " + line);
        }

        text.AppendLine("}");
        text.AppendLine();
    }

    private static void WriteSchedule(StringBuilder text, WorldModel world, List<SystemPlan> ordered)
    {
        var lines = new List<string>();
        lines.Add("/// <summary>The program's schedule: its components, events, resources and systems, and those of its Kiln libraries.</summary>");
        lines.Add("internal sealed class GameSchedule : global::Kiln.Schedule");
        lines.Add("{");
        lines.Add("    private static readonly global::Kiln.SystemInfo[] systems = new global::Kiln.SystemInfo[]");
        lines.Add("    {");
        foreach (var plan in ordered)
        {
            lines.Add("        new global::Kiln.SystemInfo(\"" + plan.Model.FullName + "\", global::Kiln.Phase." + Phases[plan.Model.Phase] + ", "
                      + plan.Model.Order.ToString(CultureInfo.InvariantCulture) + ", \"" + Names(world, plan.Reads) + "\", \"" + Names(world, plan.Writes) + "\"),");
        }

        lines.Add("    };");
        lines.Add("");
        lines.Add("    private static readonly string[] componentNames = new string[] { "
                  + string.Join(", ", world.Components.Select(component => "\"" + component.Name + "\"")) + " };");
        foreach (var plan in ordered)
        {
            for (int index = 0; index < plan.Arguments.Count; index++)
            {
                if (plan.Arguments[index].Kind is ArgumentKind.Reader or ArgumentKind.Writer)
                {
                    string kind = plan.Arguments[index].Kind == ArgumentKind.Reader ? "EventReader" : "EventWriter";
                    lines.Add("    internal global::Kiln." + kind + "<" + plan.Arguments[index].Type + "> " + ChannelField(plan, index) + ";");
                }
            }
        }

        lines.Add("");
        lines.Add("    public override global::System.Collections.Generic.IReadOnlyList<global::Kiln.SystemInfo> Systems => systems;");
        lines.Add("");
        lines.Add("    public override global::System.Collections.Generic.IReadOnlyList<string> ComponentNames => componentNames;");
        lines.Add("");
        lines.Add("    protected override void Attach(" + World + " world)");
        lines.Add("    {");
        for (int id = 0; id < world.Components.Count; id++)
        {
            var component = world.Components[id];
            lines.Add("        " + (component.IsTag ? "Tag<" : "Component<") + component.Type + ">(world, " + id + ", \"" + component.Name + "\");");
        }

        foreach (var @event in world.Events)
        {
            lines.Add("        Event<" + @event.Type + ">(world);");
        }

        foreach (var resource in world.Resources.Where(resource => resource.Constructible))
        {
            lines.Add("        world.SetResource<" + resource.Type + ">(new " + resource.Type + "());");
        }

        foreach (var plan in ordered)
        {
            for (int index = 0; index < plan.Arguments.Count; index++)
            {
                var argument = plan.Arguments[index];
                if (argument.Kind is ArgumentKind.Reader or ArgumentKind.Writer)
                {
                    lines.Add("        " + ChannelField(plan, index) + " = world."
                              + (argument.Kind == ArgumentKind.Reader ? "Reader" : "Writer") + "<" + argument.Type + ">();");
                }
            }
        }

        lines.Add("    }");
        lines.Add("");
        lines.Add("    protected override void Run(global::Kiln.Phase phase)");
        lines.Add("    {");
        lines.Add("        var world = World;");
        lines.Add("        switch (phase)");
        lines.Add("        {");
        foreach (var phase in ordered.GroupBy(plan => plan.Model.Phase))
        {
            lines.Add("            case global::Kiln.Phase." + Phases[phase.Key] + ":");
            foreach (var plan in phase)
            {
                lines.Add("                " + (plan.Model.Origin.IsLibrary ? "" : plan.Model.Class + ".") + RunnerName(plan) + "(world, this);");
            }

            lines.Add("                break;");
        }

        lines.Add("        }");
        lines.Add("    }");
        foreach (var plan in ordered.Where(plan => plan.Model.Origin.IsLibrary))
        {
            var body = new List<string> { "" };
            WriteRunner(body, world, plan, "private");
            lines.AddRange(body.Select(line => line.Length == 0 ? "" : "    " + line));
            lines.RemoveAt(lines.Count - 1);
        }

        lines.Add("}");
        text.AppendLine("namespace Kiln.Generated");
        text.AppendLine("{");
        foreach (string line in lines)
        {
            text.AppendLine(line.Length == 0 ? "" : "    " + line);
        }

        text.AppendLine("}");
    }

    // A system's loop: once, or over every entity its query matches. A
    // library's system is called by its full name from the schedule; a
    // program's from its own class, where it may be private.
    private static void WriteRunner(List<string> body, WorldModel world, SystemPlan plan, string access)
    {
        var system = plan.Model;
        string callee = system.Origin.IsLibrary ? system.Class + "." : "";
        body.Add("// " + system.FullName + (system.Origin.IsLibrary ? " (the Kiln library " + system.Origin.Library + ")" : "")
                 + ": phase " + Phases[system.Phase] + ", order " + system.Order + ".");
        body.Add(access + " static void " + RunnerName(plan) + "(" + World + " world, " + ScheduleClass + " schedule)");
        body.Add("{");
        if (system.RunIf is not null)
        {
            var conditions = plan.Condition.Select(argument => argument.Kind == ArgumentKind.World ? "world" : "world.Resource<" + argument.Type + ">()");
            body.Add("    if (!" + callee + system.RunIf + "(" + string.Join(", ", conditions) + ")) return;");
        }

        var arguments = new List<string>();
        var stores = new List<(string Local, int Id)>();
        for (int index = 0; index < plan.Arguments.Count; index++)
        {
            var argument = plan.Arguments[index];
            switch (argument.Kind)
            {
                case ArgumentKind.World:
                    arguments.Add("world");
                    break;
                case ArgumentKind.Resource:
                    body.Add("    var p" + index + " = world.Resource<" + argument.Type + ">();");
                    arguments.Add("p" + index);
                    break;
                case ArgumentKind.Reader:
                case ArgumentKind.Writer:
                    body.Add("    var p" + index + " = schedule." + ChannelField(plan, index) + ";");
                    arguments.Add("p" + index);
                    break;
                case ArgumentKind.Entity:
                    arguments.Add("world.EntityAt(slot)");
                    break;
                case ArgumentKind.Component:
                    int id = world.ComponentIds[argument.Type];
                    string local = "s" + id;
                    if (stores.All(store => store.Id != id))
                    {
                        stores.Add((local, id));
                    }

                    arguments.Add((argument.Writes ? "ref " : "") + local + ".Dense[" + local + ".IndexOf(slot)]");
                    break;
            }
        }

        string call = "        " + callee + system.Method + "(" + string.Join(", ", arguments) + ");";
        bool perEntity = stores.Count > 0 || system.With.Count > 0 || plan.Arguments.Any(argument => argument.Kind == ArgumentKind.Entity);
        if (!perEntity)
        {
            body.Add(call.Substring(4));
            body.Add("}");
            body.Add("");
            return;
        }

        foreach (string type in system.With)
        {
            int id = world.ComponentIds[type];
            if (!world.Components[id].IsTag && stores.All(store => store.Id != id))
            {
                stores.Add(("s" + id, id));
            }
        }

        // The bits the query requires and excludes, word by word of an
        // entity's words (as World.BitOf places them).
        int words = world.Words;
        var required = new ulong[words];
        var excluded = new ulong[words];
        foreach (string type in plan.Arguments.Where(argument => argument.Kind == ArgumentKind.Component).Select(argument => argument.Type).Concat(system.With))
        {
            int place = Place(world.ComponentIds[type]);
            required[place >> 6] |= 1UL << (place & 63);
        }

        foreach (string type in system.Without)
        {
            int place = Place(world.ComponentIds[type]);
            excluded[place >> 6] |= 1UL << (place & 63);
        }

        // The first word's alive bit, when the query has no component that
        // would tell a free slot (whose words are all zero) from a living
        // entity, or tests that word anyway.
        if (words == 1 || required[0] != 0 || required.All(bits => bits == 0))
        {
            required[0] |= AliveBit;
        }

        foreach (var (local, id) in stores)
        {
            body.Add("    var " + local + " = global::Kiln.Storage<" + world.Components[id].Type + ">.Of(world);");
        }

        if (stores.Count > 0)
        {
            // The smallest storage drives the loop.
            body.Add("    global::Kiln.ComponentStore driver = " + stores[0].Local + ";");
            foreach (var (local, _) in stores.Skip(1))
            {
                body.Add("    if (" + local + ".Count < driver.Count) driver = " + local + ";");
            }

            body.Add("    int count = driver.Count;");
            body.Add("    int[] slots = driver.Entities;");
        }
        else
        {
            body.Add("    int count = world.SlotCount;");
        }

        body.Add("    ulong[] masks = world.Masks;");
        body.Add("    world.BeginIteration();");
        body.Add("    try");
        body.Add("    {");
        body.Add("        for (int index = 0; index < count; index++)");
        body.Add("        {");
        body.Add("            int slot = " + (stores.Count > 0 ? "slots[index]" : "index") + ";");
        if (words == 1)
        {
            body.Add("            ulong mask = masks[slot];");
            body.Add("            if ((mask & " + Hex(required[0]) + ") != " + Hex(required[0])
                     + (excluded[0] != 0 ? " || (mask & " + Hex(excluded[0]) + ") != 0" : "") + ")");
        }
        else
        {
            // Only the words the query's components are in: a word with
            // required bits must have them and none of its excluded ones,
            // which is one test of both.
            body.Add("            int at = slot * " + words.ToString(CultureInfo.InvariantCulture) + ";");
            var tests = new List<string>();
            for (int word = 0; word < words; word++)
            {
                string mask = "masks[" + (word == 0 ? "at" : "at + " + word.ToString(CultureInfo.InvariantCulture)) + "]";
                if (required[word] != 0 && (required[word] & excluded[word]) == 0)
                {
                    tests.Add("(" + mask + " & " + Hex(required[word] | excluded[word]) + ") != " + Hex(required[word]));
                }
                else if (required[word] != 0)
                {
                    // A component both required and excluded: nothing matches.
                    tests.Add("(" + mask + " & " + Hex(required[word]) + ") != " + Hex(required[word]) + " || (" + mask + " & " + Hex(excluded[word]) + ") != 0");
                }
                else if (excluded[word] != 0)
                {
                    tests.Add("(" + mask + " & " + Hex(excluded[word]) + ") != 0");
                }
            }

            body.Add("            if (" + string.Join(" || ", tests) + ")");
        }

        body.Add("            {");
        body.Add("                continue;");
        body.Add("            }");
        body.Add("");
        body.Add("    " + call);
        body.Add("        }");
        body.Add("    }");
        body.Add("    finally");
        body.Add("    {");
        body.Add("        world.EndIteration();");
        body.Add("    }");
        body.Add("}");
        body.Add("");
    }

    // Writes a partial type's declarations around generated members.
    private static void WriteShell(StringBuilder text, TypeShell shell, string bases, System.Action<List<string>> members)
    {
        bool scoped = shell.Namespace.Length != 0;
        string indent = scoped ? "    " : "";
        if (scoped)
        {
            text.AppendLine("namespace " + shell.Namespace);
            text.AppendLine("{");
        }

        for (int depth = 0; depth < shell.Headers.Count; depth++)
        {
            text.Append(indent).Append(shell.Headers[depth]);
            if (depth == shell.Headers.Count - 1)
            {
                text.Append(bases);
            }

            text.AppendLine();
            text.Append(indent).AppendLine("{");
            indent += "    ";
        }

        var body = new List<string>();
        members(body);
        foreach (string line in body)
        {
            text.AppendLine(line.Length == 0 ? "" : indent + line);
        }

        for (int depth = shell.Headers.Count - 1; depth >= 0; depth--)
        {
            indent = indent.Substring(4);
            text.Append(indent).AppendLine("}");
        }

        if (scoped)
        {
            text.AppendLine("}");
        }

        text.AppendLine();
    }

    private static string Hex(ulong bits) => "0x" + bits.ToString("X", CultureInfo.InvariantCulture) + "UL";

    // A component's bit's place in an entity's words, past the first word's
    // top bit, the alive bit (World.BitOf).
    private static int Place(int id) => id < 63 ? id : id + 1;

    private static string RunnerName(SystemPlan plan) => "__Kiln_" + plan.Model.Method + "_" + plan.Id;

    private static string ChannelField(SystemPlan plan, int index) => "__channel" + plan.Id + "_" + index;

    private static string Names(WorldModel world, IEnumerable<string> types) =>
        string.Join(",", types.Select(type => world.Components[world.ComponentIds[type]].Name));
}

internal sealed class WorldModel
{
    public List<ComponentModel> Components { get; } = [];

    // The words of an entity's components and alive bit (World.WordsFor).
    public int Words => (Components.Count + 64) >> 6;

    public Dictionary<string, int> ComponentIds { get; } = [];

    public List<ResourceModel> Resources { get; } = [];

    public Dictionary<string, ResourceModel> ResourceTypes { get; } = [];

    public List<EventModel> Events { get; } = [];

    public Dictionary<string, int> EventIds { get; } = [];

    public List<BundleModel> Bundles { get; } = [];

    // Resources, events and components whose declarations were refused.
    public HashSet<string> Rejected { get; } = [];
}

internal enum ArgumentKind
{
    World,
    Resource,
    Entity,
    Reader,
    Writer,
    Component,
}

internal sealed record Argument(ArgumentKind Kind, string Type, bool Writes);

// A system that passed its checks, and what it reads and writes.
internal sealed class SystemPlan(SystemModel model, int id)
{
    public SystemModel Model { get; } = model;

    public int Id { get; } = id;

    public List<Argument> Arguments { get; } = [];

    public List<Argument> Condition { get; } = [];

    public SortedSet<string> Reads { get; } = new(System.StringComparer.Ordinal);

    public SortedSet<string> Writes { get; } = new(System.StringComparer.Ordinal);
}
