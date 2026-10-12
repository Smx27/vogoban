using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;

namespace Vogoban.Roslyn;

public sealed record TargetFramework(string Moniker, string Family, Version Version)
{
    public static TargetFramework Parse(string moniker)
    {
        var tfm = moniker.Trim().ToLowerInvariant();
        var platformless = tfm.Split('-')[0];
        var standard = Regex.Match(platformless, @"^netstandard(\d+)\.(\d+)$");
        if (standard.Success) return new(tfm, "netstandard", new Version(int.Parse(standard.Groups[1].Value), int.Parse(standard.Groups[2].Value)));
        var core = Regex.Match(platformless, @"^netcoreapp(\d+)\.(\d+)$");
        if (core.Success) return new(tfm, "netcoreapp", new Version(int.Parse(core.Groups[1].Value), int.Parse(core.Groups[2].Value)));
        var modern = Regex.Match(platformless, @"^net(\d+)\.(\d+)$");
        if (modern.Success) return new(tfm, "net", new Version(int.Parse(modern.Groups[1].Value), int.Parse(modern.Groups[2].Value)));
        var framework = Regex.Match(platformless, @"^net(\d)(\d)(\d?)$");
        if (framework.Success)
            return new(tfm, "netframework", new Version(int.Parse(framework.Groups[1].Value), int.Parse(framework.Groups[2].Value), framework.Groups[3].Value == "" ? 0 : int.Parse(framework.Groups[3].Value)));
        return new(tfm, "unknown", new Version(0, 0));
    }

    public bool IsCoreLike => Family is "net" or "netcoreapp";

    public List<string> PreprocessorSymbols()
    {
        var symbols = new List<string>();
        switch (Family)
        {
            case "net":
            case "netcoreapp":
                symbols.AddRange(new[] { "NET", "NETCOREAPP" });
                symbols.Add(Family == "net" ? $"NET{Version.Major}_{Version.Minor}" : $"NETCOREAPP{Version.Major}_{Version.Minor}");
                for (var major = 5; major <= Version.Major; major++) symbols.Add($"NET{major}_0_OR_GREATER");
                foreach (var (maj, min) in new[] { (1, 0), (1, 1), (2, 0), (2, 1), (2, 2), (3, 0), (3, 1) })
                    if (new Version(maj, min) <= Version || Family == "net") symbols.Add($"NETCOREAPP{maj}_{min}_OR_GREATER");
                break;
            case "netstandard":
                symbols.AddRange(new[] { "NETSTANDARD", $"NETSTANDARD{Version.Major}_{Version.Minor}" });
                foreach (var (maj, min) in new[] { (1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (2, 0), (2, 1) })
                    if (new Version(maj, min) <= Version) symbols.Add($"NETSTANDARD{maj}_{min}_OR_GREATER");
                break;
            case "netframework":
                symbols.AddRange(new[] { "NETFRAMEWORK", $"NET{Version.Major}{Version.Minor}{(Version.Build > 0 ? Version.Build.ToString() : "")}" });
                break;
        }
        return symbols.Distinct().ToList();
    }
}

public sealed record ReferenceSet(List<MetadataReference> References, string Label, bool Exact);

public static class References
{
    private static readonly Dictionary<string, ReferenceSet> PackCache = new();
    private static readonly Dictionary<string, MetadataReference> FileCache = new();

    public static string? DotnetRoot()
    {
        var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory().TrimEnd(Path.DirectorySeparatorChar);
        var root = Directory.GetParent(runtimeDir)?.Parent?.Parent?.FullName;
        return root != null && Directory.Exists(Path.Combine(root, "packs")) ? root : null;
    }

    private static Version ParseVersion(string name) => Version.TryParse(name.Split('-')[0], out var v) ? v : new Version(0, 0);

    public static ReferenceSet ForPack(string packName, TargetFramework tfm)
    {
        var cacheKey = $"{packName}|{tfm.Moniker}";
        if (PackCache.TryGetValue(cacheKey, out var cached)) return cached;
        var result = Resolve(packName, tfm);
        PackCache[cacheKey] = result;
        return result;
    }

