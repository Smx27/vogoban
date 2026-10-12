using System.Text.RegularExpressions;

namespace Vogoban.Roslyn;

/// <summary>
/// Value-level secret filter applied to every string constant before it leaves the analyzer (the TypeScript side applies the
/// same rules again, in src/infrastructure/common.ts redactSecretText, before anything is persisted). Connection strings keep
/// their non-secret pairs and lose every secret pair; URLs and bare query strings lose user information and secret query
/// parameters; known credential shapes and opaque key material are replaced entirely.
/// </summary>
public static class Redaction
{
    private static readonly Regex SecretLike = new(
        @"(password|passwd|pwd|secret|token|apikey|api[_-]?key|accountkey|sharedaccesskey|client[_-]?secret|bearer\s|-----BEGIN|AKIA[0-9A-Z]{16})",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CredentialShape = new(
        @"^(eyJ[\w-]+\.[\w-]+\.|-----BEGIN |AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_|xox[baprs]-|sk-[A-Za-z0-9]{20,}|SharedAccessSignature |Bearer [A-Za-z0-9._~+/=\-]{16,}$)",
        RegexOptions.Compiled);
    private static readonly Regex OpaqueBlob = new(@"^[A-Za-z0-9+/=_\-]{32,}$", RegexOptions.Compiled);
    private static readonly Regex LettersOnly = new(@"^[A-Za-z_\-]+$", RegexOptions.Compiled);
    private static readonly Regex Base64Key = new(@"^[A-Za-z0-9+/]{40,}={0,2}$", RegexOptions.Compiled);
    private static readonly Regex HexKey = new(@"^[0-9a-fA-F]{40,}$", RegexOptions.Compiled);
    private static readonly Regex AzureClientSecret = new(@"^(?=.*~)[A-Za-z0-9._~\-]{34,48}$", RegexOptions.Compiled);
    private static readonly Regex Identifier = new(@"^[A-Za-z_][A-Za-z0-9_.:\-/]{0,127}$", RegexOptions.Compiled);
    private static readonly Regex Scheme = new(@"^[a-z][a-z0-9+.\-]*://", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ConnectionPair = new(@"(^|;)(\s*)([^;=]+?)(\s*=\s*)([^;]*)", RegexOptions.Compiled);
    private static readonly Regex ConnectionString = new(
        @"(^|;)\s*(server|host|data ?source|endpoint|accountname|address|addr|user ?id|uid|username|password|pwd|initial catalog|database|sharedaccesskey|accountkey|filename|trusted_connection|integrated security)\s*=",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex SecretPairKey = new(@"(password|passwd|pwd|secret|token|signature|sig|key|credential|sas)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex SecretQueryKey = new(@"(key|token|sig|signature|password|passwd|pwd|secret|code|sas|credential|auth|authorization|access_token|id_token|refresh_token)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex QueryStringShape = new(@"^(?:[\w.%\-]+=[^&\s]*)(?:&[\w.%\-]+=[^&\s]*)+$", RegexOptions.Compiled);
    private static readonly Regex QuerySecretMarker = new(@"(^|&)(sig|signature|token|key|secret|code|sas)=", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex UserInfo = new(@"^([a-z][a-z0-9+.\-]*://)[^/@\s]+@", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex StringLiteral = new("@?\\$?\"(?:[^\"\\\\]|\\\\.)*\"", RegexOptions.Compiled);
    private static readonly Regex RawStringLiteral = new("\\$?@?\"\"\"[\\s\\S]*?\"\"\"", RegexOptions.Compiled);

    /// <summary>Opaque key material; letters-only blobs below 64 characters are identifiers (D-10, documented).</summary>
    private static bool Opaque(string value) =>
        (OpaqueBlob.IsMatch(value) && (!LettersOnly.IsMatch(value) || value.Length >= 64))
        || AzureClientSecret.IsMatch(value)
        || (Base64Key.IsMatch(value) && value.Any(c => char.IsDigit(c) || c == '+' || c == '/'))
        || HexKey.IsMatch(value);

    /// <summary>Redacts secret material inside <paramref name="value"/>; returns it unchanged when it carries none.</summary>
    public static string Text(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        if (CredentialShape.IsMatch(value) || Opaque(value)) return "[redacted]";
        if (Scheme.IsMatch(value) && !value.Any(c => c == ';' || char.IsWhiteSpace(c)))
        {
            var noUser = UserInfo.Replace(value, "$1[redacted]@");
            var q = noUser.IndexOf('?');
            if (q < 0) return noUser;
            var hash = noUser.IndexOf('#', q);
            var query = hash < 0 ? noUser[(q + 1)..] : noUser[(q + 1)..hash];
            return noUser[..(q + 1)] + RedactQuery(query) + (hash < 0 ? "" : noUser[hash..]);
        }
        if (value.Contains('=') && (value.Contains(';') || ConnectionString.IsMatch(value)))
            return ConnectionPair.Replace(value, m =>
            {
                var normalized = Regex.Replace(m.Groups[3].Value, "[^a-zA-Z]", "").ToLowerInvariant();
                var raw = m.Groups[5].Value;
                if (raw.Length == 0 || normalized.EndsWith("name", StringComparison.Ordinal) || !SecretPairKey.IsMatch(normalized)) return m.Value;
                return m.Groups[1].Value + m.Groups[2].Value + m.Groups[3].Value + m.Groups[4].Value + "[redacted]";
            });
        if (QueryStringShape.IsMatch(value) && QuerySecretMarker.IsMatch(value)) return RedactQuery(value);
        return value;
    }

    private static string RedactQuery(string query) =>
        string.Join('&', query.Split('&').Select(pair =>
        {
            var eq = pair.IndexOf('=');
            if (eq < 0 || eq == pair.Length - 1) return pair;
            var name = Uri.UnescapeDataString(pair[..eq]);
            return SecretQueryKey.IsMatch(name) ? pair[..eq] + "=[redacted]" : pair;
        }));

    /// <summary>A string constant as it may be recorded: identifiers and plain values unchanged, secret-bearing values filtered.</summary>
    public static string? Value(string? value)
    {
        if (value == null) return null;
        if (Identifier.IsMatch(value) && !Opaque(value)) return value;
        if (SecretLike.IsMatch(value) && !value.Contains(';') && !value.Contains('=') && !Scheme.IsMatch(value)) return "[redacted]";
        return Text(value);
    }

    public static string Url(string template) => Text(template);

    /// <summary>Source text (receiver expressions, display strings): every string literal inside is filtered.</summary>
    public static string Expression(string text)
    {
        var raw = RawStringLiteral.Replace(text, Filtered);
        return StringLiteral.Replace(raw, Filtered);
    }

    private static string Filtered(Match m)
    {
        var literal = m.Value.Trim('@', '$', '"');
        var filtered = Value(literal) ?? literal;
        return filtered == literal ? m.Value : "\"" + filtered + "\"";
    }
}
