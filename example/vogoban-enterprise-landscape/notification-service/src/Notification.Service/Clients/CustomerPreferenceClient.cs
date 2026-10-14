using System.Net.Http.Json;
using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.Notifications.Clients;

/// <summary>
/// Calls <c>GET /api/customers/{id}/preferences</c> on the customer service over
/// the base address configured as <c>Services:Customers:BaseUrl</c>.
/// </summary>
public sealed class CustomerPreferenceClient : ICustomerPreferenceClient
{
    public const string DefaultBaseUrl = "http://localhost:5182";

    private readonly HttpClient _httpClient;

    public CustomerPreferenceClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<NotificationPreferenceDto?> GetPreferenceAsync(
        string customerId,
        CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync(
            $"/api/customers/{Uri.EscapeDataString(customerId)}/preferences",
            cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<NotificationPreferenceDto>(cancellationToken)
            : null;
    }
}
