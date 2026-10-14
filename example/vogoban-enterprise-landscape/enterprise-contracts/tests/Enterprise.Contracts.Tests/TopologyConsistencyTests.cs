using Vg.Enterprise.Contracts.Topology;
using Xunit;

namespace Vg.Enterprise.Contracts.Tests;

/// <summary>
/// The C# topology constants and the npm package used by the portals describe the
/// same logical resources. These tests read the TypeScript package and the
/// AsyncAPI document as text and assert that every service and queue name is
/// present in all three representations, so a rename cannot land in one artifact
/// without the others.
/// </summary>
public sealed class TopologyConsistencyTests
{
    private static string Read(string relativePath) =>
        File.ReadAllText(Path.Combine(RepositoryLayout.Root, relativePath));

    public static TheoryData<string> ServiceBusEntityNames => new()
    {
        VgEnterpriseTopology.ServiceBus.Namespace,
        VgEnterpriseTopology.ServiceBus.OrderEventsTopic,
        VgEnterpriseTopology.ServiceBus.OrderProcessorSubscription,
        VgEnterpriseTopology.ServiceBus.NotificationsSubscription,
        VgEnterpriseTopology.ServiceBus.NotificationRequestsQueue,
        VgEnterpriseTopology.ServiceBus.ReportJobsQueue,
    };

    public static TheoryData<string> CosmosAndStorageNames => new()
    {
        VgEnterpriseTopology.Cosmos.AccountName,
        VgEnterpriseTopology.Cosmos.Database,
        VgEnterpriseTopology.Cosmos.OrdersContainer,
        VgEnterpriseTopology.Cosmos.CustomersContainer,
        VgEnterpriseTopology.Cosmos.ReportsContainer,
        VgEnterpriseTopology.Storage.AccountName,
        VgEnterpriseTopology.Storage.NotificationPayloadsContainer,
        VgEnterpriseTopology.Storage.ReportArtifactsContainer,
    };

    [Theory]
    [MemberData(nameof(ServiceBusEntityNames))]
    [MemberData(nameof(CosmosAndStorageNames))]
    public void EveryTopologyName_AppearsInTheTypescriptPackage(string name)
    {
        Assert.Contains(name, Read("typescript/index.js"), StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(ServiceBusEntityNames))]
    public void EveryServiceBusEntity_AppearsInTheAsyncApiDocument(string name)
    {
        Assert.Contains(name, Read("asyncapi/vg-order-events.asyncapi.yaml"), StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(CosmosAndStorageNames))]
    public void EveryCosmosAndStorageName_AppearsInTheInfrastructureRepository(string name)
    {
        var infrastructureRepository = Path.Combine(
            Directory.GetParent(RepositoryLayout.Root)!.FullName,
            "infrastructure");

        Assert.True(Directory.Exists(infrastructureRepository), $"Missing {infrastructureRepository}");

        var found = Directory
            .EnumerateFiles(infrastructureRepository, "*", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}.terraform{Path.DirectorySeparatorChar}"))
            .Any(path => File.ReadAllText(path).Contains(name, StringComparison.Ordinal));

        Assert.True(found, $"'{name}' does not appear anywhere in the infrastructure repository.");
    }

    [Theory]
    [MemberData(nameof(ServiceBusEntityNames))]
    public void EveryServiceBusEntity_AppearsInTheInfrastructureRepository(string name)
    {
        EveryCosmosAndStorageName_AppearsInTheInfrastructureRepository(name);
    }
}
