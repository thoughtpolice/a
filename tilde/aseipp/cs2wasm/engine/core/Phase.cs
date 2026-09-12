// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

/// <summary>
/// When a system runs. <see cref="World.Tick"/> runs the update phases in
/// order, once per fixed step; the render phase runs once per displayed
/// frame; startup systems run once, from <see cref="World.Startup"/>.
/// </summary>
public enum Phase
{
    Startup,
    PreUpdate,
    Update,
    PostUpdate,
    Render,
}
