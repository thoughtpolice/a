// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The attributes a Kiln program is described with. They are metadata only:
// the engine's source generator (engine/generator) reads them at compile
// time, from the program's sources and from the Kiln libraries it
// references, and writes the schedule they describe, so nothing here is
// ever looked up at run time.
namespace Kiln;

using System;

/// <summary>
/// A component: plain data an entity may have. The struct must be
/// <c>partial</c> (the generator makes it an <see cref="IComponent{T}"/>).
/// A struct with no instance fields is a tag, kept in the entity's mask
/// alone.
/// </summary>
[AttributeUsage(AttributeTargets.Struct)]
public sealed class ComponentAttribute : Attribute
{
}

/// <summary>
/// A resource: one instance per world, reachable as a property of the
/// world named after its type (an extension property the generator
/// writes where the resource is declared), as
/// <see cref="World.Resource{T}"/>, and as a system parameter of its type.
/// </summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class ResourceAttribute : Attribute
{
}

/// <summary>
/// An event: a struct systems send with an <see cref="EventWriter{T}"/>
/// parameter and read with an <see cref="EventReader{T}"/> parameter, each
/// reader seeing every event once.
/// </summary>
[AttributeUsage(AttributeTargets.Struct)]
public sealed class EventAttribute : Attribute
{
}

/// <summary>
/// A bundle: a partial record struct of components the world can spawn
/// or add together (<c>world.Spawn(bundle)</c>).
/// </summary>
[AttributeUsage(AttributeTargets.Struct)]
public sealed class BundleAttribute : Attribute
{
}

/// <summary>
/// A system: a static method of a partial class, run by the world in its
/// phase. Its parameters say what it runs over: <c>ref</c> components are
/// written, <c>in</c> and by-value ones read, and it runs once per entity
/// that has them all (and every <see cref="WithAttribute{T}"/>, and none of
/// the <see cref="WithoutAttribute{T}"/>). An <see cref="Entity"/>
/// parameter is that entity; a <see cref="World"/>, a resource, an event
/// reader or writer is the world's. A system without component parameters
/// runs once.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class SystemAttribute : Attribute
{
    public SystemAttribute(Phase phase = Phase.Update)
    {
        Phase = phase;
    }

    public Phase Phase { get; }

    /// <summary>Systems of a phase run in ascending order, then by name.</summary>
    public int Order { get; set; }
}

/// <summary>The system runs only over entities that also have <typeparamref name="T"/>.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class WithAttribute<T> : Attribute
    where T : struct
{
}

/// <summary>The system skips entities that have <typeparamref name="T"/>.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class WithoutAttribute<T> : Attribute
    where T : struct
{
}

/// <summary>The system runs after the named system of its phase (<c>nameof(Class.Method)</c> or <c>"Class.Method"</c>).</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class AfterAttribute : Attribute
{
    public AfterAttribute(string system)
    {
        System = system;
    }

    public string System { get; }
}

/// <summary>The system runs before the named system of its phase.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class BeforeAttribute : Attribute
{
    public BeforeAttribute(string system)
    {
        System = system;
    }

    public string System { get; }
}

/// <summary>
/// The system runs only when the named static bool method of its class
/// returns true; that method's parameters are resources or the world.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class RunIfAttribute : Attribute
{
    public RunIfAttribute(string condition)
    {
        Condition = condition;
    }

    public string Condition { get; }
}
