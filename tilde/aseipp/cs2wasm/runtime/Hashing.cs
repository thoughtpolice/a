// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.HashCode as .NET has it: xxHash32 over the values' hash codes,
// Combine and Add alike. The CLR seeds it at random per process, so no
// value of it is anyone's to depend on; this one's seed is zero, so a
// module's hash codes are the same every run. The values' hash codes are
// EqualityComparer<T>.Default's (see runtime/Collections.cs).

using Gameplay.Runtime;

namespace System
{
    public struct HashCode
    {
        private const uint Seed = 0;
        private const uint Prime1 = 2654435761U;
        private const uint Prime2 = 2246822519U;
        private const uint Prime3 = 3266489917U;
        private const uint Prime4 = 668265263U;
        private const uint Prime5 = 374761393U;

        private uint v1;
        private uint v2;
        private uint v3;
        private uint v4;
        private uint queue1;
        private uint queue2;
        private uint queue3;
        private uint length;

        private static uint Rotate(uint value, int offset) => (value << offset) | (value >> (32 - offset));

        private static void Initialize(out uint v1, out uint v2, out uint v3, out uint v4)
        {
            v1 = unchecked(Seed + Prime1 + Prime2);
            v2 = Seed + Prime2;
            v3 = Seed;
            v4 = unchecked(Seed - Prime1);
        }

        private static uint Round(uint hash, uint input) => Rotate(hash + input * Prime2, 13) * Prime1;

        private static uint QueueRound(uint hash, uint queuedValue) => Rotate(hash + queuedValue * Prime3, 17) * Prime4;

        private static uint MixState(uint v1, uint v2, uint v3, uint v4) =>
            Rotate(v1, 1) + Rotate(v2, 7) + Rotate(v3, 12) + Rotate(v4, 18);

        private static uint MixEmptyState() => Seed + Prime5;

        private static uint MixFinal(uint hash)
        {
            hash ^= hash >> 15;
            hash *= Prime2;
            hash ^= hash >> 13;
            hash *= Prime3;
            hash ^= hash >> 16;
            return hash;
        }

        private static uint Of<T>(T value) => (uint)Intrinsics.Hash(value);

        public static int Combine<T1>(T1 value1)
        {
            uint hash = MixEmptyState();
            hash += 4;
            hash = QueueRound(hash, Of(value1));
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2>(T1 value1, T2 value2)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hash = MixEmptyState();
            hash += 8;
            hash = QueueRound(hash, hc1);
            hash = QueueRound(hash, hc2);
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2, T3>(T1 value1, T2 value2, T3 value3)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hc3 = Of(value3);
            uint hash = MixEmptyState();
            hash += 12;
            hash = QueueRound(hash, hc1);
            hash = QueueRound(hash, hc2);
            hash = QueueRound(hash, hc3);
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2, T3, T4>(T1 value1, T2 value2, T3 value3, T4 value4)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hc3 = Of(value3);
            uint hc4 = Of(value4);
            Initialize(out uint v1, out uint v2, out uint v3, out uint v4);
            v1 = Round(v1, hc1);
            v2 = Round(v2, hc2);
            v3 = Round(v3, hc3);
            v4 = Round(v4, hc4);
            uint hash = MixState(v1, v2, v3, v4);
            hash += 16;
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2, T3, T4, T5>(T1 value1, T2 value2, T3 value3, T4 value4, T5 value5)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hc3 = Of(value3);
            uint hc4 = Of(value4);
            uint hc5 = Of(value5);
            Initialize(out uint v1, out uint v2, out uint v3, out uint v4);
            v1 = Round(v1, hc1);
            v2 = Round(v2, hc2);
            v3 = Round(v3, hc3);
            v4 = Round(v4, hc4);
            uint hash = MixState(v1, v2, v3, v4);
            hash += 20;
            hash = QueueRound(hash, hc5);
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2, T3, T4, T5, T6>(
            T1 value1, T2 value2, T3 value3, T4 value4, T5 value5, T6 value6)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hc3 = Of(value3);
            uint hc4 = Of(value4);
            uint hc5 = Of(value5);
            uint hc6 = Of(value6);
            Initialize(out uint v1, out uint v2, out uint v3, out uint v4);
            v1 = Round(v1, hc1);
            v2 = Round(v2, hc2);
            v3 = Round(v3, hc3);
            v4 = Round(v4, hc4);
            uint hash = MixState(v1, v2, v3, v4);
            hash += 24;
            hash = QueueRound(hash, hc5);
            hash = QueueRound(hash, hc6);
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2, T3, T4, T5, T6, T7>(
            T1 value1, T2 value2, T3 value3, T4 value4, T5 value5, T6 value6, T7 value7)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hc3 = Of(value3);
            uint hc4 = Of(value4);
            uint hc5 = Of(value5);
            uint hc6 = Of(value6);
            uint hc7 = Of(value7);
            Initialize(out uint v1, out uint v2, out uint v3, out uint v4);
            v1 = Round(v1, hc1);
            v2 = Round(v2, hc2);
            v3 = Round(v3, hc3);
            v4 = Round(v4, hc4);
            uint hash = MixState(v1, v2, v3, v4);
            hash += 28;
            hash = QueueRound(hash, hc5);
            hash = QueueRound(hash, hc6);
            hash = QueueRound(hash, hc7);
            return (int)MixFinal(hash);
        }

        public static int Combine<T1, T2, T3, T4, T5, T6, T7, T8>(
            T1 value1, T2 value2, T3 value3, T4 value4, T5 value5, T6 value6, T7 value7, T8 value8)
        {
            uint hc1 = Of(value1);
            uint hc2 = Of(value2);
            uint hc3 = Of(value3);
            uint hc4 = Of(value4);
            uint hc5 = Of(value5);
            uint hc6 = Of(value6);
            uint hc7 = Of(value7);
            uint hc8 = Of(value8);
            Initialize(out uint v1, out uint v2, out uint v3, out uint v4);
            v1 = Round(v1, hc1);
            v2 = Round(v2, hc2);
            v3 = Round(v3, hc3);
            v4 = Round(v4, hc4);
            v1 = Round(v1, hc5);
            v2 = Round(v2, hc6);
            v3 = Round(v3, hc7);
            v4 = Round(v4, hc8);
            uint hash = MixState(v1, v2, v3, v4);
            hash += 32;
            return (int)MixFinal(hash);
        }

        public void Add<T>(T value) => AddHash(Of(value));

        private void AddHash(uint value)
        {
            uint previousLength = length++;
            uint position = previousLength % 4;
            if (position == 0)
            {
                queue1 = value;
            }
            else if (position == 1)
            {
                queue2 = value;
            }
            else if (position == 2)
            {
                queue3 = value;
            }
            else
            {
                if (previousLength == 3)
                {
                    v1 = unchecked(Seed + Prime1 + Prime2);
                    v2 = Seed + Prime2;
                    v3 = Seed;
                    v4 = unchecked(Seed - Prime1);
                }

                v1 = Round(v1, queue1);
                v2 = Round(v2, queue2);
                v3 = Round(v3, queue3);
                v4 = Round(v4, value);
            }
        }

        public int ToHashCode()
        {
            uint count = length;
            uint position = count % 4;
            uint hash = count < 4 ? MixEmptyState() : MixState(v1, v2, v3, v4);
            hash += count * 4;
            if (position > 0)
            {
                hash = QueueRound(hash, queue1);
                if (position > 1)
                {
                    hash = QueueRound(hash, queue2);
                    if (position > 2)
                    {
                        hash = QueueRound(hash, queue3);
                    }
                }
            }

            return (int)MixFinal(hash);
        }
    }
}
