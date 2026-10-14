import { apiResolverPlugin } from "../contracts/api-resolver.ts";
import { messageResolverPlugin } from "../contracts/message-resolver.ts";
import { openApiPlugin } from "../contracts/openapi-plugin.ts";
import { csharpSyntaxPlugin } from "../dotnet/csharp-syntax.ts";
import { applicationsPlugin } from "../dotnet/frameworks/applications.ts";
import { aspNetCorePlugin } from "../dotnet/frameworks/aspnetcore/index.ts";
import { configurationPlugin } from "../dotnet/frameworks/configuration.ts";
import { dependencyInjectionPlugin } from "../dotnet/frameworks/dependency-injection.ts";
import { httpClientsPlugin } from "../dotnet/frameworks/http-clients.ts";
import { azureServiceBusPlugin } from "../dotnet/frameworks/messaging/azure-service-bus.ts";
import { configuredMessagingPlugin } from "../dotnet/frameworks/messaging/configured.ts";
import { kafkaPlugin } from "../dotnet/frameworks/messaging/kafka.ts";
import { massTransitPlugin } from "../dotnet/frameworks/messaging/masstransit.ts";
import { mediatrPlugin } from "../dotnet/frameworks/messaging/mediatr.ts";
import { nServiceBusPlugin } from "../dotnet/frameworks/messaging/nservicebus.ts";
import { rabbitMqPlugin } from "../dotnet/frameworks/messaging/rabbitmq.ts";
import { msbuildPlugin } from "../dotnet/projects.ts";
import { createRoslynPlugin } from "../dotnet/roslyn.ts";
import { appConfigurationPlugin } from "../infrastructure/app-configuration-plugin.ts";
import { dockerPlugin } from "../infrastructure/docker-plugin.ts";
import { helmPlugin } from "../infrastructure/helm-plugin.ts";
import { kubernetesPlugin } from "../infrastructure/kubernetes-plugin.ts";
import { azurePipelinesPlugin } from "../infrastructure/pipeline-plugin.ts";
import { infrastructureResolverPlugin } from "../infrastructure/resolver.ts";
import { codeOwnersPlugin } from "../ownership/codeowners-plugin.ts";
import { angularPlugin } from "../frontend/angular.ts";
import { frontendHttpPlugin } from "../frontend/http.ts";
import { reactPlugin } from "../frontend/react.ts";
import { frontendModulesPlugin } from "../frontend/modules.ts";
import { typescriptSemanticPlugin } from "../frontend/semantic.ts";
import { typescriptSyntaxPlugin } from "../frontend/syntax.ts";
import { frontendWorkspacePlugin } from "../frontend/workspace.ts";
import { azureFunctionsPlugin } from "../azure/functions.ts";
import { azureSdkPlugin } from "../azure/sdk.ts";
import { azureAspirePlugin } from "../azure/aspire.ts";
import { azureTypeScriptPlugin } from "../azure/typescript.ts";
import { azureResolverPlugin } from "../azure/resolver.ts";
import { azureInfrastructurePlugin } from "../azure/infrastructure.ts";
import type { Plugin } from "./types.ts";

export const ANALYZER_GROUPS = [
  { id: "dotnet", label: ".NET", description: "MSBuild, C# syntax and semantics, ASP.NET Core, configuration, HTTP and messaging." },
  { id: "frontend", label: "Frontend", description: "JavaScript and TypeScript workspaces, syntax, semantics, Angular, React and HTTP." },
  { id: "azure", label: "Azure", description: "Azure infrastructure, Functions, SDKs and Aspire. C# and TypeScript extraction require the .NET and frontend groups respectively." },
  { id: "infrastructure", label: "Infrastructure", description: "Docker, pipelines, Helm, Kubernetes and application configuration." },
  { id: "contracts", label: "Contracts", description: "OpenAPI contracts and API/messaging resolution using facts from the selected language groups." },
  { id: "ownership", label: "Ownership", description: "CODEOWNERS ownership rules." },
] as const;

const GROUP_PLUGINS: Record<(typeof ANALYZER_GROUPS)[number]["id"], readonly Plugin[]> = {
  dotnet: [msbuildPlugin, csharpSyntaxPlugin, createRoslynPlugin(), applicationsPlugin, dependencyInjectionPlugin, aspNetCorePlugin, configurationPlugin, httpClientsPlugin, mediatrPlugin, massTransitPlugin, nServiceBusPlugin, azureServiceBusPlugin, rabbitMqPlugin, kafkaPlugin, configuredMessagingPlugin],
  frontend: [frontendWorkspacePlugin, typescriptSyntaxPlugin, frontendModulesPlugin, typescriptSemanticPlugin, frontendHttpPlugin, angularPlugin, reactPlugin],
  azure: [azureFunctionsPlugin, azureSdkPlugin, azureAspirePlugin, azureTypeScriptPlugin, azureInfrastructurePlugin, azureResolverPlugin],
  infrastructure: [dockerPlugin, azurePipelinesPlugin, helmPlugin, kubernetesPlugin, appConfigurationPlugin, infrastructureResolverPlugin],
  contracts: [openApiPlugin, apiResolverPlugin, messageResolverPlugin],
  ownership: [codeOwnersPlugin],
};

export function selectAnalyzerPlugins(plugins: readonly Plugin[], groupIds?: readonly string[]): Plugin[] {
  if (groupIds === undefined) return [...plugins];
  const selected = new Set<string>();
  for (const id of groupIds) {
    if (!Object.hasOwn(GROUP_PLUGINS, id)) throw new Error(`unknown analyzer group '${id}'`);
    for (const plugin of GROUP_PLUGINS[id as keyof typeof GROUP_PLUGINS]) selected.add(plugin.id);
  }
  const known = new Set(Object.values(GROUP_PLUGINS).flat().map((plugin) => plugin.id));
  return plugins.filter((plugin) => selected.has(plugin.id) || !known.has(plugin.id));
}

export function defaultPlugins(): Plugin[] {
  return [
    msbuildPlugin,
    frontendWorkspacePlugin,
    csharpSyntaxPlugin,
    typescriptSyntaxPlugin,
    createRoslynPlugin(),
    frontendModulesPlugin,
    typescriptSemanticPlugin,
    applicationsPlugin,
    dependencyInjectionPlugin,
    aspNetCorePlugin,
    configurationPlugin,
    azureFunctionsPlugin,
    azureSdkPlugin,
    azureAspirePlugin,
    azureTypeScriptPlugin,
    httpClientsPlugin,
    frontendHttpPlugin,
    angularPlugin,
    reactPlugin,
    mediatrPlugin,
    massTransitPlugin,
    nServiceBusPlugin,
    azureServiceBusPlugin,
    rabbitMqPlugin,
    kafkaPlugin,
    configuredMessagingPlugin,
    openApiPlugin,
    apiResolverPlugin,
    messageResolverPlugin,
    dockerPlugin,
    azurePipelinesPlugin,
    helmPlugin,
    kubernetesPlugin,
    appConfigurationPlugin,
    azureInfrastructurePlugin,
    infrastructureResolverPlugin,
    azureResolverPlugin,
    codeOwnersPlugin,
  ];
}
