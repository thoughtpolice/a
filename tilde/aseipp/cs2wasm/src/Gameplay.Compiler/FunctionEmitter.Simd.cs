// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Vector128's members as Wasm SIMD instructions (see Frontend.Simd), where
// one or a few do what the member does; the others are the CoreLib's C#
// (corelib/Vector128.cs), which calls these. A member of an element type
// no instruction takes (an 8-bit multiply, a 64-bit minimum) falls through
// to the C# too, which spells it out per element or in terms of these.
// Floating-point lanes follow .NET's definitions: Min and Max propagate NaN
// and order -0 below +0 (as f32x4.min does), MinNative and MaxNative are
// x64's minps and maxps (f32x4.pmin and pmax with the operands swapped),
// conversions to integers saturate (NaN is 0), and Sum and Dot add pairs of
// lanes first, as the CLR's SIMD code does.
internal sealed partial class FunctionEmitter
{
    // Lane-indexed opcodes, in Lane order (I8, U8, I16, U16, I32, U32, I64,
    // U64, F32, F64); 0 where no single instruction does it.
    private static readonly uint[] SimdAdd = [110, 110, 142, 142, 174, 174, 206, 206, 228, 240];
    private static readonly uint[] SimdSub = [113, 113, 145, 145, 177, 177, 209, 209, 229, 241];
    private static readonly uint[] SimdMul = [0, 0, 149, 149, 181, 181, 213, 213, 230, 242];
    private static readonly uint[] SimdDiv = [0, 0, 0, 0, 0, 0, 0, 0, 231, 243];
    private static readonly uint[] SimdMin = [118, 119, 150, 151, 182, 183, 0, 0, 232, 244];
    private static readonly uint[] SimdMax = [120, 121, 152, 153, 184, 185, 0, 0, 233, 245];
    private static readonly uint[] SimdPmin = [118, 119, 150, 151, 182, 183, 0, 0, 234, 246];
    private static readonly uint[] SimdPmax = [120, 121, 152, 153, 184, 185, 0, 0, 235, 247];
    private static readonly uint[] SimdEq = [35, 35, 45, 45, 55, 55, 214, 214, 65, 71];
    private static readonly uint[] SimdNe = [36, 36, 46, 46, 56, 56, 215, 215, 66, 72];
    private static readonly uint[] SimdLt = [37, 38, 47, 48, 57, 58, 216, 0, 67, 73];
    private static readonly uint[] SimdLe = [41, 42, 51, 52, 61, 62, 218, 0, 69, 75];
    private static readonly uint[] SimdGe = [43, 44, 53, 54, 63, 64, 219, 0, 70, 76];
    private static readonly uint[] SimdAddSaturate = [111, 112, 143, 144, 0, 0, 0, 0, 0, 0];
    private static readonly uint[] SimdSubSaturate = [114, 115, 146, 147, 0, 0, 0, 0, 0, 0];
    private static readonly uint[] SimdNeg = [97, 97, 129, 129, 161, 161, 193, 193, 225, 237];
    private static readonly uint[] SimdAbs = [96, 0, 128, 0, 160, 0, 192, 0, 224, 236];
    private static readonly uint[] SimdSqrt = [0, 0, 0, 0, 0, 0, 0, 0, 227, 239];
    private static readonly uint[] SimdCeiling = [0, 0, 0, 0, 0, 0, 0, 0, 103, 116];
    private static readonly uint[] SimdFloor = [0, 0, 0, 0, 0, 0, 0, 0, 104, 117];
    private static readonly uint[] SimdTruncate = [0, 0, 0, 0, 0, 0, 0, 0, 105, 122];
    private static readonly uint[] SimdNearest = [0, 0, 0, 0, 0, 0, 0, 0, 106, 148];
    // Shifts by the lanes' bits; floats shift their bits as integers do.
    private static readonly uint[] SimdShl = [107, 107, 139, 139, 171, 171, 203, 203, 171, 203];
    private static readonly uint[] SimdShrS = [108, 108, 140, 140, 172, 172, 204, 204, 172, 204];
    private static readonly uint[] SimdShrU = [109, 109, 141, 141, 173, 173, 205, 205, 173, 205];
    private static readonly uint[] SimdSplat = [15, 15, 16, 16, 17, 17, 18, 18, 19, 20];
    private static readonly uint[] SimdExtract = [21, 22, 24, 25, 27, 27, 29, 29, 31, 33];
    private static readonly uint[] SimdReplace = [23, 23, 26, 26, 28, 28, 30, 30, 32, 34];
    private static readonly uint[] SimdAllTrue = [99, 99, 131, 131, 163, 163, 195, 195, 163, 195];
    private static readonly uint[] SimdBitmask = [100, 100, 132, 132, 164, 164, 196, 196, 164, 196];

    private const uint V128Not = 77;
    private const uint V128And = 78;
    private const uint V128AndNot = 79;
    private const uint V128Or = 80;
    private const uint V128Xor = 81;
    private const uint V128Bitselect = 82;
    private const uint V128AnyTrue = 83;
    private const uint I8x16Swizzle = 14;
    private const uint I8x16AddSaturateUnsigned = 112;

