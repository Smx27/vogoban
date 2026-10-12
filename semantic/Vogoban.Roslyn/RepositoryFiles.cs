namespace Vogoban.Roslyn;

/// <summary>
/// The authoritative repository filesystem boundary for every file the analyzer reads: discovered sources, MSBuild-evaluated
/// Compile items, the project file itself and restore outputs. A file is readable only when its normalized path lies inside
/// the repository root by path-segment boundary, no component below the root is a symbolic link or other reparse point, it is
/// a regular file, and it does not exceed the source size limit. Nothing is read before validation succeeds.
/// </summary>
public static class RepositoryFiles
{
    public const long DefaultMaxSourceFileBytes = 8L * 1024 * 1024;

    public sealed record Rejection(string Path, string Code, string Reason);

    public static string NormalizeRoot(string repositoryRoot)
    {
        var full = System.IO.Path.GetFullPath(repositoryRoot).TrimEnd(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar);
        var info = new DirectoryInfo(full);
        if (info.LinkTarget != null && info.ResolveLinkTarget(true) is DirectoryInfo target) full = target.FullName.TrimEnd(System.IO.Path.DirectorySeparatorChar);
        return full + System.IO.Path.DirectorySeparatorChar;
    }

    /// <summary>Full path when <paramref name="candidate"/> is inside <paramref name="root"/> (which must end with a separator), null otherwise.</summary>
    public static string? Inside(string root, string candidate)
    {
        string full;
        try
        {
            full = System.IO.Path.GetFullPath(candidate);
        }
        catch
        {
            return null;
        }
        return full.Length > root.Length && full.StartsWith(root, StringComparison.Ordinal) ? full : null;
    }

    public static Rejection? Validate(string root, string candidate, long maxBytes = DefaultMaxSourceFileBytes)
    {
        if (candidate.IndexOf('\0') >= 0) return new Rejection(candidate, "source-outside-repository", "path contains a NUL character");
        var full = Inside(root, candidate);
        if (full == null) return new Rejection(candidate, "source-outside-repository", "path resolves outside the repository root");
        var relative = full.Substring(root.Length);
        var current = root.TrimEnd(System.IO.Path.DirectorySeparatorChar);
        foreach (var segment in relative.Split(System.IO.Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = System.IO.Path.Combine(current, segment);
            if (new FileInfo(current).LinkTarget != null || new DirectoryInfo(current).LinkTarget != null)
                return new Rejection(full, "source-symlink", $"symbolic links are not followed ({segment})");
            if (!File.Exists(current) && !Directory.Exists(current)) return new Rejection(full, "source-missing", "file does not exist");
            if (new FileInfo(current).Attributes is var attributes && attributes != (FileAttributes)(-1) && (attributes & FileAttributes.ReparsePoint) != 0)
                return new Rejection(full, "source-symlink", $"symbolic links are not followed ({segment})");
        }
        var file = new FileInfo(full);
        if (!file.Exists || (file.Attributes & (FileAttributes.Device | FileAttributes.Directory)) != 0) return new Rejection(full, "source-outside-repository", "not a regular file");
        if (file.Length > maxBytes) return new Rejection(full, "FILE_SKIPPED_RESOURCE_LIMIT", $"file size {file.Length} bytes exceeds the source limit of {maxBytes} bytes");
        return null;
    }
}
