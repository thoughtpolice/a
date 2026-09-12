// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Type, as far as code without reflection uses it: one object per
// type (so == and Equals compare identities, as the CLR's runtime types
// do), its names and its kind. The compiler takes it for the framework's
// Type, member by member, and makes each type's object once, on first use
// (typeof, GetType).

namespace Gameplay.Runtime
{
    public sealed class Type
    {
        internal const int ValueTypeFlag = 1;
        internal const int ClassFlag = 2;
        internal const int InterfaceFlag = 4;
        internal const int EnumFlag = 8;
        internal const int ArrayFlag = 16;
        internal const int PrimitiveFlag = 32;
        internal const int SealedFlag = 64;
        internal const int AbstractFlag = 128;
        internal const int GenericFlag = 256;

        private readonly string text;
        private readonly string name;
        private readonly string space;
        private readonly int flags;
        private readonly Type baseType;

        internal Type(string text, string name, string space, int flags, Type baseType)
        {
            this.text = text;
            this.name = name;
            this.space = space;
            this.flags = flags;
            this.baseType = baseType;
        }

        public string Name => name;

        // A generic instantiation's full name names its type arguments'
        // assemblies, which a module has none of.
        public string FullName => (flags & GenericFlag) != 0 ? throw new System.NotSupportedException() : text;

        public string Namespace => space;

        public Type BaseType => baseType;

        public bool IsValueType => (flags & ValueTypeFlag) != 0;

        public bool IsClass => (flags & ClassFlag) != 0;

        public bool IsInterface => (flags & InterfaceFlag) != 0;

        public bool IsEnum => (flags & EnumFlag) != 0;

        public bool IsArray => (flags & ArrayFlag) != 0;

        public bool IsPrimitive => (flags & PrimitiveFlag) != 0;

        public bool IsSealed => (flags & SealedFlag) != 0;

        public bool IsAbstract => (flags & AbstractFlag) != 0;

        public bool IsGenericType => (flags & GenericFlag) != 0;

        public override string ToString() => text;

        public override bool Equals(object o) => ReferenceEquals(this, o);

        public bool Equals(Type o) => ReferenceEquals(this, o);

        public override int GetHashCode() => text.GetHashCode();

        public static bool operator ==(Type left, Type right) => ReferenceEquals(left, right);

        public static bool operator !=(Type left, Type right) => !ReferenceEquals(left, right);
    }
}