    // A call of one of Vector128's members this lowers, or false.
    private bool EmitIlSimdCall(IMethodSymbol method, List<IlValue> values, List<IlSlot> types)
    {
        var type = method.ContainingType;
        if (Frontend.IsVector128(type))
        {
            return EmitVectorStructMember(method, values);
        }

        if (!Frontend.IsVector128Class(type))
        {
            return false;
        }

        // The lanes the member works on: its vector parameter's, else its
        // result's.
        Lane? lane = method.Parameters.Select(parameter => Frontend.VectorLane(parameter.Type)).FirstOrDefault(found => found is not null)
                     ?? Frontend.VectorLane(method.ReturnType);
        string name = method.Name;
        int count = method.Parameters.Length;
        switch (name)
        {
            case "get_IsHardwareAccelerated":
                code.I32(1);
                FinishCall(WType.I32);
                return true;
            case "As" or "AsByte" or "AsSByte" or "AsInt16" or "AsUInt16" or "AsInt32" or "AsUInt32" or "AsInt64" or "AsUInt64"
                or "AsSingle" or "AsDouble" when count == 1 && lane is not null && Frontend.VectorLane(method.ReturnType) is not null:
                // The same bits.
                PushArguments(ArgumentLocals(method, values, 0));
                FinishCall(WType.V128);
                return true;
            case "AsVector128" or "AsVector128Unsafe" when count == 1 && Frontend.NumericsVectorLanes(method.Parameters[0].Type) is int packed:
                EmitPackVector(ArgumentLocals(method, values, 0)[0], packed, zeroUpper: name == "AsVector128");
                FinishCall(WType.V128);
                return true;
            case "AsVector2" or "AsVector3" or "AsVector4" or "AsQuaternion" or "AsPlane"
                when count == 1 && lane == Lane.F32 && Frontend.NumericsVectorLanes(method.ReturnType) is int unpacked:
                int packedVector = ArgumentLocals(method, values, 0)[0];
                for (int index = 0; index < unpacked; index++)
                {
                    LocalGet(packedVector);
                    code.SimdLane(SimdExtract[(int)Lane.F32], index);
                }

                FinishCall(frontend.MapType(method.ReturnType));
                return true;
        }

        if (lane is not { } l)
        {
            return false;
        }

        if (count == 0 && ExtensionConstant(name, l) is { } constant)
        {
            // Vector128<T>.Pi and the other extension properties: the
            // constant in every lane (SignSequence: 1, -1, 1, ...).
            if (name == "get_SignSequence")
            {
                Span<byte> bytes = stackalloc byte[16];
                int width = Frontend.LaneBytes(l);
                for (int index = 0; index < 16 / width; index++)
                {
                    LaneBytes(l, index % 2 == 0 ? 1 : -1).CopyTo(bytes[(index * width)..]);
                }

                code.V128Const(bytes);
            }
            else
            {
                Span<byte> one = LaneBytes(l, constant);
                Span<byte> bytes = stackalloc byte[16];
                for (int offset = 0; offset < 16; offset += one.Length)
                {
                    one.CopyTo(bytes[offset..]);
                }

                code.V128Const(bytes);
            }

            FinishCall(WType.V128);
            return true;
        }

        int[] arguments;
        switch (name, count)
        {
            case ("Create" or "CreateScalarUnsafe", 1) when Frontend.LaneOf(method.Parameters[0].Type) == l:
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                code.Simd(SimdSplat[(int)l]);
                FinishCall(WType.V128);
                return true;
            case ("Create", 1 or 2) when method.Parameters[0].Type is IArrayTypeSymbol { IsSZArray: true } array
                                         && Frontend.LaneOf(array.ElementType) == l
                                         && (count == 1 || method.Parameters[1].Type.SpecialType == SpecialType.System_Int32):
                EmitArrayLoad(method, values, array, l);
                return true;
            case ("CreateScalar", 1) when Frontend.LaneOf(method.Parameters[0].Type) == l:
                arguments = ArgumentLocals(method, values, 0);
                WType.V128.Default(code);
                LocalGet(arguments[0]);
                code.SimdLane(SimdReplace[(int)l], 0);
                FinishCall(WType.V128);
                return true;
            case ("Create", _) when count == Frontend.LaneCount(l) && count > 1
                                    && method.Parameters.All(parameter => Frontend.LaneOf(parameter.Type) == l):
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                code.Simd(SimdSplat[(int)l]);
                for (int index = 1; index < count; index++)
                {
                    LocalGet(arguments[index]);
                    code.SimdLane(SimdReplace[(int)l], index);
                }

                FinishCall(WType.V128);
                return true;
            case ("Add", 2):
                return EmitSimdBinary(method, values, SimdAdd[(int)l]);
            case ("Subtract", 2):
                return EmitSimdBinary(method, values, SimdSub[(int)l]);
            case ("Multiply", 2):
                return EmitSimdMultiply(method, values, l, SimdMul[(int)l]);
            case ("Divide", 2):
                return EmitSimdMultiply(method, values, l, SimdDiv[(int)l]);
            case ("BitwiseAnd", 2):
                return EmitSimdBinary(method, values, V128And);
            case ("BitwiseOr", 2):
                return EmitSimdBinary(method, values, V128Or);
            case ("Xor", 2):
                return EmitSimdBinary(method, values, V128Xor);
            case ("AndNot", 2):
                return EmitSimdBinary(method, values, V128AndNot);
            case ("Min", 2):
                return EmitSimdBinary(method, values, SimdMin[(int)l]);
            case ("Max", 2):
                return EmitSimdBinary(method, values, SimdMax[(int)l]);
            case ("MinNative", 2):
                return EmitSimdBinary(method, values, SimdPmin[(int)l], swapped: Frontend.IsFloatLane(l));
            case ("MaxNative", 2):
                return EmitSimdBinary(method, values, SimdPmax[(int)l], swapped: Frontend.IsFloatLane(l));
            case ("AddSaturate", 2):
                return EmitSimdBinary(method, values, Frontend.IsFloatLane(l) ? SimdAdd[(int)l] : SimdAddSaturate[(int)l]);
            case ("SubtractSaturate", 2):
                return EmitSimdBinary(method, values, Frontend.IsFloatLane(l) ? SimdSub[(int)l] : SimdSubSaturate[(int)l]);
            case ("Equals", 2):
                return EmitSimdCompare(method, values, l, SimdEq, swapped: false);
            case ("LessThan", 2):
                return EmitSimdCompare(method, values, l, SimdLt, swapped: false);
            case ("LessThanOrEqual", 2):
                return EmitSimdCompare(method, values, l, SimdLe, swapped: false);
            case ("GreaterThan", 2):
                return EmitSimdCompare(method, values, l, SimdLt, swapped: true);
            case ("GreaterThanOrEqual", 2):
                return EmitSimdCompare(method, values, l, SimdLe, swapped: true);
            case ("EqualsAll", 2):
                return EmitSimdAll(method, values, l, SimdEq, swapped: false);
            case ("LessThanAll", 2):
                return EmitSimdAll(method, values, l, SimdLt, swapped: false);
            case ("LessThanOrEqualAll", 2):
                return EmitSimdAll(method, values, l, SimdLe, swapped: false);
            case ("GreaterThanAll", 2):
                return EmitSimdAll(method, values, l, SimdLt, swapped: true);
            case ("GreaterThanOrEqualAll", 2):
                return EmitSimdAll(method, values, l, SimdLe, swapped: true);
            case ("EqualsAny", 2):
                return EmitSimdAny(method, values, l, SimdEq, swapped: false);
            case ("LessThanAny", 2):
                return EmitSimdAny(method, values, l, SimdLt, swapped: false);
            case ("LessThanOrEqualAny", 2):
                return EmitSimdAny(method, values, l, SimdLe, swapped: false);
            case ("GreaterThanAny", 2):
                return EmitSimdAny(method, values, l, SimdLt, swapped: true);
            case ("GreaterThanOrEqualAny", 2):
                return EmitSimdAny(method, values, l, SimdLe, swapped: true);
            case ("ConditionalSelect", 3):
                // (left & condition) | (right & ~condition).
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[1]);
                LocalGet(arguments[2]);
                LocalGet(arguments[0]);
                code.Simd(V128Bitselect);
                FinishCall(WType.V128);
                return true;
            case ("Negate", 1):
                return EmitSimdUnary(method, values, SimdNeg[(int)l]);
            case ("OnesComplement", 1):
                return EmitSimdUnary(method, values, V128Not);
            case ("Abs", 1) when !Frontend.IsSignedLane(l) && !Frontend.IsFloatLane(l):
                // Unsigned: itself.
                PushArguments(ArgumentLocals(method, values, 0));
                FinishCall(WType.V128);
                return true;
            case ("Abs", 1):
                return EmitSimdUnary(method, values, SimdAbs[(int)l]);
            case ("Sqrt", 1):
                return EmitSimdUnary(method, values, SimdSqrt[(int)l]);
            case ("Ceiling", 1):
                return EmitSimdUnary(method, values, SimdCeiling[(int)l]);
            case ("Floor", 1):
                return EmitSimdUnary(method, values, SimdFloor[(int)l]);
            case ("Truncate", 1):
                return EmitSimdUnary(method, values, SimdTruncate[(int)l]);
            case ("Round", 1):
                // To even, as .NET's Round without a mode rounds.
                return EmitSimdUnary(method, values, SimdNearest[(int)l]);
            case ("ShiftLeft", 2):
                return EmitSimdShift(method, values, SimdShl[(int)l]);
            case ("ShiftRightArithmetic", 2):
                return EmitSimdShift(method, values, SimdShrS[(int)l]);
            case ("ShiftRightLogical", 2):
                return EmitSimdShift(method, values, SimdShrU[(int)l]);
            case ("GetElement", 2) when ConstantOf(values[1]) is int index && index >= 0 && index < Frontend.LaneCount(l):
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                code.SimdLane(SimdExtract[(int)l], index);
                FinishCall(Frontend.LaneType(l));
                return true;
            case ("WithElement", 3) when ConstantOf(values[1]) is int index && index >= 0 && index < Frontend.LaneCount(l):
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                LocalGet(arguments[2]);
                code.SimdLane(SimdReplace[(int)l], index);
                FinishCall(WType.V128);
                return true;
            case ("LoadSpan", 2):
                EmitSpanLoad(method, values, l);
                return true;
            case ("GetElementUnsafe", 2):
                arguments = ArgumentLocals(method, values, 0);
                EmitDynamicExtract(arguments[0], arguments[1], l);
                FinishCall(Frontend.LaneType(l));
                return true;
            case ("WithElementUnsafe", 3):
                arguments = ArgumentLocals(method, values, 0);
                EmitDynamicReplace(arguments[0], arguments[1], arguments[2], l);
                FinishCall(WType.V128);
                return true;
            case ("ToScalar", 1):
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                code.SimdLane(SimdExtract[(int)l], 0);
                FinishCall(Frontend.LaneType(l));
                return true;
            case ("ExtractMostSignificantBits", 1):
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                code.Simd(SimdBitmask[(int)l]);
                FinishCall(WType.I32);
                return true;
            case ("Sum", 1) when l is Lane.F32 or Lane.I32 or Lane.U32 or Lane.F64 or Lane.I64 or Lane.U64:
                arguments = ArgumentLocals(method, values, 0);
                EmitSimdSum(arguments[0], l);
                FinishCall(Frontend.LaneType(l));
                return true;
            case ("Dot", 2) when SimdMul[(int)l] != 0 && l is Lane.F32 or Lane.I32 or Lane.U32 or Lane.F64 or Lane.I64 or Lane.U64:
                arguments = ArgumentLocals(method, values, 0);
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Simd(SimdMul[(int)l]);
                EmitSimdSum(Save(WType.V128), l);
                FinishCall(Frontend.LaneType(l));
                return true;
            case ("Shuffle" or "ShuffleNative", 2):
                arguments = ArgumentLocals(method, values, 0);
                EmitSimdShuffle(arguments[0], arguments[1], l);
                FinishCall(WType.V128);
                return true;
            case ("ConvertToSingle", 1) when l is Lane.I32 or Lane.U32:
                return EmitSimdUnary(method, values, l == Lane.I32 ? 250u : 251u);
            case ("ConvertToInt32" or "ConvertToInt32Native", 1) when l == Lane.F32:
                return EmitSimdUnary(method, values, 248);
            case ("ConvertToUInt32" or "ConvertToUInt32Native", 1) when l == Lane.F32:
                return EmitSimdUnary(method, values, 249);
            case ("WidenLower", 1) when EmitSimdWiden(method, values, l, upper: false):
                return true;
            case ("WidenUpper", 1) when EmitSimdWiden(method, values, l, upper: true):
                return true;
            case ("Narrow", 2) when l is not (Lane.F32 or Lane.F64) || l == Lane.F64:
                return EmitSimdNarrow(method, values, l, saturate: false);
            case ("NarrowWithSaturation", 2) when l is Lane.I16 or Lane.U16 or Lane.I32 or Lane.U32:
                return EmitSimdNarrow(method, values, l, saturate: true);
        }

