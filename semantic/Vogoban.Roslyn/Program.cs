using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Vogoban.Roslyn;

var json = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = false,
};

void Log(object payload) => Console.Error.WriteLine(JsonSerializer.Serialize(payload, json));

var request = JsonSerializer.Deserialize<AnalysisRequest>(Console.In.ReadToEnd(), json)
    ?? throw new InvalidOperationException("empty analysis request");
var root = RepositoryFiles.NormalizeRoot(request.RepositoryRoot);
var maxSourceBytes = request.MaxSourceFileBytes is > 0 and var configured ? configured : RepositoryFiles.DefaultMaxSourceFileBytes;
var excludedSources = (request.ExcludedSourcePatterns ?? new()).Select(pattern => new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToList();
var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = false };

var byId = request.Projects.ToDictionary(p => p.Id);
var order = new List<ProjectRequest>();
var state = new Dictionary<string, int>();
void Visit(ProjectRequest p)
{
    if (state.ContainsKey(p.Id)) return;
    state[p.Id] = 1;
    foreach (var dep in p.ProjectReferences.Where(byId.ContainsKey)) Visit(byId[dep]);
    order.Add(p);
}
foreach (var p in request.Projects) Visit(p);

var compilations = new Dictionary<(string Project, string Tfm), CSharpCompilation>();

CSharpCompilation? DependencyCompilation(string projectId, TargetFramework tfm)
{
    if (!byId.TryGetValue(projectId, out var dep)) return null;
    var candidates = dep.Frameworks.Select(f => f.TargetFramework).ToList();
    var choice = candidates.FirstOrDefault(c => c == tfm.Moniker)
        ?? candidates.FirstOrDefault(c => TargetFramework.Parse(c).Family == "netstandard")
        ?? candidates.FirstOrDefault();
    return choice != null && compilations.TryGetValue((projectId, choice), out var c) ? c : null;
}

