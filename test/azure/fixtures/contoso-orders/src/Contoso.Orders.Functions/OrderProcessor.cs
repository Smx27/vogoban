using Contoso.Orders.Contracts;
using Contoso.Orders.Functions.Data;

namespace Contoso.Orders.Functions;

public sealed class OrderProcessor(IOrderRepository repository)
{
    public Task ProcessAsync(OrderSubmitted order, CancellationToken cancellationToken)
        => repository.SaveAsync(new OrderDocument { id = order.OrderId, CustomerId = order.CustomerId, Status = "accepted" }, cancellationToken);

    public void Audit(string type) => Console.WriteLine(type);

    public Task CleanupAsync(CancellationToken cancellationToken) => repository.PurgeCompletedAsync(cancellationToken);
}
