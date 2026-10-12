var builder = DistributedApplication.CreateBuilder(args);

var messaging = builder.AddAzureServiceBus("messaging");
messaging.AddServiceBusTopic("orders").AddServiceBusSubscription("billing");
var cosmos = builder.AddAzureCosmosDB("cosmos");
cosmos.AddCosmosDatabase("ordersdb").AddContainer("orderdocs", "/id", "orders");

builder.AddProject<Projects.Contoso_Orders_Api>("api")
    .WithReference(messaging)
    .WithExternalHttpEndpoints();

builder.Build().Run();
