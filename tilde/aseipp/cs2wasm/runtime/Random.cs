// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Random as .NET has it. A seeded one runs the CLR's compatible
// generator (Knuth's subtractive one, as .NET Framework had it), so a seed
// gives the CLR's sequence, member for member. An unseeded one and Shared
// run the CLR's xoshiro256** generator, seeded where the CLR seeds from the
// operating system from a SplitMix64 sequence of the module instance's
// own, so their sequences are fixed per instance. It is sealed: a derived
// Random's overrides are not called as the CLR calls them.

namespace System
{
    public sealed class Random
    {
        // The compatible generator's state, or none.
        private readonly int[] seedArray;
        private int inext;
        private int inextp;

        // xoshiro256**'s state.
        private ulong s0;
        private ulong s1;
        private ulong s2;
        private ulong s3;

        private static ulong nextSeed = 0x9E3779B97F4A7C15;

        private static Random shared;

        public Random()
        {
            do
            {
                s0 = SplitMix();
                s1 = SplitMix();
                s2 = SplitMix();
                s3 = SplitMix();
            }
            while ((s0 | s1 | s2 | s3) == 0);
        }

        public Random(int Seed)
        {
            int[] array = new int[56];
            int subtraction = (Seed == int.MinValue) ? int.MaxValue : (Seed < 0 ? -Seed : Seed);
            int mj = 161803398 - subtraction;
            array[55] = mj;
            int mk = 1;
            int ii = 0;
            for (int i = 1; i < 55; i++)
            {
                if ((ii += 21) >= 55)
                {
                    ii -= 55;
                }

                array[ii] = mk;
                mk = mj - mk;
                if (mk < 0)
                {
                    mk += int.MaxValue;
                }

                mj = array[ii];
            }

            for (int k = 1; k < 5; k++)
            {
                for (int i = 1; i < 56; i++)
                {
                    int n = i + 30;
                    if (n >= 55)
                    {
                        n -= 55;
                    }

                    array[i] -= array[1 + n];
                    if (array[i] < 0)
                    {
                        array[i] += int.MaxValue;
                    }
                }
            }

            seedArray = array;
            inext = 0;
            inextp = 21;
        }

        public static Random Shared => shared ??= new Random();

        private static ulong SplitMix()
        {
            ulong z = nextSeed += 0x9E3779B97F4A7C15;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EB;
            return z ^ (z >> 31);
        }

        private static ulong RotateLeft(ulong value, int offset) => (value << offset) | (value >> (64 - offset));

        private ulong NextUInt64()
        {
            ulong result = RotateLeft(s1 * 5, 7) * 9;
            ulong t = s1 << 17;
            s2 ^= s0;
            s3 ^= s1;
            s1 ^= s2;
            s0 ^= s3;
            s2 ^= t;
            s3 = RotateLeft(s3, 45);
            return result;
        }

        private uint NextUInt32() => (uint)(NextUInt64() >> 32);

        // Lemire's unbiased bounded values, as .NET draws them.
        private uint NextUInt32(uint maxValue)
        {
            ulong randomProduct = (ulong)maxValue * NextUInt32();
            uint lowPart = (uint)randomProduct;
            if (lowPart < maxValue)
            {
                uint remainder = (0u - maxValue) % maxValue;
                while (lowPart < remainder)
                {
                    randomProduct = (ulong)maxValue * NextUInt32();
                    lowPart = (uint)randomProduct;
                }
            }

            return (uint)(randomProduct >> 32);
        }

        private ulong NextUInt64(ulong maxValue)
        {
            ulong randomProduct = Multiply(maxValue, NextUInt64(), out ulong lowPart);
            if (lowPart < maxValue)
            {
                ulong remainder = (0ul - maxValue) % maxValue;
                while (lowPart < remainder)
                {
                    randomProduct = Multiply(maxValue, NextUInt64(), out lowPart);
                }
            }

            return randomProduct;
        }

        // Math.BigMul: the high and low halves of a 128-bit product.
        private static ulong Multiply(ulong a, ulong b, out ulong low)
        {
            ulong al = (uint)a;
            ulong ah = a >> 32;
            ulong bl = (uint)b;
            ulong bh = b >> 32;
            ulong mull = al * bl;
            ulong t = ah * bl + (mull >> 32);
            ulong tl = al * bh + (uint)t;
            low = (tl << 32) | (uint)mull;
            return ah * bh + (t >> 32) + (tl >> 32);
        }

