using Contoso.Catalog.Functions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var host = new HostBuilder()
    .ConfigureFunctionsWorkerDefaults()
    .ConfigureServices(services =>
    {
        services.AddSingleton<ProductService>();
        services.AddSingleton<ReviewService>();
        services.AddSingleton<InventoryService>();
    })
    .Build();

host.Run();
