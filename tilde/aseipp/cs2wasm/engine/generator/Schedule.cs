// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln.Generator;

using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;

// The order of a phase's systems, decided at compile time: [After] and
// [Before] are edges, and among the systems free to run next the one with
// the lowest Order runs first, then by class and method name, so the
// schedule never depends on declaration order or on the generator's
// input order. A cycle is an error; two systems that touch one component,
// at least one writing it, with the same Order and no path between them
// are a warning (their order is only their names').
internal static class Schedule
{
    private static readonly string[] Phases = ["Startup", "PreUpdate", "Update", "PostUpdate", "Render"];

    public static List<SystemPlan> Order(SourceProductionContext output, List<SystemPlan> all, int phase)
    {
        var systems = all.Where(plan => plan.Model.Phase == phase).ToList();
        var after = systems.ToDictionary(plan => plan, _ => new HashSet<SystemPlan>());
        foreach (var plan in systems)
        {
            foreach (string name in plan.Model.After)
            {
                if (Resolve(output, all, systems, plan, name) is { } target)
                {
                    after[plan].Add(target);
                }
            }

            foreach (string name in plan.Model.Before)
            {
                if (Resolve(output, all, systems, plan, name) is { } target)
                {
                    after[target].Add(plan);
                }
            }
        }

        var ordered = new List<SystemPlan>();
        var remaining = new List<SystemPlan>(systems);
        while (remaining.Count > 0)
        {
            var ready = remaining
                .Where(plan => after[plan].All(ordered.Contains))
                .OrderBy(plan => plan.Model.Order)
                .ThenBy(plan => plan.Model.ClassName, System.StringComparer.Ordinal)
                .ThenBy(plan => plan.Model.Method, System.StringComparer.Ordinal)
                .ThenBy(plan => plan.Model.Class, System.StringComparer.Ordinal)
                .FirstOrDefault();
            if (ready is null)
            {
                var cycle = remaining.OrderBy(plan => plan.Model.FullName, System.StringComparer.Ordinal).ToList();
                output.ReportDiagnostic(Diagnostic.Create(
                    Diagnostics.OrderCycle,
                    cycle[0].Model.Location,
                    Phases[phase],
                    string.Join(", ", cycle.Select(plan => plan.Model.FullName))));
                break;
            }

            ordered.Add(ready);
            remaining.Remove(ready);
        }

        // Which systems are ordered before which, through any path.
        var before = systems.ToDictionary(plan => plan, _ => new HashSet<SystemPlan>());
        foreach (var plan in ordered)
        {
            foreach (var earlier in after[plan])
            {
                before[plan].Add(earlier);
                before[plan].UnionWith(before[earlier]);
            }
        }

        for (int first = 0; first < ordered.Count; first++)
        {
            for (int second = first + 1; second < ordered.Count; second++)
            {
                var a = ordered[first];
                var b = ordered[second];
                if (a.Model.Order != b.Model.Order || before[b].Contains(a) || before[a].Contains(b))
                {
                    continue;
                }

                string? shared = a.Writes.Intersect(b.Reads.Concat(b.Writes))
                    .Concat(b.Writes.Intersect(a.Reads))
                    .OrderBy(type => type, System.StringComparer.Ordinal)
                    .FirstOrDefault();
                if (shared is not null)
                {
                    output.ReportDiagnostic(Diagnostic.Create(
                        Diagnostics.Ambiguous,
                        b.Model.Location,
                        a.Model.FullName,
                        b.Model.FullName,
                        Phases[phase],
                        shared.Substring(shared.LastIndexOf('.') + 1)));
                }
            }
        }

        return ordered;
    }

    // A system named in [After]/[Before]: Class.Method, or a method name
    // (nameof gives just that) unique in the phase.
    private static SystemPlan? Resolve(SourceProductionContext output, List<SystemPlan> all, List<SystemPlan> phase, SystemPlan from, string name)
    {
        bool Matches(SystemPlan plan) => name.Contains('.') ? plan.Model.FullName == name : plan.Model.Method == name;
        var matches = phase.Where(Matches).ToList();
        if (matches.Count == 1)
        {
            return matches[0];
        }

        string problem = matches.Count > 1
            ? "ambiguous; name it Class.Method"
            : all.FirstOrDefault(Matches) is { } elsewhere
                ? "in phase " + Phases[elsewhere.Model.Phase] + ", and systems are ordered within their phase"
                : "not a system";
        output.ReportDiagnostic(Diagnostic.Create(Diagnostics.UnknownSystem, from.Model.Location, from.Model.FullName, name, problem));
        return null;
    }
}
