using System.Text.Json.Serialization;

namespace Vogoban.Roslyn;

public sealed record AnalysisRequest(string RepositoryRoot, List<ProjectRequest> Projects, long? MaxSourceFileBytes = null);

public sealed record ProjectRequest(
    string Id,
    string Name,
    string ProjectPath,
    string AssemblyName,
    string Directory,
    List<string> Files,
    List<string> ProjectReferences,
    List<FrameworkRequest> Frameworks,
    List<string> FrameworkReferences,
    List<string> GlobalUsings,
    List<string> DefineConstants,
    string? Nullable,
    string OutputType,
    List<string>? GeneratedSources = null);

public sealed record FrameworkRequest(string TargetFramework, List<string> ReferencePaths);

public sealed class SymRef
{
    public required string Key { get; init; }
    public required string Display { get; init; }
    public required string QualifiedName { get; init; }
    public required string Kind { get; init; }
    public string? Assembly { get; init; }
    public bool External { get; init; }
    public SymRef? ContainingType { get; init; }
    public List<SymRef>? TypeArguments { get; init; }
}

public sealed class Location
{
    public required string File { get; init; }
    public int Line { get; init; }
    public int Column { get; init; }
    public int EndLine { get; init; }
    public int EndColumn { get; init; }
}

public sealed class ArgValue
{
    public string? Name { get; init; }
    public string? Parameter { get; set; }
    public Location? Location { get; init; }
    public List<SymRef>? TypeArguments { get; init; }
    public List<AttributeFact>? Attributes { get; init; }
    public SymRef? ReturnedType { get; set; }
    public required string Kind { get; init; }
    public string? Value { get; set; }
    public SymRef? Symbol { get; init; }
    public SymRef? Type { get; init; }
    public List<ArgValue>? Items { get; init; }
}

public sealed class AttributeFact
{
    public required SymRef Type { get; init; }
    public List<ArgValue> Arguments { get; init; } = new();
    public Location? Location { get; init; }
    public bool? Unbound { get; init; }
}

public sealed class ParameterFact
{
    public required string Name { get; init; }
    public int Ordinal { get; init; }
    public SymRef? Type { get; init; }
    public string TypeDisplay { get; init; } = "";
    public string? RefKind { get; init; }
    public bool IsParams { get; init; }
    public bool HasDefault { get; init; }
    public List<AttributeFact> Attributes { get; init; } = new();
}

public sealed class SymbolFact
{
    public required string Key { get; init; }
    public required string Kind { get; init; }
    public required string Name { get; init; }
    public required string QualifiedName { get; init; }
    public required string Signature { get; init; }
    public string? ContainerKey { get; init; }
    public required string Namespace { get; init; }
    public Location? Location { get; init; }
    public List<Location> AdditionalLocations { get; init; } = new();
    public required string Accessibility { get; init; }
    public List<string> Modifiers { get; init; } = new();
    public SymRef? ReturnType { get; init; }
    public string? ReturnTypeDisplay { get; init; }
    public List<ParameterFact> Parameters { get; init; } = new();
    public List<AttributeFact> Attributes { get; init; } = new();
    public List<AttributeFact>? ReturnAttributes { get; init; }
    public List<string> BaseTypeChain { get; init; } = new();
    public List<string> AllInterfaces { get; init; } = new();
    public int Arity { get; init; }
    public bool Generated { get; init; }
    public bool Implicit { get; init; }
    public List<string>? Conditions { get; init; }
    public List<string>? TargetFrameworks { get; set; }
}

public sealed class RelationFact
{
    public required string Type { get; init; }
    public required string Source { get; init; }
    public required SymRef Target { get; init; }
    public List<Location> Locations { get; init; } = new();
    public int Count { get; set; } = 1;
    public List<string>? TargetFrameworks { get; set; }
}

public sealed class InvocationFact
{
    public required string Caller { get; init; }
    public required SymRef Target { get; init; }
    public List<SymRef> TypeArguments { get; init; } = new();
    public List<ArgValue> Arguments { get; init; } = new();
    public ReceiverFact? Receiver { get; init; }
    public SymRef? ReceiverType { get; init; }
    public string? ControlFlow { get; init; }
    public string? Condition { get; init; }
    public required Location Location { get; init; }
}

public sealed class ReceiverFact
{
    public string? Expression { get; init; }
    public SymRef? Type { get; init; }
    public SymRef? InvocationTarget { get; init; }
    public List<SymRef>? InvocationTypeArguments { get; init; }
    public Location? Location { get; init; }
    public List<ArgValue>? InvocationArguments { get; init; }
    public ReceiverFact? Receiver { get; init; }
    public SymRef? Symbol { get; init; }
}

public sealed class AssignmentFact
{
    public required string Caller { get; init; }
    public required SymRef Member { get; init; }
    public required ArgValue Value { get; init; }
    public required Location Location { get; init; }
}

public sealed class UnresolvedFact
{
    public required string Type { get; init; }
    public required string Source { get; init; }
    public required string Display { get; init; }
    public required string Reason { get; init; }
    public List<string> Candidates { get; init; } = new();
    public required Location Location { get; init; }
    public string? DiagnosticId { get; init; }
    public string? CascadedFrom { get; init; }
    public List<string>? TargetFrameworks { get; set; }
}

public sealed class CompilerDiagnostic
{
    public required string Id { get; init; }
    public required string Severity { get; init; }
    public required string Message { get; init; }
    public string? File { get; init; }
    public int Line { get; init; }
}

public sealed class AssemblyUse
{
    public required string Name { get; init; }
    public required string Version { get; init; }
    public required string Source { get; init; }
    public string? Path { get; init; }
    public string? ProjectId { get; init; }
}

public sealed class FrameworkContext
{
    public required string TargetFramework { get; init; }
    public required string ReferencePack { get; init; }
    public bool ExactReferencePack { get; init; }
    public List<string> PreprocessorSymbols { get; init; } = new();
    public required string Evaluation { get; init; }
    public string? EvaluationError { get; init; }
    public List<string> AdditionalSourceFiles { get; init; } = new();
    public List<string> OmittedSourceFiles { get; init; } = new();
    public List<PackageUse>? PackageReferences { get; init; }
    public bool Restored { get; init; }
    public int CompilerErrors { get; set; }
    public int CompilerWarnings { get; set; }
    public List<AssemblyUse> UsedAssemblies { get; init; } = new();
}

public sealed class SkippedSource
{
    public required string File { get; init; }
    public required string Code { get; init; }
    public required string Reason { get; init; }
}

public sealed class ProjectResult
{
    public required string ProjectId { get; init; }
    public required string AssemblyName { get; init; }
    public bool Success { get; set; }
    public string? Error { get; set; }
    public List<string> ReferenceSources { get; init; } = new();
    public List<FrameworkContext> Frameworks { get; init; } = new();
    public int CompilerErrors { get; set; }
    public int CompilerWarnings { get; set; }
    public List<CompilerDiagnostic> Diagnostics { get; init; } = new();
    public List<SymbolFact> Symbols { get; init; } = new();
    public List<RelationFact> Relations { get; init; } = new();
    public List<InvocationFact> Invocations { get; init; } = new();
    public List<InvocationFact>? Creations { get; set; }
    public List<AssignmentFact>? Assignments { get; set; }
    public List<UnresolvedFact> Unresolved { get; init; } = new();
    public List<SkippedSource> SkippedSources { get; init; } = new();
}
