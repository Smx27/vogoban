using System.Collections.Concurrent;
using System.Text.Json;
using Azure.Messaging.ServiceBus;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// Publishes to the configured Service Bus queues, reusing one sender per queue.
/// </summary>
public sealed class ServiceBusMessagePublisher : IMessagePublisher, IAsyncDisposable
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    private readonly ServiceBusClient _client;
    private readonly ConcurrentDictionary<string, ServiceBusSender> _senders = new(StringComparer.Ordinal);

    public ServiceBusMessagePublisher(ServiceBusClient client)
    {
        _client = client;
    }

    public async Task PublishAsync<TMessage>(
        string queueName,
        TMessage message,
        CancellationToken cancellationToken = default)
        where TMessage : notnull
    {
        var sender = _senders.GetOrAdd(queueName, _client.CreateSender);
        var payload = JsonSerializer.Serialize(message, WebJson);

        await sender.SendMessageAsync(
            new ServiceBusMessage(payload) { ContentType = "application/json" },
            cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var sender in _senders.Values)
        {
            await sender.DisposeAsync();
        }
    }
}
