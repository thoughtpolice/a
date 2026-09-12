// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The canonical ABI's linear memory, for the glue witgen generates: values
// the component model passes through memory (strings, lists, and what does
// not fit the flat parameters and result) are copied between it and GC
// objects. Only runtime code and code marked [Gameplay.CanonicalAbi] may use
// these; the memory is the module's boundary, nothing else lives there.
// Strings are UTF-8, the component's declared encoding.

namespace Gameplay.Runtime
{
    // The memory's instructions, and its arena (see the compiler's
    // Frontend.Memory): Allocate is cabi_realloc's allocation, Top the arena's
    // current end, which Release returns to. Public in the CoreLib, whose
    // Gameplay.Abi reference assembly is what the glue compiles
    // against.
    public
    static class Memory
    {
        public static extern int Load8U(int address);

        public static extern int Load8S(int address);

        public static extern int Load16U(int address);

        public static extern int Load16S(int address);

        public static extern int Load32(int address);

        public static extern long Load64(int address);

        public static extern float LoadF32(int address);

        public static extern double LoadF64(int address);

        public static extern void Store8(int address, int value);

        public static extern void Store16(int address, int value);

        public static extern void Store32(int address, int value);

        public static extern void Store64(int address, long value);

        public static extern void StoreF32(int address, float value);

        public static extern void StoreF64(int address, double value);

        public static extern int Allocate(int size, int alignment);

        public static extern int Top();

        public static extern void Release(int top);

        // The arena's floor: where the outermost entry empties it to, below
        // which memory outlives entries (see corelib/ComponentTasks.cs).
        public static extern int Floor();

        public static extern void SetFloor(int floor);

        // The chain of blocks cabi_realloc gave the host below the arena's
        // floor while the CoreLib holds what the host allocates (0 when it
        // does not; see corelib/ComponentTasks.cs, HeldMemory).
        public static extern int HostChain();

        public static extern void SetHostChain(int chain);

        // The bits of floating-point values, for the canonical ABI's joined
        // flat types.
        public static extern int F32Bits(float value);

        public static extern float F32FromBits(int bits);

        public static extern long F64Bits(double value);

        public static extern double F64FromBits(long bits);
    }

    public
    static class Canonical
    {
        public static int Mark() => Memory.Top();

        public static void Release(int mark) => Memory.Release(mark);

        public static int Allocate(int size, int alignment) => Memory.Allocate(size, alignment);

        // A string the host lowered: `length` bytes of UTF-8 at `pointer`,
        // which the canonical ABI makes valid; a malformed sequence becomes
        // U+FFFD, as .NET decodes it.
        public static string LoadString(int pointer, int length)
        {
            int units = 0;
            for (int at = 0; at < length;)
            {
                int scalar = Decode(pointer, length, ref at);
                units += scalar > 0xffff ? 2 : 1;
            }

            var text = StringIntrinsics.Allocate(units);
            int index = 0;
            for (int at = 0; at < length;)
            {
                int scalar = Decode(pointer, length, ref at);
                if (scalar > 0xffff)
                {
                    scalar -= 0x10000;
                    StringIntrinsics.Set(text, index++, (char)(0xd800 + (scalar >> 10)));
                    StringIntrinsics.Set(text, index++, (char)(0xdc00 + (scalar & 0x3ff)));
                }
                else
                {
                    StringIntrinsics.Set(text, index++, (char)scalar);
                }
            }

            return text;
        }

        // The scalar value of the UTF-8 sequence at `at`, which it moves past.
        private static int Decode(int pointer, int length, ref int at)
        {
            int lead = Memory.Load8U(pointer + at);
            at++;
            if (lead < 0x80)
            {
                return lead;
            }

            int count = lead >= 0xf0 && lead < 0xf5 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc2 ? 1 : 0;
            if (count == 0 || lead >= 0xf5)
            {
                return 0xfffd;
            }

            int scalar = lead & (0x3f >> count);
            for (int index = 0; index < count; index++)
            {
                if (at >= length)
                {
                    return 0xfffd;
                }

                int next = Memory.Load8U(pointer + at);
                if ((next & 0xc0) != 0x80)
                {
                    return 0xfffd;
                }

                scalar = (scalar << 6) | (next & 0x3f);
                at++;
            }

            // Overlong forms, surrogates and values past U+10FFFF are malformed.
            int minimum = count == 1 ? 0x80 : count == 2 ? 0x800 : 0x10000;
            if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff))
            {
                return 0xfffd;
            }

            return scalar;
        }

        // A UTF-8 copy of a string for the host, and its length in bytes. A
        // lone surrogate, which UTF-8 cannot carry, becomes U+FFFD, as .NET
        // encodes it.
        public static int StoreString(string text, out int length)
        {
            int size = 0;
            for (int index = 0; index < text.Length; index++)
            {
                int unit = text[index];
                if (unit < 0x80)
                {
                    size += 1;
                }
                else if (unit < 0x800)
                {
                    size += 2;
                }
                else if (IsPair(text, index))
                {
                    size += 4;
                    index++;
                }
                else
                {
                    size += 3;
                }
            }

            int pointer = Memory.Allocate(size, 1);
            int at = pointer;
            for (int index = 0; index < text.Length; index++)
            {
                int scalar = text[index];
                if (IsPair(text, index))
                {
                    scalar = 0x10000 + ((scalar - 0xd800) << 10) + (text[index + 1] - 0xdc00);
                    index++;
                }
                else if (scalar >= 0xd800 && scalar <= 0xdfff)
                {
                    scalar = 0xfffd;
                }

                if (scalar < 0x80)
                {
                    Memory.Store8(at++, scalar);
                }
                else if (scalar < 0x800)
                {
                    Memory.Store8(at++, 0xc0 | (scalar >> 6));
                    Memory.Store8(at++, 0x80 | (scalar & 0x3f));
                }
                else if (scalar < 0x10000)
                {
                    Memory.Store8(at++, 0xe0 | (scalar >> 12));
                    Memory.Store8(at++, 0x80 | ((scalar >> 6) & 0x3f));
                    Memory.Store8(at++, 0x80 | (scalar & 0x3f));
                }
                else
                {
                    Memory.Store8(at++, 0xf0 | (scalar >> 18));
                    Memory.Store8(at++, 0x80 | ((scalar >> 12) & 0x3f));
                    Memory.Store8(at++, 0x80 | ((scalar >> 6) & 0x3f));
                    Memory.Store8(at++, 0x80 | (scalar & 0x3f));
                }
            }

            length = size;
            return pointer;
        }

        private static bool IsPair(string text, int index) =>
            text[index] >= 0xd800 && text[index] <= 0xdbff && index + 1 < text.Length
            && text[index + 1] >= 0xdc00 && text[index + 1] <= 0xdfff;

        public static bool LoadBool(int address) => Memory.Load8U(address) != 0;

        public static void StoreBool(int address, bool value) => Memory.Store8(address, value ? 1 : 0);

        // The size of `count` elements of `size` bytes, which must fit the
        // memory's addresses.
        public static int Size(int count, int size)
        {
            if (count < 0 || (size != 0 && count > int.MaxValue / size))
            {
                throw new System.OverflowException();
            }

            return count * size;
        }
    }
}
