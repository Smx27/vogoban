using Azure.Identity;
using Azure.Messaging.EventGrid;
using Contoso.Orders.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.AddAzureServiceBusClient("messaging");
builder.Services.AddSingleton(sp => new EventGridPublisherClient(new Uri(builder.Configuration["EventGrid:Endpoint"]!), new DefaultAzureCredential()));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
