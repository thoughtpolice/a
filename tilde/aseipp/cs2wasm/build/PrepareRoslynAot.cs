// MSBuild task fragment. See README.md in this directory for the upstream
// contracts repaired here and the equivalent Native AOT diagnostic fallback.
using (var assembly = AssemblyDefinition.ReadAssembly(InputAssembly))
{
    var module = assembly.MainModule;
    var versionAttribute = assembly.CustomAttributes.Single(attribute =>
        attribute.AttributeType.FullName == "System.Reflection.AssemblyInformationalVersionAttribute");
    var version = versionAttribute.ConstructorArguments[0].Value as string;
    if (version != "5.9.0-1.26357.3+35d9211b841e7613c1d2f8f5af6d628ace696c4c")
    {
        throw new InvalidOperationException("Review Roslyn AOT annotations for dependency version " + version);
    }

    var runtime = module.AssemblyReferences.Single(reference => reference.Name == "System.Runtime");
    var attributeType = new TypeReference(
        "System.Diagnostics.CodeAnalysis",
        "DynamicallyAccessedMembersAttribute",
        module,
        runtime);
    var memberTypes = new TypeReference(
        "System.Diagnostics.CodeAnalysis",
        "DynamicallyAccessedMemberTypes",
        module,
        runtime,
        true);
    var attributeConstructor = new MethodReference(".ctor", module.TypeSystem.Void, attributeType)
    {
        HasThis = true
    };
    attributeConstructor.Parameters.Add(new ParameterDefinition(memberTypes));

    void PreserveDefaultConstructor(GenericParameter parameter)
    {
        if (parameter.CustomAttributes.Any(existingAttribute =>
            existingAttribute.AttributeType.FullName == attributeType.FullName))
        {
            throw new InvalidOperationException("Roslyn already annotates " + parameter.FullName);
        }

        var attribute = new CustomAttribute(attributeConstructor);
        // DynamicallyAccessedMemberTypes.PublicParameterlessConstructor = 1.
        attribute.ConstructorArguments.Add(new CustomAttributeArgument(memberTypes, 1));
        parameter.CustomAttributes.Add(attribute);
    }

    // The overloads without a factory call the framework's reflective default
    // constructor overloads. Factory-taking overloads need no preservation.
    var lazyInitializer = module.GetType("Roslyn.Utilities.RoslynLazyInitializer");
    var initializers = lazyInitializer.Methods.Where(method =>
        method.Name == "EnsureInitialized"
        && (method.Parameters.Count == 1 || method.Parameters.Count == 3)).ToArray();
    if (initializers.Length != 2)
    {
        throw new InvalidOperationException("Unexpected Roslyn lazy initializer overloads.");
    }

    foreach (var method in initializers)
    {
        PreserveDefaultConstructor(method.GenericParameters.Single());
    }

    var pooledDelegates = module.GetType("Microsoft.CodeAnalysis.PooledObjects.PooledDelegates");
    var createValueCallback = pooledDelegates.Methods.Single(method =>
        method.Name == "GetPooledCreateValueCallback");
    PreserveDefaultConstructor(createValueCallback.GenericParameters.Single(parameter => parameter.Name == "TValue"));

    var boundCallback = pooledDelegates.NestedTypes.Single(type =>
        type.Name == "CreateValueCallbackWithBoundArgument`3");
    PreserveDefaultConstructor(boundCallback.GenericParameters.Single(parameter => parameter.Name == "TValue"));

    var commonCompiler = module.GetType("Microsoft.CodeAnalysis.CommonCompiler");
    var getAssemblyLocation = commonCompiler.Methods.Single(method =>
        method.Name == "GetAssemblyLocation"
        && method.Parameters.Count == 1
        && method.Parameters[0].ParameterType.FullName == "System.Type");
    bool readsAssemblyLocation = getAssemblyLocation.Body.Instructions.Any(instruction =>
        instruction.Operand is MethodReference reference
        && reference.DeclaringType.FullName == "System.Reflection.Assembly"
        && reference.Name == "get_Location");
    if (!readsAssemblyLocation)
    {
        throw new InvalidOperationException("Review Roslyn's assembly-location implementation.");
    }

    // Assembly.Location is always empty in Native AOT. Roslyn already maps an
    // empty location to this string for its '#error version' diagnostic.
    getAssemblyLocation.Body = new MethodBody(getAssemblyLocation);
    var instructions = getAssemblyLocation.Body.GetILProcessor();
    instructions.Emit(OpCodes.Ldstr, "<unknown>");
    instructions.Emit(OpCodes.Ret);

    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(OutputAssembly)));

    // Keep assembly identity for references, but do not claim that this private
    // AOT input copy still has Microsoft's original strong-name signature.
    module.Attributes &= ~ModuleAttributes.StrongNameSigned;
    assembly.Write(OutputAssembly, new WriterParameters { DeterministicMvid = true });
}