        private int InternalSample()
        {
            int locINext = inext;
            if (++locINext >= 56)
            {
                locINext = 1;
            }

            int locINextp = inextp;
            if (++locINextp >= 56)
            {
                locINextp = 1;
            }

            int retVal = seedArray[locINext] - seedArray[locINextp];
            if (retVal == int.MaxValue)
            {
                retVal--;
            }

            if (retVal < 0)
            {
                retVal += int.MaxValue;
            }

            seedArray[locINext] = retVal;
            inext = locINext;
            inextp = locINextp;
            return retVal;
        }

        private double Sample() => InternalSample() * (1.0 / int.MaxValue);

        private double GetSampleForLargeRange()
        {
            int result = InternalSample();
            if (InternalSample() % 2 == 0)
            {
                result = -result;
            }

            double d = result;
            d += int.MaxValue - 1;
            d /= 2u * int.MaxValue - 1;
            return d;
        }

        public int Next()
        {
            if (seedArray != null)
            {
                return InternalSample();
            }

            while (true)
            {
                ulong result = NextUInt64() >> 33;
                if (result != int.MaxValue)
                {
                    return (int)result;
                }
            }
        }

        public int Next(int maxValue)
        {
            if (maxValue < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            return seedArray != null ? (int)(Sample() * maxValue) : (int)NextUInt32((uint)maxValue);
        }

        public int Next(int minValue, int maxValue)
        {
            if (minValue > maxValue)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (seedArray == null)
            {
                return (int)NextUInt32((uint)(maxValue - minValue)) + minValue;
            }

            long range = (long)maxValue - minValue;
            return range <= int.MaxValue
                ? (int)(Sample() * range) + minValue
                : (int)((long)(GetSampleForLargeRange() * range) + minValue);
        }

        // The compatible generator's 64 bits, from three bounded draws.
        private ulong CompatUInt64() =>
            ((ulong)(uint)Next(1 << 22)) | (((ulong)(uint)Next(1 << 22)) << 22) | (((ulong)(uint)Next(1 << 20)) << 44);

        public long NextInt64()
        {
            while (true)
            {
                ulong result = (seedArray != null ? CompatUInt64() : NextUInt64()) >> 1;
                if (result != long.MaxValue)
                {
                    return (long)result;
                }
            }
        }

        public long NextInt64(long maxValue)
        {
            if (maxValue < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            return NextInt64(0, maxValue);
        }

        public long NextInt64(long minValue, long maxValue)
        {
            if (minValue > maxValue)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (seedArray == null)
            {
                return (long)NextUInt64((ulong)(maxValue - minValue)) + minValue;
            }

            ulong exclusiveRange = (ulong)(maxValue - minValue);
            if (exclusiveRange > 1)
            {
                // BitOperations.Log2Ceiling.
                int bits = 0;
                for (ulong value = exclusiveRange - 1; value != 0; value >>= 1)
                {
                    bits++;
                }

                while (true)
                {
                    ulong result = CompatUInt64() >> (64 - bits);
                    if (result < exclusiveRange)
                    {
                        return (long)result + minValue;
                    }
                }
            }

            return minValue;
        }

        public double NextDouble() => seedArray != null ? Sample() : (NextUInt64() >> 11) * (1.0 / (1ul << 53));

        public float NextSingle()
        {
            if (seedArray == null)
            {
                return (NextUInt64() >> 40) * (1.0f / (1u << 24));
            }

            while (true)
            {
                float f = (float)Sample();
                if (f < 1.0f)
                {
                    return f;
                }
            }
        }

        public void NextBytes(byte[] buffer)
        {
            if (buffer == null)
            {
                throw new ArgumentNullException();
            }

            if (seedArray != null)
            {
                for (int i = 0; i < buffer.Length; i++)
                {
                    buffer[i] = (byte)InternalSample();
                }

                return;
            }

            // Eight bytes a draw, little-endian, as .NET writes them.
            ulong next = 0;
            for (int i = 0; i < buffer.Length; i++)
            {
                if ((i & 7) == 0)
                {
                    next = NextUInt64();
                }

                buffer[i] = (byte)(next >> ((i & 7) * 8));
            }
        }

        public void Shuffle<T>(T[] values)
        {
            if (values == null)
            {
                throw new ArgumentNullException();
            }

            for (int i = 0; i < values.Length - 1; i++)
            {
                int j = Next(i, values.Length);
                T temp = values[i];
                values[i] = values[j];
                values[j] = temp;
            }
        }

        public T[] GetItems<T>(T[] choices, int length)
        {
            if (choices == null)
            {
                throw new ArgumentNullException();
            }

            if (length < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (choices.Length == 0)
            {
                throw new ArgumentException();
            }

            var items = new T[length];
            for (int i = 0; i < length; i++)
            {
                items[i] = choices[Next(choices.Length)];
            }

            return items;
        }
    }
}
