// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#nullable enable

using System.Globalization;
using System.Reflection;
using System.Text.Json;

// A deliberately small CLR oracle: reflect over the actual fixture methods,
// invoke them with the supplied inputs, and serialize results or exceptions.
// It contains no copy of their algorithms or their expected answers.
if (args.Length != 1)
    throw new ArgumentException("Usage: Gameplay.Reference <requests.json>");

using JsonDocument requests = JsonDocument.Parse(File.ReadAllText(args[0]));
foreach (JsonElement request in requests.RootElement.EnumerateArray())
{
    string methodName = request.GetProperty("method").GetString()
        ?? throw new InvalidDataException("Missing method name.");
    int separator = methodName.LastIndexOf('.');
    Type type = Assembly.GetExecutingAssembly().GetType(methodName[..separator], throwOnError: true)!;
    MethodInfo method = type.GetMethod(methodName[(separator + 1)..], BindingFlags.Public | BindingFlags.Static)
        ?? throw new MissingMethodException(methodName);
    ParameterInfo[] parameters = method.GetParameters();
    JsonElement[] arguments = request.GetProperty("args").EnumerateArray().ToArray();
    if (arguments.Length != parameters.Length)
        throw new InvalidDataException($"Argument count mismatch for {methodName}.");

    object[] values = arguments.Select((argument, index) => ParseArgument(
        argument.GetString() ?? throw new InvalidDataException("Arguments must be strings."),
        parameters[index].ParameterType)).ToArray();

    Outcome outcome;
    try
    {
        object? result = method.Invoke(null, values);
        outcome = new Outcome("value", EncodeValue(result), null);
    }
    catch (TargetInvocationException exception) when (exception.InnerException is not null)
    {
        outcome = new Outcome("exception", null, exception.InnerException.GetType().Name);
    }

    Console.WriteLine(JsonSerializer.Serialize(outcome));
}

static object ParseArgument(string value, Type type)
{
    if (type == typeof(int))
        return int.Parse(value, CultureInfo.InvariantCulture);
    if (type == typeof(bool))
        return value == "1";
    if (type == typeof(float))
        return float.Parse(value, CultureInfo.InvariantCulture);
    if (type == typeof(double))
        return double.Parse(value, CultureInfo.InvariantCulture);
    throw new NotSupportedException($"Unsupported oracle input type: {type}.");
}

static string EncodeValue(object? value) => value switch
{
    null => "void",
    bool boolean => boolean ? "i32:1" : "i32:0",
    int integer => "i32:" + integer.ToString(CultureInfo.InvariantCulture),
    float number => EncodeFloatingPoint(number),
    double number => EncodeFloatingPoint(number),
    _ => throw new NotSupportedException($"Unsupported oracle result type: {value.GetType()}.")
};

static string EncodeFloatingPoint(double value)
{
    // NaN payloads are unspecified; all other bits, including -0, must match.
    if (double.IsNaN(value))
        return "f64:NaN";
    return "f64:" + BitConverter.DoubleToUInt64Bits(value).ToString("x16", CultureInfo.InvariantCulture);
}

internal sealed record Outcome(string Kind, string? Value, string? Exception);
