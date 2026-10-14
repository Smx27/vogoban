using Microsoft.Azure.Cosmos;
using Vg.Enterprise.Contracts.Reporting;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Endpoints;

public static class ReportEndpoints
{
    /// <summary>Adds the minimal report read endpoint to the reporting API surface.</summary>
    public static IEndpointRouteBuilder MapReportEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/reports/{id:guid}", async (
            Guid id,
            ICosmosContainerFactory containers,
            CancellationToken cancellationToken) =>
        {
            using var iterator = containers.GetReportsContainer().GetItemQueryIterator<ReportDto>(
                new QueryDefinition("SELECT * FROM c WHERE c.id = @id").WithParameter("@id", id.ToString()));

            while (iterator.HasMoreResults)
            {
                var page = await iterator.ReadNextAsync(cancellationToken);
                var report = page.FirstOrDefault();

                if (report is not null)
                {
                    return Results.Ok(report);
                }
            }

            return Results.NotFound();
        })
        .WithName("GetReportById")
        .Produces<ReportDto>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status404NotFound);

        return endpoints;
    }
}
