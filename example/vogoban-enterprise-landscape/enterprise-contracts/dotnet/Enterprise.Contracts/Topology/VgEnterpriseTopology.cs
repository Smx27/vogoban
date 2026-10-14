namespace Vg.Enterprise.Contracts.Topology;

/// <summary>
/// The single source of truth for every logical resource identity in the VG
/// enterprise landscape. Each runtime repository defaults its configuration from
/// these constants while its own <c>appsettings.json</c> spells the same names
/// out. The repetition across independent repositories is intentional: it is the
/// evidence a cross-repository resolver needs to correlate one logical Azure
/// resource referenced from several places.
/// </summary>
public static class VgEnterpriseTopology
{
    public static class ServiceBus
    {
        public const string Namespace = "vg-enterprise-servicebus";

        public const string FullyQualifiedNamespace = "vg-enterprise-servicebus.servicebus.windows.net";

        public const string OrderEventsTopic = "vg-order-events";

        public const string OrderProcessorSubscription = "vg-order-processor";

        public const string NotificationsSubscription = "vg-notifications";

        public const string NotificationRequestsQueue = "vg-notification-requests";

        public const string ReportJobsQueue = "vg-report-jobs";
    }

    public static class Cosmos
    {
        public const string AccountName = "vg-enterprise-cosmos";

        public const string AccountEndpoint = "https://vg-enterprise-cosmos.documents.azure.com:443/";

        public const string Database = "vg-enterprise";

        public const string OrdersContainer = "vg-orders";

        public const string CustomersContainer = "vg-customers";

        public const string ReportsContainer = "vg-reports";

        public const string OrdersPartitionKey = "/customerId";

        public const string CustomersPartitionKey = "/id";

        public const string ReportsPartitionKey = "/reportType";
    }

    public static class Storage
    {
        public const string AccountName = "vgentstorage";

        public const string BlobServiceUri = "https://vgentstorage.blob.core.windows.net/";

        public const string NotificationPayloadsContainer = "vg-notification-payloads";

        public const string ReportArtifactsContainer = "vg-report-artifacts";
    }

    public static class KeyVault
    {
        public const string Name = "vg-enterprise-kv";

        public const string VaultUri = "https://vg-enterprise-kv.vault.azure.net/";

        public const string ServiceBusConnectionSecret = "vg-servicebus-connection";

        public const string CosmosConnectionSecret = "vg-cosmos-connection";

        public const string StorageConnectionSecret = "vg-storage-connection";
    }

    public static class Identity
    {
        public const string UserAssignedManagedIdentity = "vg-enterprise-identity";

        public const string PlaceholderClientId = "00000000-0000-0000-0000-000000000000";
    }

    public static class Platform
    {
        public const string ResourceGroup = "rg-vg-enterprise";

        public const string KubernetesNamespace = "vg-enterprise";

        public const string ContainerAppsEnvironment = "vg-enterprise-aca-env";

        public const string AppServicePlan = "vg-enterprise-plan";

        public const string ApplicationInsights = "vg-enterprise-appinsights";

        public const string LogAnalyticsWorkspace = "vg-enterprise-logs";

        public const string FunctionApp = "vg-order-processor-function";
    }

    /// <summary>
    /// Deployment unit names. These are the identities the Kubernetes manifests,
    /// the Bicep Container Apps and the Terraform resources all refer to.
    /// </summary>
    public static class DeploymentUnits
    {
        public const string PlatformGateway = "vg-platform-gateway";

        public const string OrdersApi = "vg-orders-api";

        public const string CustomersApi = "vg-customers-api";

        public const string NotificationService = "vg-notification-service";

        public const string OrderProcessorFunction = "vg-order-processor-function";

        public const string ReportingWorker = "vg-reporting-worker";
    }

    /// <summary>
    /// Contract identifiers. A contract id resolves to
    /// <c>&lt;Contracts:SchemaRoot&gt;/&lt;id&gt;.schema.json</c>, so every repository
    /// names the same contract artifact by id and the same file backs it.
    /// </summary>
    public static class ContractIds
    {
        public const string OrderCreated = "orders/order-created";

        public const string OrderUpdated = "orders/order-updated";

        public const string OrderCancelled = "orders/order-cancelled";

        public const string NotificationRequested = "notifications/notification-requested";

        public const string ReportRequested = "reporting/report-requested";
    }
}
