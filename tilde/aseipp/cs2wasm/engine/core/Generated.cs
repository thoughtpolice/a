// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What Kiln's generator writes into the assemblies it compiles, beside a
// program's Kiln.Generated.GameSchedule.
namespace Kiln.Generated;

using System;

/// <summary>
/// Marks a Kiln library: an assembly compiled with Kiln's generator as a
/// library (gameplayc's <c>--library</c>, which tells the generator so),
/// whose components, resources, events, bundles and systems (all public)
/// join the schedule of every program that references it, as a Bevy
/// plugin's do. The generator writes it, with what the library's
/// declarations need (the component and event interfaces, the resources'
/// world properties, the bundles' methods); a program's generator finds
/// its libraries by it. Code does not write it.
/// </summary>
[AttributeUsage(AttributeTargets.Assembly)]
public sealed class KilnLibraryAttribute : Attribute
{
}