foreach (var project in order)
{
    var started = DateTime.UtcNow;
    var perFramework = new List<(string Tfm, ProjectResult Result)>();
    var merged = new ProjectResult { ProjectId = project.Id, AssemblyName = project.AssemblyName };
    try
    {
        var frameworks = project.Frameworks.Count > 0 ? project.Frameworks : new List<FrameworkRequest> { new("net8.0", new()) };
        var evaluationUnavailable = Environment.GetEnvironmentVariable("VOGOBAN_MSBUILD_EVALUATION") == "0" ? "disabled" : MsBuildEvaluation.Initialize();
        var texts = new Dictionary<string, string>(StringComparer.Ordinal);
        var admitted = new Dictionary<string, bool>(StringComparer.Ordinal);
        string Rel(string full) => full.StartsWith(root) ? Path.GetRelativePath(root, full).Replace('\\', '/') : full;
        bool Admit(string full)
        {
            if (admitted.TryGetValue(full, out var ok)) return ok;
            if (excludedSources.Any(pattern => pattern.IsMatch(Rel(full)))) return admitted[full] = false;
            var rejection = RepositoryFiles.Validate(root, full, maxSourceBytes);
            if (rejection != null && !merged.SkippedSources.Any(s => s.File == Rel(full)))
            {
                merged.SkippedSources.Add(new SkippedSource { File = Rel(full), Code = rejection.Code, Reason = rejection.Reason });
                Log(new { @event = "roslyn.source-skipped", project = project.Name, file = Rel(full), code = rejection.Code, reason = rejection.Reason });
            }
            return admitted[full] = rejection == null;
        }
        string? Text(string full)
        {
            if (texts.TryGetValue(full, out var t)) return t;
            if (!Admit(full)) return null;
            return texts[full] = File.ReadAllText(full);
        }
        var staticFiles = project.Files.Select(f => Path.GetFullPath(Path.Combine(root, f))).ToList();
        var projectRejection = RepositoryFiles.Validate(root, Path.Combine(root, project.ProjectPath), long.MaxValue);
        if (projectRejection != null) evaluationUnavailable ??= $"project file rejected: {projectRejection.Reason}";

        foreach (var framework in frameworks)
        {
            var tfm = TargetFramework.Parse(framework.TargetFramework);
            EvaluatedFramework? evaluated = null;
            string? evaluationError = evaluationUnavailable;
            if (evaluationUnavailable == null)
            {
                try
                {
                    evaluated = MsBuildEvaluation.Evaluate(Path.Combine(root, project.ProjectPath), framework.TargetFramework);
                }
                catch (Exception ex)
                {
                    evaluationError = $"{ex.GetType().Name}: {ex.Message.Split('\n')[0]}";
                }
            }
            var files = (evaluated?.Compile.Where(f => RepositoryFiles.Inside(root, f) != null).ToList() ?? staticFiles).Where(Admit).ToList();
            var globalUsings = evaluated?.Usings ?? project.GlobalUsings;
            var nullable = evaluated?.Nullable ?? project.Nullable;
            var outputType = evaluated?.OutputType ?? project.OutputType;
            var defines = project.DefineConstants.Concat(evaluated?.DefineConstants ?? new()).Concat(new[] { "TRACE" }).Concat(tfm.PreprocessorSymbols()).Distinct().OrderBy(d => d, StringComparer.Ordinal).ToList();
            var languageVersion = evaluated?.LangVersion != null && LanguageVersionFacts.TryParse(evaluated.LangVersion, out var parsed) ? parsed : LanguageVersion.Preview;
            var parseOptions = new CSharpParseOptions(languageVersion, DocumentationMode.None, SourceCodeKind.Regular, defines);
            var trees = files.Select(f => (full: f, text: Text(f))).Where(f => f.text != null).Select(f => CSharpSyntaxTree.ParseText(f.text!, parseOptions, f.full)).ToList();
            var generatedPrelude = globalUsings.Select(u => $"global using global::{u};")
                .Concat((evaluated?.InternalsVisibleTo ?? new()).Select(n => $"[assembly: global::System.Runtime.CompilerServices.InternalsVisibleTo(\"{n}\")]"))
                .ToList();
            if (generatedPrelude.Count > 0)
                trees.Add(CSharpSyntaxTree.ParseText(string.Join('\n', generatedPrelude), parseOptions, ""));
            foreach (var generated in project.GeneratedSources ?? new())
                trees.Add(CSharpSyntaxTree.ParseText(generated, parseOptions, ""));
            Log(new { @event = "roslyn.project-loaded", project = project.Name, targetFramework = tfm.Moniker, evaluation = evaluated != null ? "msbuild" : "static", sources = trees.Count, evaluationError });

            var transitiveFrameworks = new SortedSet<string>(project.FrameworkReferences.Concat(evaluated?.FrameworkReferences ?? new()), StringComparer.Ordinal);
            var frameworkStack = new Stack<string>(project.ProjectReferences);
            var frameworkSeen = new HashSet<string>();
            while (frameworkStack.Count > 0)
            {
                var dep = frameworkStack.Pop();
                if (!frameworkSeen.Add(dep) || !byId.TryGetValue(dep, out var depProject)) continue;
                transitiveFrameworks.UnionWith(depProject.FrameworkReferences);
                foreach (var next in depProject.ProjectReferences) frameworkStack.Push(next);
            }
            var platform = References.Platform(tfm, transitiveFrameworks);
            var references = new List<MetadataReference>(platform.References);
            var frameworkAssemblies = new HashSet<string>(references.OfType<PortableExecutableReference>().Select(r => Path.GetFileNameWithoutExtension(r.FilePath ?? "")), StringComparer.OrdinalIgnoreCase);
            var packageAssemblies = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var assetsFile = evaluated?.ProjectAssetsFile is { } assets && RepositoryFiles.Inside(root, assets) is { } insideAssets && RepositoryFiles.Validate(root, insideAssets, long.MaxValue) == null ? insideAssets : null;
            var packageReferencePaths = framework.ReferencePaths.Count > 0 ? framework.ReferencePaths : Assets.CompileReferences(assetsFile, tfm) ?? new List<string>();
            var restored = framework.ReferencePaths.Count > 0 || assetsFile != null;
            foreach (var path in packageReferencePaths)
            {
                var name = Path.GetFileNameWithoutExtension(path);
                if (!frameworkAssemblies.Contains(name)) packageAssemblies[name] = path;
            }
            foreach (var path in packageAssemblies.Values)
                if (References.ForFile(path) is { } r) references.Add(r);

            var transitive = new SortedSet<string>(StringComparer.Ordinal);
            var pending = new Stack<string>(project.ProjectReferences);
            while (pending.Count > 0)
            {
                var dep = pending.Pop();
                if (!transitive.Add(dep) || !byId.TryGetValue(dep, out var depProject)) continue;
                foreach (var next in depProject.ProjectReferences) pending.Push(next);
            }
            var projectReferenceIds = new Dictionary<MetadataReference, string>();
            foreach (var dep in transitive)
            {
                if (DependencyCompilation(dep, tfm) is not { } depCompilation) continue;
                var reference = depCompilation.ToMetadataReference();
                projectReferenceIds[reference] = dep;
                references.Add(reference);
            }

            var options = new CSharpCompilationOptions(
                outputType.Equals("Exe", StringComparison.OrdinalIgnoreCase) || outputType.Equals("WinExe", StringComparison.OrdinalIgnoreCase)
                    ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: nullable?.ToLowerInvariant() switch
                {
                    "enable" => NullableContextOptions.Enable,
                    "warnings" => NullableContextOptions.Warnings,
                    "annotations" => NullableContextOptions.Annotations,
                    _ => NullableContextOptions.Disable,
                },
                allowUnsafe: true,
                concurrentBuild: true,
                deterministic: true);
            var compilation = CSharpCompilation.Create(project.AssemblyName, trees, references.Distinct(), options);
            compilations[(project.Id, framework.TargetFramework)] = compilation;
            Log(new { @event = "roslyn.compilation-created", project = project.Name, targetFramework = tfm.Moniker, references = references.Count, referencePack = platform.Label, exact = platform.Exact });

            var result = new ProjectResult { ProjectId = project.Id, AssemblyName = project.AssemblyName };
            var platformAssemblyNames = new HashSet<string>(
                platform.References.Select(r => compilation.GetAssemblyOrModuleSymbol(r)).OfType<IAssemblySymbol>().Select(a => a.Identity.Name),
                StringComparer.Ordinal);
            new ProjectAnalyzer(compilation, root, result, platformAssemblyNames).Run();
            SecretArguments.Redact(result);
            var context = new FrameworkContext
            {
                TargetFramework = tfm.Moniker,
                ReferencePack = platform.Label,
                ExactReferencePack = platform.Exact,
                PreprocessorSymbols = defines,
                Evaluation = evaluated != null ? "msbuild" : "static",
                EvaluationError = evaluationError,
                AdditionalSourceFiles = files.Except(staticFiles).Select(Rel).OrderBy(f => f, StringComparer.Ordinal).ToList(),
                OmittedSourceFiles = staticFiles.Except(files).Select(Rel).OrderBy(f => f, StringComparer.Ordinal).ToList(),
                PackageReferences = evaluated?.PackageReferences,
                Restored = restored,
                CompilerErrors = result.CompilerErrors,
                CompilerWarnings = result.CompilerWarnings,
            };
            var referenced = new HashSet<string>(StringComparer.Ordinal);
            void Note(SymRef? r)
            {
                if (r == null) return;
                if (r.Assembly != null) referenced.Add(r.Assembly);
                Note(r.ContainingType);
                r.TypeArguments?.ForEach(Note);
            }
            foreach (var rel in result.Relations) Note(rel.Target);
            foreach (var inv in result.Invocations) Note(inv.Target);
            foreach (var symbol in result.Symbols)
            {
                Note(symbol.ReturnType);
                symbol.Parameters.ForEach(p => Note(p.Type));
                symbol.Attributes.ForEach(a => Note(a.Type));
            }
            foreach (var reference in compilation.References)
            {
                if (compilation.GetAssemblyOrModuleSymbol(reference) is not IAssemblySymbol assembly || !referenced.Contains(assembly.Identity.Name)) continue;
                var path = (reference as PortableExecutableReference)?.FilePath;
                var source = projectReferenceIds.ContainsKey(reference) ? "project"
                    : path != null && frameworkAssemblies.Contains(Path.GetFileNameWithoutExtension(path)) && !packageAssemblies.ContainsValue(path) ? "framework"
                    : path != null && packageAssemblies.ContainsValue(path) ? "package" : "file";
                context.UsedAssemblies.Add(new AssemblyUse
                {
                    Name = assembly.Identity.Name,
                    Version = assembly.Identity.Version.ToString(),
                    Source = source,
                    Path = source == "package" ? path : null,
                    ProjectId = projectReferenceIds.TryGetValue(reference, out var pid) ? pid : null,
                });
            }
            context.UsedAssemblies.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            merged.Frameworks.Add(context);
            perFramework.Add((tfm.Moniker, result));
        }
        FrameworkMerge.Into(merged, perFramework);
        merged.Success = true;
    }
    catch (Exception ex)
    {
        merged.Success = false;
        merged.Error = $"{ex.GetType().Name}: {ex.Message}";
    }
    Log(new
    {
        @event = "roslyn.project-analyzed",
        project = project.Name,
        frameworks = merged.Frameworks.Select(f => f.TargetFramework),
        ms = (int)(DateTime.UtcNow - started).TotalMilliseconds,
        success = merged.Success,
        symbols = merged.Symbols.Count,
        relations = merged.Relations.Count,
        unresolved = merged.Unresolved.Count,
        skippedSources = merged.SkippedSources.Count,
        compilerErrors = merged.CompilerErrors,
    });
    stdout.WriteLine(JsonSerializer.Serialize(merged, json));
    stdout.Flush();
}