    private static ReferenceSet Resolve(string packName, TargetFramework tfm)
    {
        var fromCache = FromNuGetCache(packName, tfm);
        var fromSdk = FromSdkPacks(packName, tfm);
        if (fromSdk is { Exact: true }) return fromSdk;
        if (fromCache != null) return fromCache;
        if (fromSdk != null) return fromSdk;
        if (packName != "Microsoft.NETCore.App") return new ReferenceSet(new(), $"{packName} (unavailable)", false);
        var tpa = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? "").Split(Path.PathSeparator);
        var fallback = tpa.Where(p => p.EndsWith(".dll") && (Path.GetFileName(p).StartsWith("System") || p.EndsWith("netstandard.dll") || p.EndsWith("mscorlib.dll")))
            .OrderBy(p => p, StringComparer.Ordinal).Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        return new ReferenceSet(fallback, "runtime-trusted-platform-assemblies", false);
    }

    private static ReferenceSet? FromNuGetCache(string packName, TargetFramework tfm)
    {
        if (!(tfm.IsCoreLike || tfm.Family == "netstandard")) return null;
        var dir = Path.Combine(NuGetCache(), $"{packName}.ref".ToLowerInvariant());
        if (!Directory.Exists(dir)) return null;
        var moniker = tfm.Moniker.Split('-')[0];
        var match = Directory.GetDirectories(dir)
            .Select(d => (dir: d, version: ParseVersion(Path.GetFileName(d))))
            .Where(v => v.version.Major == tfm.Version.Major && v.version.Minor == tfm.Version.Minor && Directory.Exists(Path.Combine(v.dir, "ref", moniker)))
            .OrderByDescending(v => v.version)
            .FirstOrDefault();
        if (match.dir == null) return null;
        var refs = Directory.GetFiles(Path.Combine(match.dir, "ref", moniker), "*.dll").OrderBy(f => f, StringComparer.Ordinal).Select(f => (MetadataReference)MetadataReference.CreateFromFile(f)).ToList();
        return new ReferenceSet(refs, $"nuget:{packName}.Ref/{Path.GetFileName(match.dir)}/{moniker}", true);
    }

    private static ReferenceSet? FromSdkPacks(string packName, TargetFramework tfm)
    {
        var root = DotnetRoot();
        var packDir = root == null ? null : Path.Combine(root, "packs", $"{packName}.Ref");
        if (packDir != null && Directory.Exists(packDir))
        {
            var versions = Directory.GetDirectories(packDir).Select(d => (dir: d, version: ParseVersion(Path.GetFileName(d)))).OrderByDescending(v => v.version).ToList();
            var desired = tfm.IsCoreLike || tfm.Family == "netstandard" ? tfm.Version : new Version(int.MaxValue, 0);
            var match = versions.FirstOrDefault(v => v.version.Major == desired.Major && v.version.Minor == desired.Minor);
            var exact = match.dir != null && (tfm.IsCoreLike || tfm.Family == "netstandard");
            if (match.dir == null) match = versions.FirstOrDefault(v => v.version <= desired);
            if (match.dir == null) match = versions.LastOrDefault();
            if (match.dir != null && Directory.Exists(Path.Combine(match.dir, "ref")))
            {
                var refDirs = Directory.GetDirectories(Path.Combine(match.dir, "ref")).OrderByDescending(d => d, StringComparer.Ordinal).ToList();
                var refDir = refDirs.FirstOrDefault(d => Path.GetFileName(d) == tfm.Moniker.Split('-')[0]) ?? refDirs.FirstOrDefault();
                if (refDir != null)
                {
                    var refs = Directory.GetFiles(refDir, "*.dll").OrderBy(f => f, StringComparer.Ordinal).Select(f => (MetadataReference)MetadataReference.CreateFromFile(f)).ToList();
                    exact &= Path.GetFileName(refDir) == tfm.Moniker.Split('-')[0];
                    return new ReferenceSet(refs, $"{packName}.Ref/{Path.GetFileName(match.dir)}/{Path.GetFileName(refDir)}", exact);
                }
            }
        }
        return null;
    }

