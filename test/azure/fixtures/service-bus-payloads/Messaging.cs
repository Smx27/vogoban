using System.Text.Json;
using Azure.Messaging.ServiceBus;

namespace Evidence;

public record OrderCreated(string Id);
public record OrderUpdated(string Id);
public record Unrelated(string Id);

public sealed class Publisher
{
    private readonly ServiceBusSender _sender;

    public Publisher(ServiceBusClient client) => _sender = client.CreateSender("orders");

    public Task Created(OrderCreated value) => Send(value);
    public Task Updated(OrderUpdated value) => Send(value);

    private Task Send<T>(T value)
    {
        var message = new ServiceBusMessage(BinaryData.FromString(JsonSerializer.Serialize(value)))
        {
            ContentType = "application/json"
        };
        return _sender.SendMessageAsync(message);
    }

    public Task Unknown(ServiceBusMessage message) => _sender.SendMessageAsync(message);

    public Task Reassigned(OrderCreated value, ServiceBusMessage replacement)
    {
        var message = new ServiceBusMessage(BinaryData.FromObjectAsJson(value));
        message = replacement;
        return _sender.SendMessageAsync(message);
    }

    public Task Mutated(OrderCreated value)
    {
        var message = new ServiceBusMessage(BinaryData.FromObjectAsJson(value));
        message.Body = BinaryData.FromString("unknown");
        return _sender.SendMessageAsync(message);
    }

    public Task FakeSerializer(Unrelated value)
        => _sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromString(Fake.Serialize(value))));
}

public static class Fake
{
    public static string Serialize<T>(T value) => "unknown";
}

public sealed class AmbiguousPublisher
{
    private ServiceBusSender _sender;
    public AmbiguousPublisher(ServiceBusClient client, bool other)
    {
        _sender = client.CreateSender("orders");
        if (other) _sender = client.CreateSender("other");
    }

    public Task Send(OrderUpdated value) => _sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromObjectAsJson(value)));
}

public sealed class Consumer
{
    public Task Start(ServiceBusClient client)
    {
        var processor = client.CreateProcessor("orders", "notifications");
        processor.ProcessMessageAsync += Handle;
        return processor.StartProcessingAsync();
    }

    private Task Handle(ProcessMessageEventArgs args)
    {
        var value = args.Message.Body.ToObjectFromJson<OrderCreated>();
        return Task.CompletedTask;
    }

    public Unrelated? NotServiceBus(BinaryData data) => data.ToObjectFromJson<Unrelated>();
}
