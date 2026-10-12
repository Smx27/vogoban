import type { EvidenceLevel, Metadata, RelationshipType } from "../graph/model.ts";
import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import { entityIdOf, methodName, semanticIndex, type IndexedInvocation, type SemanticIndex } from "../dotnet/frameworks/shared.ts";
import type { ArgValue, AssignmentFact, FactLocation, InvocationFact, ReceiverFact, SymRef } from "../dotnet/semantic-facts.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../plugins/types.ts";
import { azRelate, azProv, azUnresolved } from "./common.ts";
import { azureKeys } from "./catalog.ts";
import { argRef, displayRef, type ValueRef } from "./values.ts";
import { AZURE_SOURCE_HASH } from "./source-hash.ts";

export const SDK_PLUGIN = "azure.sdk";
export const SDK_VERSION = `1+${AZURE_SOURCE_HASH}`;

export type SdkService = "service-bus" | "event-hubs" | "event-grid" | "storage-blob" | "storage-queue" | "storage-table" | "cosmos-db" | "key-vault" | "app-configuration" | "sql";

export interface ResourceAddress {
  service: SdkService;
  /** Namespace / account / vault / server / topic endpoint. */
  account: ValueRef | null;
  /** Leaf path below the account: [queueOrTopic(, subscription)], [hub], [container], [table], [secret], [database, container]. */
  path: (ValueRef | null)[];
  /** Connection the client is configured from: a connection name (Aspire), a connection-string setting, or a configuration key. */
  connection: ValueRef | null;
  credential: string | null;
  /** Derivation steps, in order, for evidence. */
  via: string[];
  evidence: EvidenceLevel;
}

export interface SdkUsage {
  callerKey: string;
  /** Graph id of the caller when it is not a C# symbol (TypeScript/JavaScript declarations, files). */
  callerId?: string;
  /** Directory of the owning project (TypeScript/JavaScript packages). */
  dir?: string;
  projectId: string;
  location: FactLocation;
  clientType: string;
  method: string;
  operation: "publish" | "receive" | "consume" | "read" | "write" | "query" | "secret-read" | "secret-write" | "change-feed" | "connect";
  relationship: RelationshipType;
  /** Flow direction: true when the edge goes resource → caller (CONSUMED_BY, CHANGE_FEED). */
  inbound: boolean;
  address: ResourceAddress | null;
  unresolved: string | null;
  details: Metadata;
}

export interface SdkRegistration {
  projectId: string;
  clientType: string;
  address: ResourceAddress;
  location: FactLocation;
  key: string | null;
}

export interface SdkFacts {
  usages: SdkUsage[];
  registrations: SdkRegistration[];
  /** DbContext types bound to a SQL connection (EF Core UseSqlServer/UseAzureSql, Aspire AddSqlServerDbContext). */
  dbContexts: { contextKey: string | null; projectId: string; address: ResourceAddress; location: FactLocation; callerKey: string }[];
}

export const AZURE_SDK = artifactKey<SdkFacts>("azure.sdk");

const short = (q: string | undefined | null) => (q ?? "").replace(/<.*$/, "").split(".").pop() ?? "";
const typeOf = (ref: SymRef | undefined | null) => (ref?.qualifiedName ?? "").replace(/<.*$/, "");

const CLIENT_SERVICE: [RegExp, SdkService][] = [
  [/^Azure\.Messaging\.ServiceBus\./, "service-bus"],
  [/^Azure\.Messaging\.EventHubs(\.|$)/, "event-hubs"],
  [/^Azure\.Messaging\.EventGrid\./, "event-grid"],
  [/^Azure\.Storage\.Blobs\./, "storage-blob"],
  [/^Azure\.Storage\.Queues\./, "storage-queue"],
  [/^Azure\.Data\.Tables\./, "storage-table"],
  [/^Microsoft\.Azure\.Cosmos\./, "cosmos-db"],
  [/^Azure\.Security\.KeyVault\./, "key-vault"],
  [/^Azure\.Data\.AppConfiguration\./, "app-configuration"],
  [/^Microsoft\.Data\.SqlClient\./, "sql"],
];
export const serviceOf = (type: string): SdkService | null => CLIENT_SERVICE.find(([re]) => re.test(type))?.[1] ?? null;

type Args = (...names: string[]) => ArgValue | undefined;
const argsOf = (args: ArgValue[] | undefined): Args => (...names) => (args ?? []).find((a) => names.includes(a.parameter ?? a.name ?? ""));

const CREDENTIALS: Record<string, string> = {
  DefaultAzureCredential: "default-azure-credential", ManagedIdentityCredential: "managed-identity", WorkloadIdentityCredential: "workload-identity",
  ClientSecretCredential: "client-secret", ClientCertificateCredential: "client-certificate", ClientAssertionCredential: "client-assertion",
  AzureCliCredential: "developer-cli", AzureDeveloperCliCredential: "developer-cli", VisualStudioCredential: "developer-tool", InteractiveBrowserCredential: "interactive-browser",
  UsernamePasswordCredential: "username-password", EnvironmentCredential: "environment", ChainedTokenCredential: "chained", DeviceCodeCredential: "device-code",
  AzureKeyCredential: "key", AzureSasCredential: "sas", StorageSharedKeyCredential: "shared-key", AzureNamedKeyCredential: "shared-key",
};

function credentialOf(a: ArgValue | undefined): string | null {
  if (!a) return null;
  if (a.kind === "new") return CREDENTIALS[short(a.type?.qualifiedName)] ?? "token-credential";
  if (a.kind === "string") return "key";
  return a.type && /TokenCredential|Credential$/.test(a.type.qualifiedName) ? (CREDENTIALS[short(a.type.qualifiedName)] ?? "token-credential") : "injected";
}

interface Step {
  account?: ValueRef | null;
  connection?: ValueRef | null;
  credential?: string | null;
  path?: (ValueRef | null)[];
  /** Replace (not append) the path, for constructors that name the leaf directly. */
  root?: boolean;
}

