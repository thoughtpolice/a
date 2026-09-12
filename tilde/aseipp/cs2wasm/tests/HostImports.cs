// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

// Keep the ordinary methods ahead of the import declarations. Wasm places all
// imports before defined functions, regardless of C# declaration order.
public static class HostImports
{
    public static int ConstructionOrder()
    {
        var value = new HostInitialized(HostApi.Trace(1)) { First = HostApi.Trace(5) };
        return value.ConstructorValue * 10 + value.First;
    }

    public static int ImplicitInitializer() => new ImplicitHostInitialized().Value;

    public static bool HostFlag() => HostApi.ReadFlag();

    public static double MixedAbi(int value, bool enabled, float scale, double offset)
        => MixedHelper(value, enabled, scale, offset);

    private static double MixedHelper(int value, bool enabled, float scale, double offset)
        => HostApi.Mix(value, enabled, scale, offset);

    public static double ForwardHostFlag() => HostApi.Mix(2, HostApi.ReadFlag(), 1.25f, 0.5);

    public static double NamedArgumentOrder() => HostApi.Mix(
        offset: HostApi.Trace(1),
        scale: HostApi.Trace(2),
        enabled: HostApi.ReadFlag(),
        value: HostApi.Trace(3));

    public static float FloatResult() => HostApi.FloatSample();

    public static int IntegerResult(int value) => HostApi.Trace(value);

    public static void Send(int value) => HostApi.Notify(value);
}

public sealed class HostInitialized
{
    public int First = HostApi.Trace(2);
    public int Second = HostApi.Trace(3);
    public int ConstructorValue;

    public HostInitialized(int argument)
    {
        ConstructorValue = First * 1000 + Second * 100 + argument * 10 + HostApi.Trace(4);
    }
}

public sealed class ImplicitHostInitialized
{
    public int Value = HostApi.Trace(6);
}

// Public import declarations describe host capabilities; they must not become
// public Wasm exports themselves.
public static class HostApi
{
    [Gameplay.WasmImport("test", "trace")]
    public static extern int Trace(int value);

    [Gameplay.WasmImport("test", "flag")]
    public static extern bool ReadFlag();

    [Gameplay.WasmImport("test", "mix")]
    public static extern double Mix(int value, bool enabled, float scale, double offset);

    // Supplementary Unicode characters must survive UTF-8 name encoding.
    [Gameplay.WasmImport("test", "float-sample-\U0001f3ae")]
    public static extern float FloatSample();

    [Gameplay.WasmImport("test", "notify")]
    public static extern void Notify(int value);
}
