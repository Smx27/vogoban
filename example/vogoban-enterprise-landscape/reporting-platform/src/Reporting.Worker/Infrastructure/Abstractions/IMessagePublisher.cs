namespace Vg.Enterprise.Reporting.Infrastructure.Abstractions;

/// <summary>
/// Publishes messages to Service Bus queues in the vg-enterprise-servicebus namespace.
/// </summary>
public interface IMessagePublisher
{
    Task PublishAsync<TMessage>(string queueName, TMessage message, CancellationToken cancellationToken = default)
        where TMessage : notnull;
}
