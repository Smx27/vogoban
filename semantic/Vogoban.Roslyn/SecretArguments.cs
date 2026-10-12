using System.Text.RegularExpressions;

namespace Vogoban.Roslyn;

/// <summary>
/// Arguments bound to credential parameters are secret whatever their shape (a short client secret, a letters-only key):
/// after analysis every recorded argument whose parameter name is credential-like loses its value before the facts are
/// written out. Name-agnostic value filtering happens in <see cref="Redaction"/> when the value is recorded.
/// </summary>
public static class SecretArguments
{
    private static readonly Regex SecretParameter = new(
        @"^(authKey\w*|accountKey|sharedAccessKey|sharedAccessSignature|signature|sas\w*|clientSecret|secret\w*|password|pwd|token|accessToken|apiKey|certificatePassword)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    /// <summary>Generic names (key, credential) are secret only on cloud SDK/credential constructors; elsewhere they are configuration keys, dictionary keys or partition keys.</summary>
    private static readonly Regex CloudSdkSecretParameter = new(@"^(key|credential|keyValue|primaryKey|secondaryKey|namedKey)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CloudSdkType = new(@"^(Azure\.|Microsoft\.Azure\.|Microsoft\.Extensions\.Azure\.|Microsoft\.Data\.SqlClient)", RegexOptions.Compiled);

    public static void Redact(ProjectResult result)
    {
        foreach (var invocation in result.Invocations) Visit(invocation);
        foreach (var creation in result.Creations ?? new()) Visit(creation);
        foreach (var assignment in result.Assignments ?? new()) Visit(assignment.Value);
        foreach (var symbol in result.Symbols)
        {
            foreach (var attribute in symbol.Attributes) attribute.Arguments.ForEach(Visit);
            foreach (var parameter in symbol.Parameters) foreach (var attribute in parameter.Attributes) attribute.Arguments.ForEach(Visit);
        }
    }

    private static bool IsCloudSdk(SymRef? target) => target != null && CloudSdkType.IsMatch(target.ContainingType?.QualifiedName ?? target.QualifiedName);

    private static void Visit(InvocationFact invocation)
    {
        var cloud = IsCloudSdk(invocation.Target);
        foreach (var a in invocation.Arguments) Visit(a, cloud);
        for (var receiver = invocation.Receiver; receiver != null; receiver = receiver.Receiver)
        {
            var receiverCloud = IsCloudSdk(receiver.InvocationTarget);
            foreach (var a in receiver.InvocationArguments ?? new()) Visit(a, receiverCloud);
        }
    }

    private static void Visit(ArgValue value) => Visit(value, false);

    private static void Visit(ArgValue value, bool cloudSdk)
    {
        if (value.Kind is "string" or "template" && value.Value != null && !string.Equals(value.Value, "[redacted]", StringComparison.Ordinal) && value.Parameter != null
            && (SecretParameter.IsMatch(value.Parameter) || (cloudSdk && CloudSdkSecretParameter.IsMatch(value.Parameter))))
            value.Value = "[redacted]";
        var nestedCloud = value.Symbol != null || (value.Kind == "new" && value.Type != null) ? IsCloudSdk(value.Symbol ?? value.Type) : cloudSdk;
        foreach (var item in value.Items ?? new()) Visit(item, nestedCloud);
        value.Attributes?.ForEach(a => a.Arguments.ForEach(Visit));
    }
}
