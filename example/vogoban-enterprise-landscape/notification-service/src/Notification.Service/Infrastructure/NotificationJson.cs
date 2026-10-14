using System.Text.Json;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// The serializer settings every contract payload in this service is read and
/// written with: the web defaults (camelCase property names, case-insensitive
/// matching) that the JSON Schemas published by enterprise-contracts are written
/// against. <see cref="JsonSerializerOptions.Web"/> is .NET 9+, so the same
/// defaults are constructed explicitly.
/// </summary>
internal static class NotificationJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web);
}
