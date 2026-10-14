using Microsoft.Extensions.Options;
using Vg.Enterprise.PlatformGateway.Clients;
using Vg.Enterprise.PlatformGateway.Endpoints;
using Vg.Enterprise.PlatformGateway.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services
    .AddOptions<DownstreamServicesOptions>()
    .Bind(builder.Configuration.GetSection(DownstreamServicesOptions.SectionName));

builder.Services.AddHttpClient<IOrdersClient, OrdersClient>((provider, client) =>
{
    client.BaseAddress = new Uri(provider.GetRequiredService<IOptions<DownstreamServicesOptions>>().Value.Orders.BaseUrl);
});

builder.Services.AddHttpClient<ICustomersClient, CustomersClient>((provider, client) =>
{
    client.BaseAddress = new Uri(provider.GetRequiredService<IOptions<DownstreamServicesOptions>>().Value.Customers.BaseUrl);
});

builder.Services.AddHttpClient<IReportsClient, ReportsClient>((provider, client) =>
{
    client.BaseAddress = new Uri(provider.GetRequiredService<IOptions<DownstreamServicesOptions>>().Value.Reports.BaseUrl);
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();

app.MapControllers();
app.MapGatewayEndpoints();

app.Run();
