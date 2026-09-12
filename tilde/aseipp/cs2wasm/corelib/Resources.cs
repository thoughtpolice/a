// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The objects of the resources a component exports, under the glue witgen
// generates (docs/WIT.md, "Exported resources"). A handle of such a
// resource carries a rep, an i32 the module chooses when it makes the
// handle (`resource.new`): here, the object's entry in its class's table,
// made when the object first leaves the module as an `own` handle. The
// entry counts those handles; the resource's destructor, which the host
// calls as it drops each, takes the object out of the table with the last.

using System;
using System.Collections.Generic;

namespace Gameplay.Runtime
{
    /// <summary>
    /// The objects of one exported resource that handles outside the module
    /// stand for, by rep.
    /// </summary>
    public sealed class ResourceReps<T>
        where T : class
    {
        // By rep - 1: the object, and how many own handles of it are out.
        private readonly List<T?> objects = new List<T?>();
        private readonly List<int> owners = new List<int>();
        private readonly List<int> free = new List<int>();

        /// <summary>Creates an empty table.</summary>
        public ResourceReps()
        {
        }

        /// <summary>An entry for <paramref name="value"/>: its rep.</summary>
        public int Add(T value)
        {
            if (free.Count > 0)
            {
                int index = free[free.Count - 1];
                free.RemoveAt(free.Count - 1);
                objects[index] = value;
                return index + 1;
            }

            objects.Add(value);
            owners.Add(0);
            return objects.Count;
        }

        /// <summary>The object <paramref name="rep"/> stands for.</summary>
        public T Get(int rep)
        {
            if ((uint)(rep - 1) >= (uint)objects.Count || objects[rep - 1] is not { } value)
            {
                throw new InvalidOperationException("The rep stands for no object of the resource.");
            }

            return value;
        }

        /// <summary>A new own handle of <paramref name="rep"/>'s object is made: the rep.</summary>
        public int Own(int rep)
        {
            Get(rep);
            owners[rep - 1]++;
            return rep;
        }

        /// <summary>
        /// An own handle of <paramref name="rep"/>'s object was dropped: the
        /// object, when that was its last, which leaves the table; else null.
        /// </summary>
        public T? Release(int rep)
        {
            var value = Get(rep);
            if (--owners[rep - 1] > 0)
            {
                return null;
            }

            objects[rep - 1] = null;
            free.Add(rep - 1);
            return value;
        }
    }
}
