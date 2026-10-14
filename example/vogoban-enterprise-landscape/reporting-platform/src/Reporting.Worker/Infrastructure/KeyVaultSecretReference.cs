using Microsoft.Extensions.Configuration;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// Reads the App Service style <c>@Microsoft.KeyVault(SecretUri=...)</c> values this repository
/// declares under <c>ConnectionStrings</c>, so the vault and the secret behind each connection
/// are reported at startup rather than only being declared in configuration.
/// </summary>
public static class KeyVaultSecretReference
{
    private const string Prefix = "@Microsoft.KeyVault(SecretUri=";

    public static string? ResolveSecretName(IConfiguration configuration, string connectionStringName)
    {
        var segments = ReadSecretUri(configuration, connectionStringName)?.AbsolutePath.Trim('/').Split('/');

        return segments is { Length: > 1 } && string.Equals(segments[0], "secrets", StringComparison.OrdinalIgnoreCase)
            ? segments[1]
            : null;
    }

    public static Uri? ResolveVaultUri(IConfiguration configuration, string connectionStringName)
    {
        var secretUri = ReadSecretUri(configuration, connectionStringName);

        return secretUri is null ? null : new Uri(secretUri.GetLeftPart(UriPartial.Authority));
    }

    private static Uri? ReadSecretUri(IConfiguration configuration, string connectionStringName)
    {
        var value = configuration.GetConnectionString(connectionStringName);

        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var secretUri = value[Prefix.Length..].TrimEnd(')', ' ');

        return Uri.TryCreate(secretUri, UriKind.Absolute, out var uri) ? uri : null;
    }
}
