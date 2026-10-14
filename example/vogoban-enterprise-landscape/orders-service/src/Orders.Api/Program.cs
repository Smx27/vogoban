using Vg.Enterprise.Orders.Contracts;
using Vg.Enterprise.Orders.Endpoints;
using Vg.Enterprise.Orders.Infrastructure;
using Vg.Enterprise.Orders.Repositories;
using Vg.Enterprise.Orders.Services;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory
});

builder.Configuration.AddVgKeyVault(builder.Configuration);

builder.Services.AddOrdersAzure(builder.Configuration);

builder.Services.AddOptions<ContractSchemaOptions>()
    .Bind(builder.Configuration.GetSection(ContractSchemaOptions.SectionName));
builder.Services.AddSingleton<IContractSchemaValidator, ContractSchemaValidator>();

builder.Services.AddScoped<IOrderRepository, CosmosOrderRepository>();
builder.Services.AddScoped<IOrderService, OrderService>();

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

app.Services.GetRequiredService<IContractSchemaValidator>();

app.UseSwagger();
app.UseSwaggerUI();

app.MapControllers();
app.MapOrderEndpoints();

app.Run();
