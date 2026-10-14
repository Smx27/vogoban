using Vg.Enterprise.Customers.Endpoints;
using Vg.Enterprise.Customers.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

var keyVault = builder.Configuration.GetSection(KeyVaultOptions.SectionName).Get<KeyVaultOptions>()
    ?? new KeyVaultOptions();

if (keyVault.Enabled)
{
    try
    {
        var identity = builder.Configuration.GetSection(IdentityOptions.SectionName).Get<IdentityOptions>()
            ?? new IdentityOptions();

        builder.Configuration.AddAzureKeyVault(
            new Uri(keyVault.VaultUri),
            ServiceCollectionExtensions.CreateTokenCredential(identity));
    }
    catch (Exception exception)
    {
        Console.Error.WriteLine($"Key Vault secrets were not loaded from {keyVault.VaultUri}: {exception.Message}");
    }
}

builder.Services.AddCustomerInfrastructure(builder.Configuration);
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
app.MapControllers();
app.MapCustomerEndpoints();

app.Run();
