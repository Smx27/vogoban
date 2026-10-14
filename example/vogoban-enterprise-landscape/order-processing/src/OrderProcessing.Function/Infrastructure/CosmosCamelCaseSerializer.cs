using System.Text;
using Microsoft.Azure.Cosmos;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Writes camelCase documents, the shape the shared JSON schemas and the
/// <c>vg-orders</c> partition key path (<c>/customerId</c>) are named in, and the shape
/// Cosmos requires for the <c>id</c> property of every document.
/// </summary>
internal sealed class CosmosCamelCaseSerializer : CosmosSerializer
{
    private static readonly JsonSerializerSettings Settings = new()
    {
        ContractResolver = new CamelCasePropertyNamesContractResolver(),
        DateParseHandling = DateParseHandling.None,
        NullValueHandling = NullValueHandling.Ignore
    };

    public override T FromStream<T>(Stream stream)
    {
        if (stream is null || stream.Length == 0)
        {
            return default!;
        }

        using var reader = new StreamReader(stream);

        return JsonConvert.DeserializeObject<T>(reader.ReadToEnd(), Settings)!;
    }

    public override Stream ToStream<T>(T input)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(input, Settings));
        var stream = new MemoryStream(bytes.Length);

        stream.Write(bytes, 0, bytes.Length);
        stream.Position = 0;

        return stream;
    }
}
