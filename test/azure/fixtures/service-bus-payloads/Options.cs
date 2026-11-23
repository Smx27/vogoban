using Azure.Messaging.ServiceBus;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Evidence;

public sealed class BusOptions
{
    public string Topic { get; set; } = "not-declared-config";
    public string Subscription { get; set; } = "not-declared-subscription";
}

public static class Registration
{
    public static void Configure(IServiceCollection services, IConfiguration configuration)
        => services.AddOptions<BusOptions>().Bind(configuration.GetSection("Bus"));
}

public sealed class ConfiguredPublisher
{
    private readonly ServiceBusSender _sender;

    public ConfiguredPublisher(ServiceBusClient client, IOptions<BusOptions> options)
        => _sender = client.CreateSender(options.Value.Topic);

    public Task Send(OrderCreated value) => _sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromObjectAsJson(value)));
}

public sealed class ConfiguredConsumer
{
    private readonly BusOptions _options;
    public ConfiguredConsumer(IOptions<BusOptions> options) => _options = options.Value;

    public Task Start(ServiceBusClient client)
    {
        var processor = client.CreateProcessor(_options.Topic, _options.Subscription);
        processor.ProcessMessageAsync += Handle;
        return processor.StartProcessingAsync();
    }

    private Task Handle(ProcessMessageEventArgs args)
    {
        var value = args.Message.Body.ToObjectFromJson<OrderCreated>();
        return Task.CompletedTask;
    }
}

public sealed class AmbiguousOptions
{
    private readonly BusOptions _options;
    public AmbiguousOptions(IOptions<BusOptions> options, bool replace)
    {
        _options = options.Value;
        if (replace) _options = new BusOptions();
    }

    public Task Send(ServiceBusClient client, OrderCreated value)
    {
        var sender = client.CreateSender(_options.Topic);
        return sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromObjectAsJson(value)));
    }
}

public sealed class OptionsLocals
{
    public Task FromLocal(ServiceBusClient client, IOptions<BusOptions> options, OrderCreated value)
    {
        var settings = options.Value;
        var sender = client.CreateSender(settings.Topic);
        return sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromObjectAsJson(value)));
    }

    public Task UnrelatedInstance(ServiceBusClient client, OrderCreated value)
    {
        var options = new BusOptions();
        var sender = client.CreateSender(options.Topic);
        return sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromObjectAsJson(value)));
    }
}
