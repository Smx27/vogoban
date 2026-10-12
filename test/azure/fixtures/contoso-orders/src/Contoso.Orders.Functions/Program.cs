using Azure.Identity;
using Contoso.Orders.Functions;
using Contoso.Orders.Functions.Data;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var host = new HostBuilder()
    .ConfigureFunctionsWorkerDefaults()
    .ConfigureServices((context, services) =>
    {
        services.AddSingleton(sp => new CosmosClient(context.Configuration["Cosmos:accountEndpoint"], new DefaultAzureCredential()));
        services.AddScoped<IOrderRepository, CosmosOrderRepository>();
        services.AddScoped<OrderProcessor>();
    })
    .Build();

host.Run();
