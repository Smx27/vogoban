namespace Vg.Enterprise.PlatformGateway.Infrastructure;

/// <summary>
/// One downstream HTTP service the gateway forwards to. Only the base address is
/// configurable; the request paths are fixed in the client implementations.
/// </summary>
public sealed class DownstreamServiceOptions
{
    public string BaseUrl { get; set; } = string.Empty;
}

/// <summary>
/// The <c>Services</c> configuration section: the base address of every service
/// this gateway calls. The gateway has no Azure clients, so this is the whole of
/// its outbound topology.
/// </summary>
public sealed class DownstreamServicesOptions
{
    public const string SectionName = "Services";

    public DownstreamServiceOptions Orders { get; set; } = new() { BaseUrl = "http://localhost:5181" };

    public DownstreamServiceOptions Customers { get; set; } = new() { BaseUrl = "http://localhost:5182" };

    public DownstreamServiceOptions Reports { get; set; } = new() { BaseUrl = "http://localhost:5184" };
}