        return false;
    }

    // Vector128<T>'s own members: its constants, operators and the instance
    // members of a value (Equals, the indexer; GetHashCode and ToString are
    // the CoreLib's C#).
    private bool EmitVectorStructMember(IMethodSymbol method, List<IlValue> values)
    {
        var type = method.ContainingType;
        if (Frontend.VectorLane(type) is not { } l)
        {
            return false;
        }

        int[] arguments;
        switch (method.Name, method.Parameters.Length)
        {
            case ("get_Count", 0):
                code.I32(Frontend.LaneCount(l));
                FinishCall(WType.I32);
                return true;
            case ("get_IsSupported", 0):
                code.I32(1);
                FinishCall(WType.I32);
                return true;
            case ("get_Zero", 0):
                WType.V128.Default(code);
                FinishCall(WType.V128);
                return true;
            case ("get_AllBitsSet", 0):
                Span<byte> ones = stackalloc byte[16];
                ones.Fill(0xff);
                code.V128Const(ones);
                FinishCall(WType.V128);
                return true;
            case ("get_One", 0):
                EmitLaneConstant(l, 1);
                code.Simd(SimdSplat[(int)l]);
                FinishCall(WType.V128);
                return true;
            case ("get_Indices", 0):
                EmitIndices(l);
                FinishCall(WType.V128);
                return true;
            case ("op_Addition", 2):
                return EmitSimdBinary(method, values, SimdAdd[(int)l]);
            case ("op_Subtraction", 2):
                return EmitSimdBinary(method, values, SimdSub[(int)l]);
            case ("op_Multiply", 2):
                return EmitSimdMultiply(method, values, l, SimdMul[(int)l]);
            case ("op_Division", 2):
                return EmitSimdMultiply(method, values, l, SimdDiv[(int)l]);
            case ("op_BitwiseAnd", 2):
                return EmitSimdBinary(method, values, V128And);
            case ("op_BitwiseOr", 2):
                return EmitSimdBinary(method, values, V128Or);
            case ("op_ExclusiveOr", 2):
                return EmitSimdBinary(method, values, V128Xor);
            case ("op_UnaryNegation", 1):
                return EmitSimdUnary(method, values, SimdNeg[(int)l]);
            case ("op_OnesComplement", 1):
                return EmitSimdUnary(method, values, V128Not);
            case ("op_UnaryPlus", 1):
                PushArguments(ArgumentLocals(method, values, 0));
                FinishCall(WType.V128);
                return true;
            case ("op_LeftShift", 2):
                return EmitSimdShift(method, values, SimdShl[(int)l]);
            case ("op_RightShift", 2):
                // Arithmetic for signed lanes; for unsigned ones, as C#'s >>
                // of an unsigned integer, logical.
                return EmitSimdShift(method, values, Frontend.IsSignedLane(l) || Frontend.IsFloatLane(l) ? SimdShrS[(int)l] : SimdShrU[(int)l]);
            case ("op_UnsignedRightShift", 2):
                return EmitSimdShift(method, values, SimdShrU[(int)l]);
            case ("op_Equality", 2):
                return EmitSimdAll(method, values, l, SimdEq, swapped: false);
            case ("op_Inequality", 2):
                if (!EmitSimdAll(method, values, l, SimdEq, swapped: false, finish: false))
                {
                    return false;
                }

                code.Byte(0x45); // i32.eqz
                FinishCall(WType.I32);
                return true;
            case ("Equals", 1) when Frontend.VectorLane(method.Parameters[0].Type) == l:
                int self = ReceiverValue(values[0], type);
                int other = ArgumentLocals(method, values, 1)[0];
                EmitVectorEquals(self, other, l);
                FinishCall(WType.I32);
                return true;
            case ("get_Item", 1):
                // Vector128.GetElement's, which checks the index.
                int receiver = ReceiverValue(values[0], type);
                arguments = ArgumentLocals(method, values, 1);
                if (ConstantOf(values[1]) is int constant && constant >= 0 && constant < Frontend.LaneCount(l))
                {
                    LocalGet(receiver);
                    code.SimdLane(SimdExtract[(int)l], constant);
                    FinishCall(Frontend.LaneType(l));
                    return true;
                }

                var getElement = frontend.VectorHelper("GetElement", type.TypeArguments[0]);
                LocalGet(receiver);
                LocalGet(arguments[0]);
                Call(frontend.MethodIndex(getElement));
                FinishCall(Frontend.LaneType(l));
                return true;
            case ("Equals", 1) or ("GetHashCode", 0) or ("ToString", 0):
                // The CoreLib's: Vector128.ObjectEquals, Hash and Format.
                var helper = frontend.VectorHelper(
                    method.Name switch { "Equals" => "ObjectEquals", "GetHashCode" => "Hash", _ => "Format" },
                    type.TypeArguments[0]);
                int value = ReceiverValue(values[0], type);
                arguments = ArgumentLocals(method, values, 1);
                LocalGet(value);
                PushArguments(arguments);
                Call(frontend.MethodIndex(helper));
                FinishCall(frontend.MapType(helper.ReturnType));
                return true;
        }

        return false;
    }

    // Vector128<T>.Equals(Vector128<T>): every lane equal by its element
    // type's Equals, where NaN equals NaN.
    private void EmitVectorEquals(int self, int other, Lane lane)
    {
        LocalGet(self);
        LocalGet(other);
        code.Simd(SimdEq[(int)lane]);
        if (Frontend.IsFloatLane(lane))
        {
            LocalGet(self);
            LocalGet(self);
            code.Simd(SimdNe[(int)lane]);
            LocalGet(other);
            LocalGet(other);
            code.Simd(SimdNe[(int)lane]);
            code.Simd(V128And);
            code.Simd(V128Or);
        }

        code.Simd(SimdAllTrue[(int)lane]);
    }

    // The extension properties' constants (Vector128<float>.Pi, ...), of
    // the element types each is declared for.
    private static double? ExtensionConstant(string name, Lane lane) => (name, Frontend.IsFloatLane(lane), Frontend.IsSignedLane(lane)) switch
    {
        ("get_E", true, _) => Math.E,
        ("get_Pi", true, _) => Math.PI,
        ("get_Tau", true, _) => Math.Tau,
        ("get_Epsilon", true, _) => lane == Lane.F32 ? float.Epsilon : double.Epsilon,
        ("get_NaN", true, _) => double.NaN,
        ("get_NegativeInfinity", true, _) => double.NegativeInfinity,
        ("get_NegativeZero", true, _) => -0.0,
        ("get_PositiveInfinity", true, _) => double.PositiveInfinity,
        ("get_NegativeOne", _, var signed) when signed || Frontend.IsFloatLane(lane) => -1,
        ("get_SignSequence", _, var signed) when signed || Frontend.IsFloatLane(lane) => 1,
        _ => null,
    };

    // A lane's bytes holding a value, rounded to the lane's type as a
    // constant of it would be.
    private static byte[] LaneBytes(Lane lane, double value) => lane switch
    {
        Lane.F32 => BitConverter.GetBytes((float)value),
        Lane.F64 => BitConverter.GetBytes(value),
        Lane.I8 or Lane.U8 => [unchecked((byte)(sbyte)value)],
        Lane.I16 or Lane.U16 => BitConverter.GetBytes((short)value),
        Lane.I32 or Lane.U32 => BitConverter.GetBytes((int)value),
        _ => BitConverter.GetBytes((long)value),
    };

    // Vector128.Create(T[]) and Create(T[], int): the lanes from the
    // elements at the index on, each an array.get (a GC array has no vector
    // load), after .NET's checks: a null array throws
    // NullReferenceException, an index or length leaving too few elements
    // ArgumentOutOfRangeException.
    private void EmitArrayLoad(IMethodSymbol method, List<IlValue> values, IArrayTypeSymbol array, Lane lane)
    {
        int[] arguments = ArgumentLocals(method, values, 0);
        int items = arguments[0];
        int index;
        if (arguments.Length > 1)
        {
            index = arguments[1];
        }
        else
        {
            code.I32(0);
            index = Save(WType.I32);
        }

        int heap = frontend.MapType(array).Heap;
        CheckNull(items);
        LocalGet(index);
        code.I32(0);
        code.Byte(0x48); // i32.lt_s
        LocalGet(items);
        code.Gc(15); // array.len
        LocalGet(index);
        code.Byte(0x6b); // i32.sub
        code.I32(Frontend.LaneCount(lane));
        code.Byte(0x48); // i32.lt_s
        code.Byte(0x72); // i32.or
        FaultIf(FaultCode.ArgumentOutOfRange);
        for (int element = 0; element < Frontend.LaneCount(lane); element++)
        {
            LocalGet(items);
            LocalGet(index);
            if (element > 0)
            {
                code.I32(element);
                code.Byte(0x6a); // i32.add
            }

            code.Gc(11, heap); // array.get
            if (element == 0)
            {
                code.Simd(SimdSplat[(int)lane]);
                int first = Save(WType.V128);
                LocalGet(first);
                continue;
            }

            int value = Save(Frontend.LaneType(lane));
            LocalGet(value);
            code.SimdLane(SimdReplace[(int)lane], element);
        }

        FinishCall(WType.V128);
    }

    // Vector128.LoadSpan (the CoreLib's): the lanes from a span's elements at
    // an offset, which its caller checked: the span's array from its start
    // and the offset on (see runtime/Spans.cs).
    private void EmitSpanLoad(IMethodSymbol method, List<IlValue> values, Lane lane)
    {
        int[] arguments = ArgumentLocals(method, values, 0);
        var spanType = frontend.MapType(method.Parameters[0].Type);
        var layout = frontend.StructOf(spanType);
        int array = arguments[0] + layout.Offsets[layout.Fields.FindIndex(field => field.Name == "array")];
        int start = arguments[0] + layout.Offsets[layout.Fields.FindIndex(field => field.Name == "start")];
        var arrayType = frontend.Leaves(spanType)[layout.Offsets[layout.Fields.FindIndex(field => field.Name == "array")]];
        LocalGet(start);
        LocalGet(arguments[1]);
        code.Byte(0x6a); // i32.add
        int first = Save(WType.I32);
        for (int element = 0; element < Frontend.LaneCount(lane); element++)
        {
            code.OpIndex(0x20, array); // local.get
            LocalGet(first);
            if (element > 0)
            {
                code.I32(element);
                code.Byte(0x6a); // i32.add
            }

            code.Gc(11, arrayType.Heap); // array.get
            if (element == 0)
            {
                code.Simd(SimdSplat[(int)lane]);
            }
            else
            {
                code.SimdLane(SimdReplace[(int)lane], element);
            }
        }

        FinishCall(WType.V128);
    }

    // One instruction over two vectors, or over a vector and its lane type
    // (a scalar operand is splatted, as Vector128's operators with a scalar
    // are defined).
    private bool EmitSimdBinary(IMethodSymbol method, List<IlValue> values, uint opcode, bool swapped = false)
    {
        if (opcode == 0)
        {
            return false;
        }

        int[] arguments = ArgumentLocals(method, values, 0);
        LocalGet(arguments[swapped ? 1 : 0]);
        LocalGet(arguments[swapped ? 0 : 1]);
        code.Simd(opcode);
        FinishCall(WType.V128);
        return true;
    }

    // Multiply and Divide: of two vectors, of a vector and a scalar, or of a
    // scalar and a vector.
    private bool EmitSimdMultiply(IMethodSymbol method, List<IlValue> values, Lane lane, uint opcode)
    {
        if (opcode == 0)
        {
            return false;
        }

        int[] arguments = ArgumentLocals(method, values, 0);
        for (int index = 0; index < 2; index++)
        {
            LocalGet(arguments[index]);
            if (Frontend.VectorLane(method.Parameters[index].Type) is null)
            {
                code.Simd(SimdSplat[(int)lane]);
            }
        }

        code.Simd(opcode);
        FinishCall(WType.V128);
        return true;
    }

    private bool EmitSimdUnary(IMethodSymbol method, List<IlValue> values, uint opcode)
    {
        if (opcode == 0)
        {
            return false;
        }

        PushArguments(ArgumentLocals(method, values, 0));
        code.Simd(opcode);
        FinishCall(WType.V128);
        return true;
    }

    // Shifts by an i32 count, which Wasm takes modulo the lanes' bits, as
    // .NET's Vector128 shifts do.
    private bool EmitSimdShift(IMethodSymbol method, List<IlValue> values, uint opcode)
    {
        PushArguments(ArgumentLocals(method, values, 0));
        code.Simd(opcode);
        FinishCall(WType.V128);
        return true;
    }

    // A comparison's lanes, all ones where it holds. Unsigned 64-bit lanes
    // compare as signed ones with their sign bits flipped.
    private bool EmitSimdCompareLanes(int left, int right, Lane lane, uint[] table, bool swapped)
    {
        if (swapped)
        {
            (left, right) = (right, left);
        }

        if (table[(int)lane] != 0)
        {
            LocalGet(left);
            LocalGet(right);
            code.Simd(table[(int)lane]);
            return true;
        }

        if (lane != Lane.U64)
        {
            return false;
        }

        Span<byte> sign = stackalloc byte[16];
        sign[7] = 0x80;
        sign[15] = 0x80;
        LocalGet(left);
        code.V128Const(sign);
        code.Simd(V128Xor);
        LocalGet(right);
        code.V128Const(sign);
        code.Simd(V128Xor);
        code.Simd(table[(int)Lane.I64]);
        return true;
    }

    private bool EmitSimdCompare(IMethodSymbol method, List<IlValue> values, Lane lane, uint[] table, bool swapped)
    {
        if (table[(int)lane] == 0 && lane != Lane.U64)
        {
            return false;
        }

        int[] arguments = ArgumentLocals(method, values, 0);
        EmitSimdCompareLanes(arguments[0], arguments[1], lane, table, swapped);
        FinishCall(WType.V128);
        return true;
    }

    // Whether the comparison holds of every lane.
    private bool EmitSimdAll(IMethodSymbol method, List<IlValue> values, Lane lane, uint[] table, bool swapped, bool finish = true)
    {
        if (table[(int)lane] == 0 && lane != Lane.U64)
        {
            return false;
        }

        int[] arguments = ArgumentLocals(method, values, 0);
        EmitSimdCompareLanes(arguments[0], arguments[1], lane, table, swapped);
        code.Simd(SimdAllTrue[(int)lane]);
        if (finish)
        {
            FinishCall(WType.I32);
        }

        return true;
    }

    // Whether it holds of any lane.
    private bool EmitSimdAny(IMethodSymbol method, List<IlValue> values, Lane lane, uint[] table, bool swapped)
    {
        if (table[(int)lane] == 0 && lane != Lane.U64)
        {
            return false;
        }

        int[] arguments = ArgumentLocals(method, values, 0);
        EmitSimdCompareLanes(arguments[0], arguments[1], lane, table, swapped);
        code.Simd(V128AnyTrue);
        FinishCall(WType.I32);
        return true;
    }

    // The sum of the lanes, pairs first: (e0 + e1) + (e2 + e3), as the CLR
    // adds a Vector128's halves.
    private void EmitSimdSum(int vector, Lane lane)
    {
        if (Frontend.LaneBytes(lane) == 8)
        {
            LocalGet(vector);
            code.SimdLane(SimdExtract[(int)lane], 0);
            LocalGet(vector);
            code.SimdLane(SimdExtract[(int)lane], 1);
            code.Byte(lane == Lane.F64 ? (byte)0xa0 : (byte)0x7c); // f64.add / i64.add
            return;
        }

        // Each lane plus its neighbour: [e0 + e1, e1 + e0, e2 + e3, e3 + e2].
        LocalGet(vector);
        LocalGet(vector);
        LocalGet(vector);
        code.Shuffle([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]);
        code.Simd(SimdAdd[(int)lane]);
        int pairs = Save(WType.V128);
        LocalGet(pairs);
        code.SimdLane(SimdExtract[(int)lane], 0);
        LocalGet(pairs);
        code.SimdLane(SimdExtract[(int)lane], 2);
        code.Byte(lane == Lane.F32 ? (byte)0x92 : (byte)0x6a); // f32.add / i32.add
    }

    // A lane chosen at run time: the vector's bytes moved so that the lane
    // is the first (i8x16.swizzle), then the first lane.
    private void EmitDynamicExtract(int vector, int index, Lane lane)
    {
        LocalGet(vector);
        EmitLaneBytes(index, lane);
        code.Simd(I8x16Swizzle);
        code.SimdLane(SimdExtract[(int)lane], 0);
    }

    // The byte indices of lane `index` repeated in every lane: its first
    // byte's offset, plus 0, 1, ... within each lane.
    private void EmitLaneBytes(int index, Lane lane)
    {
        int width = Frontend.LaneBytes(lane);
        LocalGet(index);
        code.I32(width);
        code.Byte(0x6c); // i32.mul
        code.Simd(SimdSplat[(int)Lane.I8]);
        Span<byte> offsets = stackalloc byte[16];
        for (int b = 0; b < 16; b++)
        {
            offsets[b] = (byte)(b % width);
        }

        code.V128Const(offsets);
        code.Simd(SimdAdd[(int)Lane.I8]);
    }

    // A vector with lane `index` replaced: the value splatted where the
    // lane's index is, the vector elsewhere.
    private void EmitDynamicReplace(int vector, int index, int value, Lane lane)
    {
        LocalGet(value);
        code.Simd(SimdSplat[(int)lane]);
        LocalGet(vector);
        EmitIndices(IntegerLane(lane));
        LocalGet(index);
        if (Frontend.LaneBytes(lane) == 8)
        {
            code.Byte(0xac); // i64.extend_i32_s
        }

        code.Simd(SimdSplat[(int)IntegerLane(lane)]);
        code.Simd(SimdEq[(int)IntegerLane(lane)]);
        code.Simd(V128Bitselect);
    }

    private static Lane IntegerLane(Lane lane) => Frontend.LaneBytes(lane) switch
    {
        1 => Lane.I8,
        2 => Lane.I16,
        4 => Lane.I32,
        _ => Lane.I64,
    };

    // The vector 0, 1, 2, ... of the lanes' type.
    private void EmitIndices(Lane lane)
    {
        Span<byte> bytes = stackalloc byte[16];
        int width = Frontend.LaneBytes(lane);
        for (int index = 0; index < 16 / width; index++)
        {
            switch (lane)
            {
                case Lane.F32:
                    BitConverter.TryWriteBytes(bytes[(index * 4)..], (float)index);
                    break;
                case Lane.F64:
                    BitConverter.TryWriteBytes(bytes[(index * 8)..], (double)index);
                    break;
                default:
                    bytes[index * width] = (byte)index;
                    break;
            }
        }

        code.V128Const(bytes);
    }

    private void EmitLaneConstant(Lane lane, long value)
    {
        switch (Frontend.LaneType(lane))
        {
            case var t when t == WType.I64:
                code.I64(value);
                break;
            case var t when t == WType.F32:
                code.F32Const(value);
                break;
            case var t when t == WType.F64:
                code.F64Const(value);
                break;
            default:
                code.I32(unchecked((int)value));
                break;
        }
    }

    // Vector128.Shuffle: element i is vector[indices[i]], or zero where the
    // index is out of range, by i8x16.swizzle of each index's bytes (an
    // out-of-range index's are 0xff, which select zero).
    private void EmitSimdShuffle(int vector, int indices, Lane lane)
    {
        int width = Frontend.LaneBytes(lane);
        var integer = IntegerLane(lane);
        LocalGet(vector);
        if (width == 1)
        {
            LocalGet(indices);
            code.Simd(I8x16Swizzle);
            return;
        }

        // In range: 0 <= index < count, as unsigned lanes compare.
        int count = Frontend.LaneCount(lane);
        LocalGet(indices);
        code.I32(width switch { 2 => 1, 4 => 2, _ => 3 }); // the lane's first byte
        code.Simd(SimdShl[(int)integer]);
        if (width == 8)
        {
            LocalGet(indices);
            code.I64(0);
            code.Simd(SimdSplat[(int)Lane.I64]);
            code.Simd(SimdGe[(int)Lane.I64]);
            LocalGet(indices);
            code.I64(count);
            code.Simd(SimdSplat[(int)Lane.I64]);
            code.Simd(SimdLt[(int)Lane.I64]);
            code.Simd(V128And);
        }
        else
        {
            LocalGet(indices);
            EmitLaneConstant(integer, count);
            code.Simd(SimdSplat[(int)integer]);
            code.Simd(SimdLt[(int)(width == 2 ? Lane.U16 : Lane.U32)]);
        }

        code.Simd(V128Not);
        code.Simd(V128Or);
        // Each lane's first byte in all of its bytes, plus 0, 1, ...
        Span<byte> spread = stackalloc byte[16];
        Span<byte> offsets = stackalloc byte[16];
        for (int b = 0; b < 16; b++)
        {
            spread[b] = (byte)(b / width * width);
            offsets[b] = (byte)(b % width);
        }

        code.V128Const(spread);
        code.Simd(I8x16Swizzle);
        code.V128Const(offsets);
        code.Simd(I8x16AddSaturateUnsigned);
        code.Simd(I8x16Swizzle);
    }

    // WidenLower and WidenUpper: the lower or upper half's lanes extended
    // to twice their width.
    private bool EmitSimdWiden(IMethodSymbol method, List<IlValue> values, Lane lane, bool upper)
    {
        uint opcode = lane switch
        {
            Lane.I8 => upper ? 136u : 135u,
            Lane.U8 => upper ? 138u : 137u,
            Lane.I16 => upper ? 168u : 167u,
            Lane.U16 => upper ? 170u : 169u,
            Lane.I32 => upper ? 200u : 199u,
            Lane.U32 => upper ? 202u : 201u,
            Lane.F32 => 95, // f64x2.promote_low_f32x4
            _ => 0,
        };
        if (opcode == 0)
        {
            return false;
        }

        int[] arguments = ArgumentLocals(method, values, 0);
        LocalGet(arguments[0]);
        if (lane == Lane.F32 && upper)
        {
            LocalGet(arguments[0]);
            code.Shuffle([8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15]);
        }

        code.Simd(opcode);
        FinishCall(WType.V128);
        return true;
    }

    // Narrow: each lane of the two vectors truncated to half its width,
    // the first's lanes first; with saturation, clamped to the narrower
    // type's range instead (i16x8 and i32x4's narrowing instructions, whose
    // input is signed, so an unsigned input is clamped first).
    private bool EmitSimdNarrow(IMethodSymbol method, List<IlValue> values, Lane lane, bool saturate)
    {
        int[] arguments = ArgumentLocals(method, values, 0);
        if (lane == Lane.F64)
        {
            // f32x4.demote_f64x2_zero of each, then their lower halves.
            LocalGet(arguments[0]);
            code.Simd(94);
            LocalGet(arguments[1]);
            code.Simd(94);
            code.Shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
            FinishCall(WType.V128);
            return true;
        }

        int width = Frontend.LaneBytes(lane);
        if (saturate)
        {
            for (int index = 0; index < 2; index++)
            {
                LocalGet(arguments[index]);
                if (lane is Lane.U16 or Lane.U32)
                {
                    EmitLaneConstant(lane, lane == Lane.U16 ? 0xff : 0xffff);
                    code.Simd(SimdSplat[(int)lane]);
                    code.Simd(SimdMin[(int)lane]);
                }
            }

            code.Simd(lane switch
            {
                Lane.I16 => 101u,
                Lane.U16 => 102u,
                Lane.I32 => 133u,
                _ => 134u,
            });
            FinishCall(WType.V128);
            return true;
        }

        // The lower half of each lane's bytes, from both vectors.
        Span<byte> lanes = stackalloc byte[16];
        int half = width / 2;
        int position = 0;
        for (int source = 0; source < 32; source += width)
        {
            for (int b = 0; b < half; b++)
            {
                lanes[position++] = (byte)(source + b);
            }
        }

        LocalGet(arguments[0]);
        LocalGet(arguments[1]);
        code.Shuffle(lanes);
        FinishCall(WType.V128);
        return true;
    }

    // A System.Numerics vector's float leaves as a Vector128<float>: the
    // first splatted, the others in their lanes; AsVector128 of a Vector2
    // or Vector3 zeroes the lanes it has none for, AsVector128Unsafe leaves
    // them what the splat made.
    private void EmitPackVector(int vector, int lanes, bool zeroUpper)
    {
        if (zeroUpper && lanes < 4)
        {
            WType.V128.Default(code);
            for (int index = 0; index < lanes; index++)
            {
                code.OpIndex(0x20, vector + index); // local.get
                code.SimdLane(SimdReplace[(int)Lane.F32], index);
            }

            return;
        }

        code.OpIndex(0x20, vector); // local.get
        code.Simd(SimdSplat[(int)Lane.F32]);
        for (int index = 1; index < lanes; index++)
        {
            code.OpIndex(0x20, vector + index); // local.get
            code.SimdLane(SimdReplace[(int)Lane.F32], index);
        }
    }
}