    private static string NuGetCache() =>
        Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");

    private static ReferenceSet? FromReferenceAssemblyPackage(TargetFramework tfm)
    {
        string? dir = null;
        string label = "";
        if (tfm.Family == "netframework")
        {
            var package = Path.Combine(NuGetCache(), $"microsoft.netframework.referenceassemblies.{tfm.Moniker}");
            var version = Directory.Exists(package) ? Directory.GetDirectories(package).OrderByDescending(d => ParseVersion(Path.GetFileName(d))).FirstOrDefault() : null;
            var frameworkDir = version == null ? null : Path.Combine(version, "build", ".NETFramework", $"v{tfm.Version.Major}.{tfm.Version.Minor}{(tfm.Version.Build > 0 ? $".{tfm.Version.Build}" : "")}");
            if (frameworkDir != null && Directory.Exists(frameworkDir)) (dir, label) = (frameworkDir, $"nuget:Microsoft.NETFramework.ReferenceAssemblies.{tfm.Moniker}/{Path.GetFileName(version)}");
        }
        else if (tfm.Family == "netstandard" && tfm.Version < new Version(2, 1))
        {
            var package = Path.Combine(NuGetCache(), "netstandard.library");
            var version = Directory.Exists(package) ? Directory.GetDirectories(package).OrderByDescending(d => ParseVersion(Path.GetFileName(d))).FirstOrDefault(d => ParseVersion(Path.GetFileName(d)).Major == 2) : null;
            var refDir = version == null ? null : Path.Combine(version, "build", tfm.Moniker, "ref");
            if (refDir != null && Directory.Exists(refDir)) (dir, label) = (refDir, $"nuget:NETStandard.Library/{Path.GetFileName(version)}/{tfm.Moniker}");
        }
        if (dir == null) return null;
        var files = Directory.GetFiles(dir, "*.dll").ToList();
        if (Directory.Exists(Path.Combine(dir, "Facades"))) files.AddRange(Directory.GetFiles(Path.Combine(dir, "Facades"), "*.dll"));
        var refs = files.Where(IsAssembly).OrderBy(f => f, StringComparer.Ordinal).Select(f => (MetadataReference)MetadataReference.CreateFromFile(f)).ToList();
        return new ReferenceSet(refs, label, true);
    }

    public static ReferenceSet Platform(TargetFramework tfm, IEnumerable<string> frameworkReferences)
    {
        if (FromReferenceAssemblyPackage(tfm) is { } packaged) return packaged;
        var basePack = tfm.Family == "netstandard" ? "NETStandard.Library" : "Microsoft.NETCore.App";
        var core = ForPack(basePack, tfm);
        if (basePack == "NETStandard.Library" && core.References.Count == 0) core = ForPack("Microsoft.NETCore.App", tfm);
        var refs = new List<MetadataReference>(core.References);
        var labels = new List<string> { core.Label };
        var exact = core.Exact;
        foreach (var fw in frameworkReferences.Where(f => f != "Microsoft.NETCore.App" && tfm.Family != "netstandard"))
        {
            var set = ForPack(fw, tfm);
            refs.AddRange(set.References);
            labels.Add(set.Label);
            exact &= set.Exact;
        }
        return new ReferenceSet(refs, string.Join(", ", labels), exact);
    }

    private static bool IsAssembly(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            using var pe = new System.Reflection.PortableExecutable.PEReader(stream);
            return pe.HasMetadata && System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe).IsAssembly;
        }
        catch
        {
            return false;
        }
    }

    public static MetadataReference? ForFile(string path)
    {
        if (FileCache.TryGetValue(path, out var cached)) return cached;
        if (!File.Exists(path)) return null;
        var reference = MetadataReference.CreateFromFile(path);
        FileCache[path] = reference;
        return reference;
    }
}
