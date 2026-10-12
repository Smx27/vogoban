using System.Runtime.CompilerServices;
using Microsoft.Build.Locator;

namespace Vogoban.Roslyn;

public sealed class EvaluatedFramework
{
    public required string TargetFramework { get; init; }
    public List<string> Compile { get; init; } = new();
    public List<string> Usings { get; init; } = new();
    public List<string> DefineConstants { get; init; } = new();
    public List<PackageUse> PackageReferences { get; init; } = new();
    public List<string> ProjectReferences { get; init; } = new();
    public List<string> FrameworkReferences { get; init; } = new();
    public string? LangVersion { get; init; }
    public string? Nullable { get; init; }
    public string? OutputType { get; init; }
    public string? AssemblyName { get; init; }
    public string? ProjectAssetsFile { get; init; }
    public List<string> InternalsVisibleTo { get; init; } = new();
}

public sealed class PackageUse
{
    public required string Name { get; init; }
    public string? Version { get; init; }
}

public static class MsBuildEvaluation
{
    private static string? _unavailable;
    private static bool _registered;

    public static string? Initialize()
    {
        if (_registered || _unavailable != null) return _unavailable;
        try
        {
            var runtimeMajor = Environment.Version.Major;
            var instance = MSBuildLocator.QueryVisualStudioInstances()
                .Where(i => i.Version.Major <= runtimeMajor)
                .OrderByDescending(i => i.Version)
                .FirstOrDefault();
            if (instance == null) return _unavailable = $"no .NET SDK compatible with runtime {runtimeMajor} found for MSBuild evaluation";
            Environment.SetEnvironmentVariable("MSBuildSDKsPath", Path.Combine(instance.MSBuildPath, "Sdks"));
            Environment.SetEnvironmentVariable("MSBuildExtensionsPath", instance.MSBuildPath);
            Environment.SetEnvironmentVariable("MSBUILD_EXE_PATH", Path.Combine(instance.MSBuildPath, "MSBuild.dll"));
            MSBuildLocator.RegisterInstance(instance);
            _registered = true;
            return null;
        }
        catch (Exception ex)
        {
            return _unavailable = $"MSBuild evaluation unavailable: {ex.Message}";
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static EvaluatedFramework Evaluate(string projectPath, string targetFramework) => Evaluator.Evaluate(projectPath, targetFramework);

    private static class Evaluator
    {
        private static readonly Microsoft.Build.Evaluation.ProjectCollection Collection = new();

        public static EvaluatedFramework Evaluate(string projectPath, string targetFramework)
        {
            var globals = new Dictionary<string, string>
            {
                ["TargetFramework"] = targetFramework,
                ["Configuration"] = "Debug",
                ["DesignTimeBuild"] = "true",
            };
            var project = new Microsoft.Build.Evaluation.Project(projectPath, globals, null, Collection, Microsoft.Build.Evaluation.ProjectLoadSettings.IgnoreMissingImports | Microsoft.Build.Evaluation.ProjectLoadSettings.IgnoreInvalidImports);
            try
            {
                var dir = Path.GetDirectoryName(projectPath)!;
                string Full(string include) => Path.GetFullPath(Path.Combine(dir, include));
                var central = project.GetItems("PackageVersion").ToDictionary(i => i.EvaluatedInclude, i => i.GetMetadataValue("Version"), StringComparer.OrdinalIgnoreCase);
                return new EvaluatedFramework
                {
                    TargetFramework = targetFramework,
                    Compile = project.GetItems("Compile").Select(i => Full(i.EvaluatedInclude)).Where(p => p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList(),
                    Usings = project.GetItems("Using")
                        .Where(i => string.IsNullOrEmpty(i.GetMetadataValue("Alias")) && !string.Equals(i.GetMetadataValue("Static"), "true", StringComparison.OrdinalIgnoreCase))
                        .Select(i => i.EvaluatedInclude).Distinct().OrderBy(u => u, StringComparer.Ordinal).ToList(),
                    DefineConstants = project.GetPropertyValue("DefineConstants").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct().ToList(),
                    PackageReferences = project.GetItems("PackageReference")
                        .Select(i => new PackageUse
                        {
                            Name = i.EvaluatedInclude,
                            Version = NullIfEmpty(i.GetMetadataValue("Version")) ?? (central.TryGetValue(i.EvaluatedInclude, out var v) ? NullIfEmpty(v) : null),
                        })
                        .GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).Select(g => g.First()).OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList(),
                    ProjectReferences = project.GetItems("ProjectReference").Select(i => Full(i.EvaluatedInclude)).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList(),
                    FrameworkReferences = project.GetItems("FrameworkReference").Select(i => i.EvaluatedInclude).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList(),
                    LangVersion = NullIfEmpty(project.GetPropertyValue("LangVersion")),
                    Nullable = NullIfEmpty(project.GetPropertyValue("Nullable")),
                    OutputType = NullIfEmpty(project.GetPropertyValue("OutputType")),
                    AssemblyName = NullIfEmpty(project.GetPropertyValue("AssemblyName")),
                    ProjectAssetsFile = NullIfEmpty(project.GetPropertyValue("ProjectAssetsFile")),
                    InternalsVisibleTo = string.Equals(project.GetPropertyValue("GenerateAssemblyInfo"), "false", StringComparison.OrdinalIgnoreCase)
                        ? new()
                        : project.GetItems("InternalsVisibleTo").Select(i => i.EvaluatedInclude).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList(),
                };
            }
            finally
            {
                Collection.UnloadProject(project);
            }
        }

        private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
