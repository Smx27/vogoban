using Microsoft.Azure.Cosmos;

namespace Vg.Enterprise.Reporting.Infrastructure.Abstractions;

/// <summary>
/// Resolves the Cosmos containers this repository reads and writes.
/// </summary>
public interface ICosmosContainerFactory
{
    Container GetReportsContainer();
}
