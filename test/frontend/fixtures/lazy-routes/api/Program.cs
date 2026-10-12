var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/api/orders", () => new[] { new { id = "1" } });
app.MapGet("/api/reports", () => new[] { new { id = "r1" } });
app.MapGet("/api/admin/users", () => new[] { new { id = "u1" } });
app.MapGet("/api/profile", () => new { name = "x" });
app.MapGet("/api/settings", () => new { theme = "dark" });
app.MapGet("/api/catalog", () => new[] { new { sku = "s" } });
app.Run();
