using Microsoft.Azure.Functions.Worker;
using Newtonsoft.Json;

namespace TriggerEvidence;

public record OrderCreated(string Id);
public record Unrelated(string Id);

public sealed class Functions
{
    [Function("Direct")]
    public void Direct([ServiceBusTrigger("events", "orders", Connection = "Bus")] string message)
        => JsonConvert.DeserializeObject<OrderCreated>(message);

    [Function("Alias")]
    public void Alias([ServiceBusTrigger("events", "alias", Connection = "Bus")] string message)
    {
        var body = message;
        var text = body;
        JsonConvert.DeserializeObject<OrderCreated>(text);
    }

    [Function("SystemJson")]
    public void SystemJson([ServiceBusTrigger("system-orders", Connection = "Bus")] string message)
        => System.Text.Json.JsonSerializer.Deserialize<OrderCreated>(message);

    [Function("UnrelatedParameter")]
    public void UnrelatedParameter([ServiceBusTrigger("events", "unrelated", Connection = "Bus")] string message, string other)
        => JsonConvert.DeserializeObject<Unrelated>(other);

    [Function("ReassignedAlias")]
    public void ReassignedAlias([ServiceBusTrigger("events", "reassigned", Connection = "Bus")] string message, string other)
    {
        var body = message;
        body = other;
        JsonConvert.DeserializeObject<Unrelated>(body);
    }

    [Function("ReassignedParameter")]
    public void ReassignedParameter([ServiceBusTrigger("events", "parameter", Connection = "Bus")] string message, string other)
    {
        message = other;
        JsonConvert.DeserializeObject<Unrelated>(message);
    }

    [Function("NestedParameter")]
    public void NestedParameter([ServiceBusTrigger("events", "nested", Connection = "Bus")] string message)
    {
        Action<string> parse = message => JsonConvert.DeserializeObject<Unrelated>(message);
        parse("unrelated");
    }

    [Function("ArbitrarySerializer")]
    public void ArbitrarySerializer([ServiceBusTrigger("events", "arbitrary", Connection = "Bus")] string message)
        => Fake.DeserializeObject<Unrelated>(message);

    public void NotAFunction(string message) => JsonConvert.DeserializeObject<Unrelated>(message);
}

public static class Fake
{
    public static T? DeserializeObject<T>(string value) => default;
}