/** The address contribution of one constructor or factory call on an SDK type. */
function stepOf(type: string, method: string, args: Args): Step | null {
  const t = short(type);
  const cs = args("connectionString");
  const conn = cs ? argRef(cs) : null;
  const connStep = (extra: Step = {}): Step => ({ connection: conn, credential: conn ? "connection-string" : null, root: true, ...extra });
  if (method === ".ctor") {
    switch (t) {
      case "ServiceBusClient":
      case "ServiceBusAdministrationClient":
        return cs ? connStep({ path: [] }) : { account: argRef(args("fullyQualifiedNamespace")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "EventHubProducerClient":
      case "EventHubBufferedProducerClient":
      case "EventHubConsumerClient":
      case "EventProcessorClient":
      case "PartitionReceiver":
        return cs ? connStep({ path: [argRef(args("eventHubName"))] }) : { account: argRef(args("fullyQualifiedNamespace")), credential: credentialOf(args("credential")), root: true, path: [argRef(args("eventHubName"))] };
      case "EventGridPublisherClient":
        return { account: argRef(args("endpoint")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "BlobServiceClient":
      case "QueueServiceClient":
      case "TableServiceClient":
        return cs ? connStep({ path: [] }) : { account: argRef(args("serviceUri", "endpoint")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "BlobContainerClient":
        return cs ? connStep({ path: [argRef(args("blobContainerName"))] }) : { account: argRef(args("blobContainerUri")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "BlobClient":
      case "BlockBlobClient":
      case "AppendBlobClient":
      case "PageBlobClient":
        return cs ? connStep({ path: [argRef(args("blobContainerName"))] }) : { account: argRef(args("blobUri")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "QueueClient":
        return cs ? connStep({ path: [argRef(args("queueName"))] }) : { account: argRef(args("queueUri")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "TableClient":
        return cs ? connStep({ path: [argRef(args("tableName"))] }) : { account: argRef(args("endpoint")), credential: credentialOf(args("credential")), root: true, path: [argRef(args("tableName"))] };
      case "CosmosClient":
        return cs ? connStep({ path: [] }) : { account: argRef(args("accountEndpoint")), credential: args("authKeyOrResourceToken") ? "key" : credentialOf(args("tokenCredential")), root: true, path: [] };
      case "SecretClient":
      case "KeyClient":
      case "CertificateClient":
        return { account: argRef(args("vaultUri")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "ConfigurationClient":
        return cs ? connStep({ path: [] }) : { account: argRef(args("endpoint")), credential: credentialOf(args("credential")), root: true, path: [] };
      case "SqlConnection":
        return connStep({ path: [] });
    }
    return null;
  }
  switch (`${t}.${method}`) {
    case "ServiceBusClient.CreateSender":
      return { path: [argRef(args("queueOrTopicName"))] };
    case "ServiceBusClient.CreateReceiver":
    case "ServiceBusClient.CreateProcessor":
    case "ServiceBusClient.CreateSessionProcessor":
    case "ServiceBusClient.AcceptNextSessionAsync":
    case "ServiceBusClient.AcceptSessionAsync":
    case "ServiceBusClient.CreateRuleManager": {
      const sub = args("subscriptionName");
      return { path: sub ? [argRef(args("topicName")), argRef(sub)] : [argRef(args("queueName", "topicName"))] };
    }
    case "BlobServiceClient.GetBlobContainerClient":
      return { path: [argRef(args("blobContainerName"))] };
    case "BlobServiceClient.CreateBlobContainer":
    case "BlobServiceClient.CreateBlobContainerAsync":
      return { path: [argRef(args("blobContainerName"))] };
    case "BlobContainerClient.GetBlobClient":
    case "BlobContainerClient.GetBlockBlobClient":
    case "BlobContainerClient.GetAppendBlobClient":
    case "BlobContainerClient.GetPageBlobClient":
      return { path: [] };
    case "QueueServiceClient.GetQueueClient":
    case "QueueServiceClient.CreateQueue":
    case "QueueServiceClient.CreateQueueAsync":
      return { path: [argRef(args("queueName"))] };
    case "TableServiceClient.GetTableClient":
      return { path: [argRef(args("tableName"))] };
    case "CosmosClient.GetContainer":
      return { path: [argRef(args("databaseId")), argRef(args("containerId"))] };
    case "CosmosClient.GetDatabase":
    case "CosmosClient.CreateDatabaseIfNotExistsAsync":
    case "CosmosClient.CreateDatabaseAsync":
      return { path: [argRef(args("id"))] };
    case "Database.GetContainer":
      return { path: [argRef(args("id"))] };
    case "Database.CreateContainerIfNotExistsAsync":
    case "Database.CreateContainerAsync": {
      const props = args("containerProperties");
      return { path: [props?.kind === "new" ? argRef(argsOf(props.items)("id")) : argRef(args("id"))] };
    }
    case "DatabaseResponse.get_Database":
    case "ContainerResponse.get_Container":
      return { path: [] };
  }
  return null;
}

export interface OperationRule {
  type: RegExp;
  method: RegExp;
  operation: SdkUsage["operation"];
  relationship: RelationshipType;
  inbound?: boolean;
}

export const OPERATIONS: OperationRule[] = [
  { type: /^ServiceBusSender$/, method: /^(SendMessages?Async|ScheduleMessages?Async|SendMessages?|ScheduleMessages?)$/, operation: "publish", relationship: "PUBLISHES_TO" },
  { type: /^ServiceBus(Session)?Receiver$/, method: /^(ReceiveMessages?Async|ReceiveDeferredMessages?Async|PeekMessages?Async|CompleteMessageAsync|DeadLetterMessageAsync|AbandonMessageAsync|DeferMessageAsync)$/, operation: "receive", relationship: "RECEIVES_MESSAGE" },
  { type: /^ServiceBusClient$/, method: /^(CreateProcessor|CreateSessionProcessor)$/, operation: "consume", relationship: "CONSUMES_FROM" },
  { type: /^EventHub(Buffered)?ProducerClient$/, method: /^(SendAsync|Send|EnqueueEventsAsync|EnqueueEventAsync)$/, operation: "publish", relationship: "PUBLISHES_TO" },
  { type: /^(EventHubConsumerClient|PartitionReceiver)$/, method: /^(ReadEventsAsync|ReadEventsFromPartitionAsync|ReceiveBatchAsync)$/, operation: "consume", relationship: "CONSUMED_BY", inbound: true },
  { type: /^EventProcessorClient$/, method: /^(StartProcessingAsync|StartProcessing)$/, operation: "consume", relationship: "CONSUMED_BY", inbound: true },
  { type: /^EventGridPublisherClient$/, method: /^(SendEventAsync|SendEventsAsync|SendEvent|SendEvents|SendCloudEventAsync|SendCloudEventsAsync|SendCloudEvent|SendCloudEvents|SendEncodedCloudEventsAsync)$/, operation: "publish", relationship: "PUBLISHES_EVENT" },
  { type: /^(BlobClient|BlockBlobClient|AppendBlobClient|PageBlobClient|BlobBaseClient)$/, method: /^(Upload|Stage|Commit|Append|SetMetadata|SetHttpHeaders|SetTags|SetAccessTier|Delete|StartCopyFrom|SyncCopyFrom|OpenWrite|SyncUpload|Create)\w*$/, operation: "write", relationship: "WRITES_TO" },
  { type: /^(BlobClient|BlockBlobClient|AppendBlobClient|PageBlobClient|BlobBaseClient)$/, method: /^(Download|OpenRead|Exists|GetProperties|GetTags|GetBlockList)\w*$/, operation: "read", relationship: "READS_FROM" },
  { type: /^BlobContainerClient$/, method: /^(UploadBlob|DeleteBlob|SetMetadata|SetAccessPolicy)\w*$/, operation: "write", relationship: "WRITES_TO" },
  { type: /^BlobContainerClient$/, method: /^(GetBlobs|GetBlobsByHierarchy|FindBlobsByTags)\w*$/, operation: "read", relationship: "READS_FROM" },
  { type: /^QueueClient$/, method: /^(SendMessage|SendMessageAsync)$/, operation: "publish", relationship: "PUBLISHES_TO" },
  { type: /^QueueClient$/, method: /^(ReceiveMessages?|ReceiveMessages?Async|PeekMessages?|PeekMessages?Async|DeleteMessage|DeleteMessageAsync|UpdateMessage|UpdateMessageAsync)$/, operation: "receive", relationship: "RECEIVES_MESSAGE" },
  { type: /^TableClient$/, method: /^(AddEntity|UpsertEntity|UpdateEntity|DeleteEntity|SubmitTransaction)(Async)?$/, operation: "write", relationship: "WRITES_TO" },
  { type: /^TableClient$/, method: /^(GetEntity|GetEntityIfExists|Query)(Async)?$/, operation: "read", relationship: "READS_FROM" },
  { type: /^Container$/, method: /^(CreateItem|UpsertItem|ReplaceItem|DeleteItem|PatchItem|DeleteAllItemsByPartitionKey)(Stream)?Async$|^CreateTransactionalBatch$/, operation: "write", relationship: "WRITES_TO" },
  { type: /^Container$/, method: /^(ReadItem|ReadMany(Items)?)(Stream)?Async$/, operation: "read", relationship: "READS_FROM" },
  { type: /^Container$/, method: /^(GetItemQueryIterator|GetItemQueryStreamIterator|GetItemLinqQueryable)$/, operation: "query", relationship: "READS_FROM" },
  { type: /^Container$/, method: /^(GetChangeFeedProcessorBuilder|GetChangeFeedProcessorBuilderWithManualCheckpoint|GetChangeFeedIterator|GetChangeFeedStreamIterator|GetChangeFeedEstimatorBuilder)$/, operation: "change-feed", relationship: "CHANGE_FEED", inbound: true },
  { type: /^SecretClient$/, method: /^(GetSecret|GetPropertiesOfSecrets|GetPropertiesOfSecretVersions|GetDeletedSecret)(Async)?$/, operation: "secret-read", relationship: "READS_SECRET_FROM" },
  { type: /^SecretClient$/, method: /^(SetSecret|StartDeleteSecret|UpdateSecretProperties|PurgeDeletedSecret)(Async)?$/, operation: "secret-write", relationship: "WRITES_TO" },
  { type: /^KeyClient$/, method: /^(GetKey|GetPropertiesOfKeys)(Async)?$/, operation: "secret-read", relationship: "READS_SECRET_FROM" },
  { type: /^CertificateClient$/, method: /^(GetCertificate|GetCertificateVersion|GetPropertiesOfCertificates)(Async)?$/, operation: "secret-read", relationship: "READS_SECRET_FROM" },
  { type: /^ConfigurationClient$/, method: /^(GetConfigurationSetting|GetConfigurationSettings)(Async)?$/, operation: "read", relationship: "READS_FROM" },
];

/** Aspire client integrations (Aspire.*) and Microsoft.Extensions.Azure client builder registrations: method → registered client type. */
const ASPIRE_CLIENTS: Record<string, string> = {
  AzureServiceBusClient: "Azure.Messaging.ServiceBus.ServiceBusClient",
  AzureBlobClient: "Azure.Storage.Blobs.BlobServiceClient", AzureBlobServiceClient: "Azure.Storage.Blobs.BlobServiceClient", AzureBlobContainerClient: "Azure.Storage.Blobs.BlobContainerClient",
  AzureQueueClient: "Azure.Storage.Queues.QueueServiceClient", AzureQueueServiceClient: "Azure.Storage.Queues.QueueServiceClient",
  AzureTableClient: "Azure.Data.Tables.TableServiceClient", AzureTableServiceClient: "Azure.Data.Tables.TableServiceClient",
  AzureCosmosClient: "Microsoft.Azure.Cosmos.CosmosClient", AzureCosmosContainer: "Microsoft.Azure.Cosmos.Container", AzureCosmosDatabase: "Microsoft.Azure.Cosmos.Database",
  AzureEventHubProducerClient: "Azure.Messaging.EventHubs.Producer.EventHubProducerClient", AzureEventHubBufferedProducerClient: "Azure.Messaging.EventHubs.Producer.EventHubBufferedProducerClient",
  AzureEventHubConsumerClient: "Azure.Messaging.EventHubs.Consumer.EventHubConsumerClient", AzureEventProcessorClient: "Azure.Messaging.EventHubs.EventProcessorClient",
  AzurePartitionReceiverClient: "Azure.Messaging.EventHubs.Primitives.PartitionReceiver",
  AzureKeyVaultClient: "Azure.Security.KeyVault.Secrets.SecretClient", AzureKeyVaultSecretClient: "Azure.Security.KeyVault.Secrets.SecretClient",
  AzureKeyVaultKeyClient: "Azure.Security.KeyVault.Keys.KeyClient", AzureKeyVaultCertificateClient: "Azure.Security.KeyVault.Certificates.CertificateClient",
  SqlServerClient: "Microsoft.Data.SqlClient.SqlConnection",
};
const AZURE_BUILDER: Record<string, [string, (a: Args) => Step]> = {
  AddServiceBusClient: ["Azure.Messaging.ServiceBus.ServiceBusClient", (a) => ({ connection: argRef(a("connectionString")), credential: "connection-string", path: [] })],
  AddServiceBusClientWithNamespace: ["Azure.Messaging.ServiceBus.ServiceBusClient", (a) => ({ account: argRef(a("fullyQualifiedNamespace")), path: [] })],
  AddBlobServiceClient: ["Azure.Storage.Blobs.BlobServiceClient", (a) => (a("connectionString") ? { connection: argRef(a("connectionString")), credential: "connection-string", path: [] } : { account: argRef(a("serviceUri")), path: [] })],
  AddQueueServiceClient: ["Azure.Storage.Queues.QueueServiceClient", (a) => (a("connectionString") ? { connection: argRef(a("connectionString")), credential: "connection-string", path: [] } : { account: argRef(a("serviceUri")), path: [] })],
  AddTableServiceClient: ["Azure.Data.Tables.TableServiceClient", (a) => (a("connectionString") ? { connection: argRef(a("connectionString")), credential: "connection-string", path: [] } : { account: argRef(a("serviceUri")), path: [] })],
  AddSecretClient: ["Azure.Security.KeyVault.Secrets.SecretClient", (a) => ({ account: argRef(a("vaultUri")), path: [] })],
  AddKeyClient: ["Azure.Security.KeyVault.Keys.KeyClient", (a) => ({ account: argRef(a("vaultUri")), path: [] })],
  AddCertificateClient: ["Azure.Security.KeyVault.Certificates.CertificateClient", (a) => ({ account: argRef(a("vaultUri")), path: [] })],
  AddEventHubProducerClient: ["Azure.Messaging.EventHubs.Producer.EventHubProducerClient", (a) => ({ connection: argRef(a("connectionString")), credential: "connection-string", path: [argRef(a("eventHubName"))] })],
  AddEventHubProducerClientWithNamespace: ["Azure.Messaging.EventHubs.Producer.EventHubProducerClient", (a) => ({ account: argRef(a("fullyQualifiedNamespace")), path: [argRef(a("eventHubName"))] })],
  AddEventGridPublisherClient: ["Azure.Messaging.EventGrid.EventGridPublisherClient", (a) => ({ account: argRef(a("endpoint")), path: [] })],
  AddConfigurationClient: ["Azure.Data.AppConfiguration.ConfigurationClient", (a) => (a("connectionString") ? { connection: argRef(a("connectionString")), credential: "connection-string", path: [] } : { account: argRef(a("configurationStoreUri")), path: [] })],
};

function finish(service: SdkService, step: Step, via: string[], evidence: EvidenceLevel): ResourceAddress {
  return { service, account: step.account ?? null, path: step.path ?? [], connection: step.connection ?? null, credential: step.credential ?? null, via, evidence };
}

function merge(base: ResourceAddress, step: Step, label: string): ResourceAddress {
  return {
    ...base,
    account: step.account !== undefined && step.account !== null ? step.account : base.account,
    connection: step.connection ?? base.connection,
    credential: step.credential ?? base.credential,
    path: step.root ? (step.path ?? []) : [...base.path, ...(step.path ?? [])],
    via: [...base.via, label],
  };
}

class Resolver {
  private readonly assignments = new Map<string, AssignmentFact[]>();
  private readonly creationsByType = new Map<string, { creation: InvocationFact; projectId: string }[]>();

  constructor(private readonly index: SemanticIndex, readonly registrations: SdkRegistration[], private readonly appProjects: (projectId: string) => Set<string>) {
    for (const f of index.facts) {
      for (const a of f.assignments ?? []) this.assignments.set(a.member.key, [...(this.assignments.get(a.member.key) ?? []), a]);
      for (const c of f.creations ?? []) {
        const t = typeOf(c.receiverType);
        this.creationsByType.set(t, [...(this.creationsByType.get(t) ?? []), { creation: c, projectId: f.projectId }]);
      }
    }
  }

  /** Address of a client produced by the SDK type `type`, as configured by DI in the application of `projectId`. */
  fromContainer(type: string, projectId: string, depth: number, key: string | null = null): ResourceAddress | string {
    const service = serviceOf(type);
    if (!service) return `client type ${type} is not an analyzed Azure SDK client`;
    const scope = this.appProjects(projectId);
    const regs = this.registrations.filter((r) => r.clientType === type && scope.has(r.projectId) && (key === null || r.key === key));
    if (regs.length === 1) return { ...regs[0]!.address, via: [...regs[0]!.address.via, `dependency injection: single ${short(type)} registration in the application`], evidence: "STRUCTURALLY_RESOLVED" };
    if (regs.length > 1) return `${regs.length} ${short(type)} registrations in the application; the injected instance is ambiguous`;
    const created = (this.creationsByType.get(type) ?? []).filter((c) => scope.has(c.projectId));
    if (created.length === 1 && depth < 4) {
      const c = created[0]!;
      const step = stepOf(type, ".ctor", argsOf(c.creation.arguments));
      if (step) return finish(service, { ...step }, [`new ${short(type)}(...) at ${c.creation.location.file}:${c.creation.location.line} (the only construction site in the application)`], "INFERRED");
    }
    return created.length > 1 ? `${created.length} ${short(type)} construction sites in the application; the injected instance is ambiguous` : `${short(type)} is injected and no registration or construction is visible in the application`;
  }

  fromArg(a: ArgValue | undefined, projectId: string, depth: number): ResourceAddress | string {
    if (!a || depth > 6) return "client expression is not statically traceable";
    if (a.kind === "new" && a.symbol) {
      const type = typeOf(a.type);
      const service = serviceOf(type);
      const step = service ? stepOf(type, ".ctor", argsOf(a.items)) : null;
      return service && step ? finish(service, step, [`new ${short(type)}(...)`], "COMPILER_RESOLVED") : `construction of ${short(type)} is not an analyzed client factory`;
    }
    if (a.kind === "invocation" && a.symbol) {
      const owner = typeOf(a.symbol.containingType);
      const m = methodName(a.symbol);
      if (/^Microsoft\.Extensions\.DependencyInjection\.ServiceProvider(Service|KeyedService)Extensions$/.test(owner) && /^Get(Required)?(Keyed)?Service$/.test(m)) {
        const t = typeOf(a.typeArguments?.[0]);
        const key = a.items?.find((x) => x.parameter === "serviceKey");
        return t ? this.fromContainer(t, projectId, depth + 1, key?.kind === "string" ? (key.value ?? null) : null) : "service type not visible";
      }
      const step = stepOf(owner, m, argsOf(a.items));
      if (!step) return `${short(owner)}.${m} is not an analyzed client factory`;
      const base = this.fromContainer(owner, projectId, depth + 1);
      return typeof base === "string" ? base : merge(base, step, `${short(owner)}.${m}(...)`);
    }
    if (a.type && serviceOf(typeOf(a.type))) return this.fromContainer(typeOf(a.type), projectId, depth + 1);
    return "client expression is not statically traceable";
  }

  /** `[FromKeyedServices("k")]` on the parameter `name` of the caller or of its type's constructors. */
  private serviceKey(name: string, callerKey: string | null): string | null {
    if (!callerKey) return null;
    const caller = this.index.symbols.get(callerKey)?.symbol;
    if (!caller) return null;
    const candidates = [caller, ...(caller.containerKey ? (this.index.members.get(caller.containerKey) ?? []).filter((m) => m.kind === "Constructor") : [])];
    for (const c of candidates) {
      const p = c.parameters.find((x) => x.name === name);
      const a = p?.attributes.find((x) => /FromKeyedServicesAttribute$/.test(x.type.qualifiedName));
      if (a) return a.arguments[0]?.kind === "string" ? (a.arguments[0].value ?? null) : null;
    }
    return null;
  }

  /** The client assigned to a field/property: a factory call keeps its receiver chain (`_orders = client.GetContainer(...)`) through the invocation fact recorded at the same span. */
  private fromAssignment(a: AssignmentFact, projectId: string, depth: number, callerKey: string | null): ResourceAddress | string {
    const target = a.value.kind === "invocation" ? a.value.symbol : undefined;
    const call = target ? this.index.invocations.find((x) => x.invocation.caller === a.caller && x.invocation.target.key === target.key && x.invocation.location.file === a.location.file && within(x.invocation.location, a.location)) : undefined;
    if (!call) return this.fromArg(a.value, projectId, depth);
    const { invocation } = call;
    return this.fromReceiver({ expression: a.member.display, type: a.value.type, invocationTarget: invocation.target, invocationTypeArguments: invocation.typeArguments, invocationArguments: invocation.arguments, location: invocation.location, receiver: invocation.receiver }, typeOf(a.value.type), projectId, depth, callerKey);
  }

  fromReceiver(r: ReceiverFact | undefined, ownerType: string, projectId: string, depth: number, callerKey: string | null = null): ResourceAddress | string {
    if (!r) return this.fromContainer(ownerType, projectId, depth + 1);
    if (depth > 8) return "client derivation is too deep";
    if (r.invocationTarget) {
      const owner = typeOf(r.invocationTarget.containingType);
      const m = methodName(r.invocationTarget);
      const isCtor = r.invocationTarget.kind === "Constructor" || short(owner) === m;
      if (isCtor) {
        const service = serviceOf(owner);
        const step = service ? stepOf(owner, ".ctor", argsOf(r.invocationArguments)) : null;
        return service && step ? finish(service, step, [`new ${short(owner)}(...)`], "COMPILER_RESOLVED") : `construction of ${short(owner)} is not an analyzed client factory`;
      }
      if (/^Microsoft\.Extensions\.DependencyInjection\.ServiceProvider(Service|KeyedService)Extensions$/.test(owner) && /^Get(Required)?(Keyed)?Service$/.test(m)) {
        const t = typeOf(r.invocationTypeArguments?.[0]);
        const key = r.invocationArguments?.find((x) => x.parameter === "serviceKey");
        return t ? this.fromContainer(t, projectId, depth + 1, key?.kind === "string" ? (key.value ?? null) : null) : "service type not visible";
      }
      const step = stepOf(owner, m, argsOf(r.invocationArguments));
      if (!step) return `${short(owner)}.${m} is not an analyzed client factory`;
      const base = this.fromReceiver(r.receiver, owner, projectId, depth + 1, callerKey);
      return typeof base === "string" ? base : merge(base, step, `${short(owner)}.${m}(...)`);
    }
    if (r.symbol && r.symbol.kind === "Parameter") {
      const name = r.symbol.display.split(" ").pop() ?? "";
      return this.fromContainer(typeOf(r.type) || ownerType, projectId, depth + 1, this.serviceKey(name, callerKey));
    }
    if (r.symbol && (r.symbol.kind === "Field" || r.symbol.kind === "Property")) {
      const assigned = this.assignments.get(r.symbol.key) ?? [];
      const results = assigned.map((a) => this.fromAssignment(a, projectId, depth + 1, callerKey));
      const found = results.filter((x): x is ResourceAddress => typeof x !== "string");
      const distinct = new Set(found.map((x) => JSON.stringify([x.account, x.path, x.connection])));
      if (found.length && distinct.size === 1) return { ...found[0]!, via: [`${r.symbol.display} assigned from ${found[0]!.via.join(" → ")}`] };
      if (distinct.size > 1) return `${r.symbol.display} is assigned ${distinct.size} different clients`;
      return this.fromContainer(typeOf(r.type) || ownerType, projectId, depth + 1);
    }
    return this.fromContainer(typeOf(r.type) || ownerType, projectId, depth + 1);
  }
}

function registrationsOf(index: SemanticIndex): SdkRegistration[] {
  const out: SdkRegistration[] = [];
  for (const { invocation, owner, method, project } of index.invocations) {
    if (!owner) continue;
    const args = argsOf(invocation.arguments);
    const aspire = /^Microsoft\.Extensions\.Hosting\.Aspire\w*Extensions$/.test(owner) ? /^Add(Keyed)?(\w+?)(Client)?$/.exec(method) : null;
    if (aspire) {
      const name = Object.keys(ASPIRE_CLIENTS).find((k) => method === `Add${k}` || method === `AddKeyed${k}`);
      if (!name) continue;
      const clientType = ASPIRE_CLIENTS[name]!;
      const service = serviceOf(clientType)!;
      const connectionName = argRef(args("connectionName", "name"));
      if (!connectionName) continue;
      out.push({
        projectId: project.entityId, clientType, location: invocation.location, key: method.startsWith("AddKeyed") && connectionName.kind === "literal" ? connectionName.value : null,
        address: { service, account: null, path: [], connection: connectionName.kind === "literal" ? { kind: "setting", name: connectionName.value, via: "connection-name" } : connectionName, credential: "aspire-configured", via: [`${method}("${displayRef(connectionName)}")`], evidence: "COMPILER_RESOLVED" },
      });
      continue;
    }
    if (/^Microsoft\.Extensions\.Azure\.\w+ClientBuilderExtensions$/.test(owner) && AZURE_BUILDER[method]) {
      const [clientType, build] = AZURE_BUILDER[method]!;
      out.push({ projectId: project.entityId, clientType, location: invocation.location, key: null, address: finish(serviceOf(clientType)!, build(args), [`AddAzureClients: ${method}(...)`], "COMPILER_RESOLVED") });
    }
  }
  return out;
}

const DI_ADD = /^Microsoft\.Extensions\.DependencyInjection\.(ServiceCollectionServiceExtensions|ServiceCollectionDescriptorExtensions)$/;

/** `services.AddSingleton(sp => client.GetQueueClient("q"))` and keyed variants: the SDK factory call inside the registration lambda. */
function factoryRegistrations(index: SemanticIndex, resolver: Resolver): SdkRegistration[] {
  const out: SdkRegistration[] = [];
  for (const { invocation, owner, method, project } of index.invocations) {
    if (!owner || !DI_ADD.test(owner) || !/^(Try)?Add(Keyed)?(Singleton|Scoped|Transient)$/.test(method)) continue;
    const lambda = invocation.arguments.find((a) => a.kind === "lambda" && a.location);
    const clientType = typeOf(lambda?.returnedType ?? invocation.typeArguments[0]);
    if (!lambda?.location || !serviceOf(clientType)) continue;
    const span = lambda.location;
    const inside = index.invocations
      .filter((x) => x.invocation.location.file === span.file && within(x.invocation.location, span) && stepOf(x.owner ?? "", x.method, argsOf(x.invocation.arguments)))
      .sort((a, b) => (b.invocation.location.endLine * 100000 + b.invocation.location.endColumn - a.invocation.location.line * 0) - (a.invocation.location.endLine * 100000 + a.invocation.location.endColumn));
    const created = index.facts.flatMap((f) => (f.creations ?? []).filter((c) => typeOf(c.receiverType) === clientType && c.location.file === span.file && within(c.location, span)));
    if (created.length === 1) {
      const step = stepOf(clientType, ".ctor", argsOf(created[0]!.arguments));
      const keyArg = invocation.arguments.find((a) => a.parameter === "serviceKey");
      if (step) {
        out.push({ projectId: project.entityId, clientType, location: invocation.location, key: keyArg?.kind === "string" ? (keyArg.value ?? null) : null, address: finish(serviceOf(clientType)!, step, [`new ${short(clientType)}(...) in ${method}<${short(clientType)}> factory registration`], "COMPILER_RESOLVED") });
        continue;
      }
    }
    const outer = inside.find((x) => !inside.some((y) => y !== x && within(x.invocation.location, y.invocation.location) && !(y.invocation.location.line === x.invocation.location.line && y.invocation.location.column === x.invocation.location.column)));
    if (!outer) continue;
    const step = stepOf(outer.owner!, outer.method, argsOf(outer.invocation.arguments))!;
    const base = resolver.fromReceiver(outer.invocation.receiver, outer.owner!, project.entityId, 1, outer.invocation.caller);
    if (typeof base === "string") continue;
    const keyArg = invocation.arguments.find((a) => a.parameter === "serviceKey");
    out.push({ projectId: project.entityId, clientType, location: invocation.location, key: keyArg?.kind === "string" ? (keyArg.value ?? null) : null, address: { ...merge(base, step, `${short(outer.owner)}.${outer.method}(...)`), via: [...base.via, `${short(outer.owner)}.${outer.method}(...)`, `${method}<${short(clientType)}> factory registration`] } });
  }
  return out;
}

function within(l: FactLocation, span: FactLocation): boolean {
  const pos = (line: number, col: number) => line * 100000 + col;
  return pos(l.line, l.column) >= pos(span.line, span.column) && pos(l.endLine, l.endColumn) <= pos(span.endLine, span.endColumn);
}

function appProjectsOf(ctx: AnalysisContext, index: SemanticIndex): (projectId: string) => Set<string> {
  const apps = ctx.artifacts.get(APPLICATIONS);
  const cache = new Map<string, Set<string>>();
  return (projectId) => {
    const cached = cache.get(projectId);
    if (cached) return cached;
    const scope = new Set([projectId]);
    const owners = (apps?.applications ?? []).filter((a) => a.project.entityId === projectId || closure(index, a.project.entityId).has(projectId));
    for (const app of owners) for (const p of closure(index, app.project.entityId)) scope.add(p);
    cache.set(projectId, scope);
    return scope;
  };
}

function closure(index: SemanticIndex, projectId: string): Set<string> {
  const seen = new Set<string>([projectId]);
  const stack = [projectId];
  while (stack.length) for (const ref of index.projects.get(stack.pop()!)?.projectReferences ?? []) if (!seen.has(ref)) (seen.add(ref), stack.push(ref));
  return seen;
}

export const azureSdkPlugin: AnalysisPlugin = {
  id: SDK_PLUGIN,
  version: SDK_VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const facts: SdkFacts = { usages: [], registrations: [], dbContexts: [] };
    ctx.artifacts.set(AZURE_SDK, facts);
    const index = semanticIndex(ctx);
    if (!index) return;
    facts.registrations = registrationsOf(index);
    const resolver = new Resolver(index, facts.registrations, appProjectsOf(ctx, index));
    for (const reg of factoryRegistrations(index, resolver)) facts.registrations.push(reg);
    const entraId = () => ctx.graph.entity({
      key: azureKeys.entraId(), kind: "ExternalSystem", layer: "infrastructure", name: "Microsoft Entra ID", qualifiedName: "azure:entra-id", repositoryId: null, external: true,
      metadata: { systemKind: "identity-provider", provider: "azure", identity: "microsoft-entra-id" },
      provenance: azProv(ctx, SDK_PLUGIN, SDK_VERSION, "ENTRA_ID_IDENTITY", "azure-sdk-rules", null),
    });

    const usage = (entry: IndexedInvocation, rule: OperationRule, ownerType: string) => {
      const { invocation, project } = entry;
      const address = resolver.fromReceiver(invocation.receiver, ownerType, project.entityId, 0, invocation.caller);
      const service = serviceOf(ownerType)!;
      const details: Metadata = {};
      if (rule.operation === "query") {
        const q = invocation.arguments[0];
        const text = q?.kind === "string" ? q.value : q?.kind === "new" && q.items?.[0]?.kind === "string" ? q.items[0].value : null;
        if (text) details.query = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      }
      if (rule.relationship === "READS_SECRET_FROM") {
        const name = argRef(argsOf(invocation.arguments)("name"));
        if (name) details.secretName = displayRef(name);
      }
      facts.usages.push({
        callerKey: invocation.caller, projectId: project.entityId, location: invocation.location, clientType: ownerType, method: entry.method, operation: rule.operation, relationship: rule.relationship, inbound: rule.inbound === true,
        address: typeof address === "string" ? null : { ...address, service: address.service ?? service }, unresolved: typeof address === "string" ? address : null, details,
      });
    };

    for (const entry of index.invocations) {
      const owner = entry.owner ?? "";
      const t = short(owner);
      const receiverType = typeOf(entry.invocation.receiverType);
      const sdkType = serviceOf(owner) ? owner : serviceOf(receiverType) ? receiverType : null;
      if (sdkType) {
        const rule = OPERATIONS.find((r) => r.type.test(short(sdkType)) && r.method.test(entry.method)) ?? OPERATIONS.find((r) => r.type.test(t) && r.method.test(entry.method));
        if (rule) usage(entry, rule, sdkType);
        continue;
      }
      if (/^Microsoft\.Extensions\.Configuration\.AzureKeyVaultConfigurationExtensions$/.test(owner) && entry.method === "AddAzureKeyVault") {
        const a = argsOf(entry.invocation.arguments);
        facts.usages.push({ callerKey: entry.invocation.caller, projectId: entry.project.entityId, location: entry.invocation.location, clientType: "Azure.Extensions.AspNetCore.Configuration.Secrets", method: entry.method, operation: "secret-read", relationship: "READS_SECRET_FROM", inbound: false, address: { service: "key-vault", account: argRef(a("vaultUri", "vault")), path: [], connection: null, credential: credentialOf(a("credential")), via: ["configuration provider AddAzureKeyVault(...)"], evidence: "COMPILER_RESOLVED" }, unresolved: null, details: { secretName: "(all secrets as configuration)" } });
        continue;
      }
      if (/^Microsoft\.Extensions\.Hosting\.AspireKeyVaultExtensions$/.test(owner) && entry.method === "AddAzureKeyVaultSecrets") {
        const name = argRef(argsOf(entry.invocation.arguments)("connectionName"));
        facts.usages.push({ callerKey: entry.invocation.caller, projectId: entry.project.entityId, location: entry.invocation.location, clientType: "Aspire.Azure.Security.KeyVault", method: entry.method, operation: "secret-read", relationship: "READS_SECRET_FROM", inbound: false, address: { service: "key-vault", account: null, path: [], connection: name?.kind === "literal" ? { kind: "setting", name: name.value, via: "connection-name" } : name, credential: "aspire-configured", via: [`AddAzureKeyVaultSecrets(...)`], evidence: "COMPILER_RESOLVED" }, unresolved: null, details: { secretName: "(all secrets as configuration)" } });
        continue;
      }
      if (/^Microsoft\.Extensions\.Configuration\.AzureAppConfigurationExtensions$/.test(owner) && entry.method === "AddAzureAppConfiguration") {
        const a = argsOf(entry.invocation.arguments);
        const cs = a("connectionString");
        facts.usages.push({ callerKey: entry.invocation.caller, projectId: entry.project.entityId, location: entry.invocation.location, clientType: "Microsoft.Extensions.Configuration.AzureAppConfiguration", method: entry.method, operation: "read", relationship: "READS_FROM", inbound: false, address: { service: "app-configuration", account: null, path: [], connection: cs ? argRef(cs) : null, credential: cs ? "connection-string" : null, via: ["configuration provider AddAzureAppConfiguration(...)"], evidence: "COMPILER_RESOLVED" }, unresolved: cs ? null : "App Configuration endpoint is configured inside an options callback", details: {} });
        continue;
      }
      const ef = /^Microsoft\.EntityFrameworkCore\.SqlServerDbContextOptionsExtensions$|^Microsoft\.EntityFrameworkCore\.SqlServerDbContextOptionsBuilderExtensions$|^Microsoft\.EntityFrameworkCore\.AzureSqlDbContextOptionsExtensions$/.test(owner) && /^Use(SqlServer|AzureSql)$/.test(entry.method);
      const aspireEf = /^Microsoft\.Extensions\.Hosting\.AspireSqlServerEFCoreSqlClientExtensions$/.test(owner) && /^(AddSqlServerDbContext|EnrichSqlServerDbContext)$/.test(entry.method);
      if (ef || aspireEf) {
        const a = argsOf(entry.invocation.arguments);
        const conn = aspireEf ? argRef(a("connectionName")) : argRef(a("connectionString", "connection"));
        const contextType = aspireEf ? entry.invocation.typeArguments[0] : (entry.invocation.receiverType?.typeArguments?.[0] ?? enclosingDbContext(index, entry.invocation));
        facts.dbContexts.push({
          contextKey: contextType?.key ?? (index.symbols.get(entry.invocation.caller)?.symbol.containerKey ?? null), projectId: entry.project.entityId, location: entry.invocation.location, callerKey: entry.invocation.caller,
          address: { service: "sql", account: null, path: [], connection: conn?.kind === "literal" && aspireEf ? { kind: "setting", name: conn.value, via: "connection-name" } : conn, credential: null, via: [`${entry.method}(...)`], evidence: "COMPILER_RESOLVED" },
        });
      }
    }

    for (const f of index.facts) {
      const project = index.projects.get(f.projectId);
      if (!project) continue;
      for (const c of f.creations ?? []) {
        const type = typeOf(c.receiverType);
        const kind = CREDENTIALS[short(type)];
        if (!kind || !/^Azure\.(Identity|Core|Storage|AzureKeyCredential)/.test(type) && !/^Azure\.(AzureKeyCredential|AzureSasCredential|AzureNamedKeyCredential)$/.test(type)) continue;
        const callerId = entityIdOf(ctx, c.caller);
        const p = azProv(ctx, SDK_PLUGIN, SDK_VERSION, "AZURE_CREDENTIAL", "roslyn-semantic-model+azure-sdk-rules", c.location);
        const clientId = argRef(argsOf(c.arguments)("clientId"));
        const meta: Metadata = { credentialType: kind, credentialClass: type, ...(clientId ? { managedIdentityClientId: displayRef(clientId) } : {}), secretBased: ["client-secret", "username-password", "key", "sas", "shared-key"].includes(kind) };
        if (["key", "sas", "shared-key"].includes(kind)) {
          azRelate(ctx, "AUTHENTICATES_WITH", callerId, entraId(), "COMPILER_RESOLVED", p, { ...meta, note: "shared key/SAS credential: authenticates to the resource directly, not through Entra ID" }, 0.5);
          continue;
        }
        azRelate(ctx, "AUTHENTICATES_WITH", callerId, entraId(), "COMPILER_RESOLVED", p, meta);
      }
      for (const inv of f.invocations) {
        const owner = (inv.target.containingType?.qualifiedName ?? "").replace(/<.*$/, "");
        if (!/^Microsoft\.Identity\.Web\./.test(owner) || !/^AddMicrosoftIdentityWeb(Api|App|ApiAuthentication|AppAuthentication)$/.test(methodName(inv.target))) continue;
        const p = azProv(ctx, SDK_PLUGIN, SDK_VERSION, "MICROSOFT_IDENTITY_WEB", "roslyn-semantic-model+azure-sdk-rules", inv.location);
        azRelate(ctx, "AUTHENTICATES_WITH", entityIdOf(ctx, inv.caller), entraId(), "COMPILER_RESOLVED", p, { credentialType: "entra-id-token-validation", method: methodName(inv.target), configurationSection: argRef(inv.arguments.find((a) => a.parameter === "configSectionName")) ? displayRef(argRef(inv.arguments.find((a) => a.parameter === "configSectionName"))) : "AzureAd" });
      }
    }
    for (const u of facts.usages.filter((x) => x.unresolved)) {
      azUnresolved(ctx, SDK_PLUGIN, {
        type: u.relationship, sourceId: entityIdOf(ctx, u.callerKey), display: `${short(u.clientType)}.${u.method}`, reason: u.unresolved!, category: "unresolved-azure-client",
        provenance: azProv(ctx, SDK_PLUGIN, SDK_VERSION, "AZURE_SDK_USAGE", "roslyn-semantic-model+azure-sdk-rules", u.location), metadata: { service: serviceOf(u.clientType) ?? u.clientType, operation: u.operation },
      });
    }
    ctx.log.info("azure.sdk", { usages: facts.usages.length, unresolved: facts.usages.filter((u) => u.unresolved).length, registrations: facts.registrations.length, dbContexts: facts.dbContexts.length });
  },
};

function enclosingDbContext(index: SemanticIndex, inv: InvocationFact): SymRef | undefined {
  for (const { invocation, owner, method } of index.invocations) {
    if (owner !== "Microsoft.Extensions.DependencyInjection.EntityFrameworkServiceCollectionExtensions" || !/^Add(DbContext|DbContextPool|DbContextFactory|PooledDbContextFactory)$/.test(method)) continue;
    const lambda = invocation.arguments.find((a) => a.kind === "lambda" && a.location && a.location.file === inv.location.file && inv.location.line >= a.location.line && inv.location.line <= (a.location.endLine || a.location.line));
    if (lambda) return invocation.typeArguments[0];
  }
  return undefined;
}

