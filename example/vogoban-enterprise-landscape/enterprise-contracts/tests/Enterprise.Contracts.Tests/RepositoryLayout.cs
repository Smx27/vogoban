using System.Text.Json;

namespace Vg.Enterprise.Contracts.Tests;

/// <summary>
/// Locates the repository root so tests can read the checked-in contract
/// artifacts (JSON Schemas, the AsyncAPI document and the TypeScript package)
/// rather than a copy of them.
/// </summary>
internal static class RepositoryLayout
{
    public static string Root { get; } = Discover();

    public static string SchemaRoot => Path.Combine(Root, "contracts");

    public static string SchemaPath(string contractId) =>
        Path.Combine(SchemaRoot, contractId.Replace('/', Path.DirectorySeparatorChar) + ".schema.json");

    public static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    private static string Discover()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "contracts")) &&
                Directory.Exists(Path.Combine(directory.FullName, "dotnet")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException(
            $"Could not locate the enterprise-contracts repository root above {AppContext.BaseDirectory}.");
    }
}
