using Azure.Extensions.AspNetCore.Configuration.Secrets;
using Vg.Enterprise.Reporting.Consumers;
using Vg.Enterprise.Reporting.Endpoints;
using Vg.Enterprise.Reporting.Infrastructure;
using Vg.Enterprise.Reporting.Startup;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory
});

var keyVault = builder.Configuration.GetSection(KeyVaultOptions.SectionName).Get<KeyVaultOptions>() ?? new KeyVaultOptions();

if (keyVault.Enabled && Uri.TryCreate(keyVault.VaultUri, UriKind.Absolute, out var vaultUri))
{
    var identity = builder.Configuration.GetSection(IdentityOptions.SectionName).Get<IdentityOptions>() ?? new IdentityOptions();

    builder.Configuration.AddAzureKeyVault(vaultUri, identity.CreateCredential());
}

builder.Services.AddReportingAzureClients(builder.Configuration);
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddHealthChecks();
builder.Services.AddHostedService<ReportStorageInitializer>();
builder.Services.AddHostedService<ServiceBusReportJobConsumer>();

var app = builder.Build();

app.Logger.LogInformation(
    "The reporting API is listening for the operations portal; Key Vault is {KeyVaultState}.",
    keyVault.Enabled ? "enabled" : "disabled");

foreach (var connectionStringName in new[] { "ServiceBus", "Cosmos", "Storage" })
{
    var secretName = KeyVaultSecretReference.ResolveSecretName(app.Configuration, connectionStringName);
    var secretVaultUri = KeyVaultSecretReference.ResolveVaultUri(app.Configuration, connectionStringName);

    if (secretName is null || secretVaultUri is null)
    {
        app.Logger.LogWarning(
            "ConnectionStrings:{Name} does not reference a Key Vault secret.",
            connectionStringName);

        continue;
    }

    app.Logger.LogInformation(
        "ConnectionStrings:{Name} resolves to secret {SecretName} in {VaultUri}.",
        connectionStringName,
        secretName,
        secretVaultUri);
}

app.UseSwagger();
app.UseSwaggerUI();

app.MapControllers();
app.MapReportEndpoints();
app.MapHealthChecks("/health");

app.Run();
