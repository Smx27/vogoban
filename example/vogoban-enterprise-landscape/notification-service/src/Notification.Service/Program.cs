using Vg.Enterprise.Notifications.Consumers;
using Vg.Enterprise.Notifications.Infrastructure;

// The content root is pinned to the application directory so appsettings.json is
// loaded identically under `dotnet run`, a direct `dotnet Notification.Service.dll`
// and in a container. Without this, pinning RunWorkingDirectory in the project file
// would move the content root off the application directory and the file would
// silently stop loading.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory
});

builder.Configuration.AddNotificationKeyVault(builder.Configuration);
builder.Services.AddNotificationInfrastructure(builder.Configuration);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddHostedService<NotificationRequestConsumer>();
builder.Services.AddHostedService<OrderEventsConsumer>();
builder.Services.AddHealthChecks();

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();

app.MapControllers();
app.MapHealthChecks("/health");

app.Run();
