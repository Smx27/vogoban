using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Vg.Enterprise.OrderProcessing.Infrastructure;

var host = Host.CreateDefaultBuilder(args)
    .ConfigureFunctionsWorkerDefaults()
    .ConfigureAppConfiguration((_, builder) =>
    {
        var keyVault = builder.Build().GetSection(KeyVaultOptions.SectionName).Get<KeyVaultOptions>() ?? new KeyVaultOptions();

        if (keyVault.Enabled)
        {
            builder.AddAzureKeyVault(new Uri(keyVault.VaultUri), new DefaultAzureCredential());
        }
    })
    .ConfigureServices((context, services) => services.AddOrderProcessingAzure(context.Configuration))
    .Build();

host.Run();
