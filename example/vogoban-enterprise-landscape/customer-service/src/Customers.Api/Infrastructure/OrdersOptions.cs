namespace Vg.Enterprise.Customers.Infrastructure;

/// <summary>
/// Settings for the downstream Orders API this service calls.
/// </summary>
public sealed class OrdersOptions
{
    public const string SectionName = "Services:Orders";

    public string BaseUrl { get; set; } = "http://localhost:5181";
}
