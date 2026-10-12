using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vogoban.Roslyn;

public static class Assets
{
    public static List<string>? CompileReferences(string? assetsFile, TargetFramework tfm)
    {
        if (assetsFile == null || !File.Exists(assetsFile)) return null;
        using var doc = JsonDocument.Parse(File.ReadAllText(assetsFile));
        var root = doc.RootElement;
        if (!root.TryGetProperty("targets", out var targets)) return null;
        var target = targets.EnumerateObject().FirstOrDefault(t => !t.Name.Contains('/') && Matches(t.Name, tfm));
        if (target.Value.ValueKind != JsonValueKind.Object) return null;
        var folders = root.TryGetProperty("packageFolders", out var pf) ? pf.EnumerateObject().Select(p => p.Name).ToList() : new List<string>();
        var libraries = root.GetProperty("libraries");
        var result = new List<string>();
        foreach (var lib in target.Value.EnumerateObject())
        {
            if (!lib.Value.TryGetProperty("type", out var type) || type.GetString() != "package") continue;
            if (!lib.Value.TryGetProperty("compile", out var compile)) continue;
            var libPath = libraries.TryGetProperty(lib.Name, out var info) && info.TryGetProperty("path", out var p) ? p.GetString() : null;
            if (libPath == null) continue;
            foreach (var file in compile.EnumerateObject().Select(c => c.Name).Where(n => n.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)))
            {
                var full = folders.Select(f => Path.Combine(f, libPath, file)).FirstOrDefault(File.Exists);
                if (full != null) result.Add(full);
            }
        }
        result.Sort(StringComparer.Ordinal);
        return result;
    }

    private static bool Matches(string key, TargetFramework tfm)
    {
        var k = key.ToLowerInvariant();
        if (k == tfm.Moniker || k.StartsWith(tfm.Moniker + "-")) return true;
        var v = tfm.Version;
        return tfm.Family switch
        {
            "net" or "netcoreapp" => k == $".netcoreapp,version=v{v.Major}.{v.Minor}",
            "netstandard" => k == $".netstandard,version=v{v.Major}.{v.Minor}",
            "netframework" => Regex.IsMatch(k, $@"^\.netframework,version=v{v.Major}\.{v.Minor}{(v.Build > 0 ? $@"\.{v.Build}" : "")}$"),
            _ => false,
        };
    }
}
