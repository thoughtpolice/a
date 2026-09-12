namespace Demo;

public sealed class Vec3
{
    public float X;
    public float Y;
    public float Z;

    public float LengthSquared() => X * X + Y * Y + Z * Z;
}

public static class Gameplay
{
    public static int SumSquares(int n)
    {
        int[] values = new int[n];
        for (int i = 0; i < n; i++)
            values[i] = i * i;
        int total = 0;
        for (int i = 0; i < values.Length; i++)
            total = total + values[i];
        return total;
    }

    public static float VectorLengthSquared(float x, float y, float z)
    {
        var v = new Vec3 { X = x, Y = y, Z = z };
        return v.LengthSquared();
    }

    public static int LoopForever()
    {
        while (true) { }
    }
}
