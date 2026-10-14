using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// HTTP facade over the Orders API. The gateway holds no Azure client of any
/// kind, so every order request leaves this process as an outbound HTTP call to
/// the base address configured under <c>Services:Orders:BaseUrl</c>.
/// </summary>
public interface IOrdersClient
{
    Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<OrderDto?> GetAsync(Guid id, CancellationToken cancellationToken = default);

    Task<OrderDto?> CreateAsync(CreateOrderRequest request, CancellationToken cancellationToken = default);

    Task<OrderDto?> CancelAsync(Guid id, CancellationToken cancellationToken = default);
}
