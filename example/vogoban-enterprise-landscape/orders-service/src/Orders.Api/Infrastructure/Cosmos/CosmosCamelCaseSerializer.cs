using System.Text;
using System.Text.Json;
using Microsoft.Azure.Cosmos;

namespace Vg.Enterprise.Orders.Infrastructure.Cosmos;

/// <summary>
/// Writes camelCase documents — the shape the shared JSON Schemas and the
/// <c>vg-orders</c> partition key path (<c>/customerId</c>) are named in, and the
/// shape Cosmos requires for the <c>id</c> property of every document. The same
/// <see cref="JsonSerializerDefaults.Web"/> options carry the events this service
/// publishes, so a stored order and a published order event are serialized alike.
/// </summary>
internal sealed class CosmosCamelCaseSerializer : CosmosSerializer
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    public override T FromStream<T>(Stream stream)
    {
        if (stream is null || stream.Length == 0)
        {
            return default!;
        }

        using var reader = new StreamReader(stream);

        return JsonSerializer.Deserialize<T>(reader.ReadToEnd(), SerializerOptions)!;
    }

    public override Stream ToStream<T>(T input)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(input, SerializerOptions));

        return new MemoryStream(bytes, writable: false);
    }
}
