import type { Entity } from "../../graph/model.ts";
import serviceBus from "./icons/azure-service-bus.svg" with { type: "text" };
import functions from "./icons/azure-functions.svg" with { type: "text" };
import storage from "./icons/azure-storage.svg" with { type: "text" };
import cosmos from "./icons/azure-cosmos-db.svg" with { type: "text" };
import keyVault from "./icons/azure-key-vault.svg" with { type: "text" };
import appService from "./icons/azure-app-service.svg" with { type: "text" };
import sql from "./icons/azure-sql.svg" with { type: "text" };
import terraform from "./icons/terraform.svg" with { type: "text" };
import helm from "./icons/helm.svg" with { type: "text" };
import kubernetes from "./icons/kubernetes.svg" with { type: "text" };
import docker from "./icons/docker.svg" with { type: "text" };

const definitions = {
  "azure-service-bus": ["Azure Service Bus", serviceBus],
  "azure-functions": ["Azure Functions", functions],
  "azure-storage": ["Azure Storage", storage],
  "azure-cosmos-db": ["Azure Cosmos DB", cosmos],
  "azure-key-vault": ["Azure Key Vault", keyVault],
  "azure-app-service": ["Azure App Service", appService],
  "azure-sql": ["Azure SQL Database", sql],
  terraform: ["Terraform", terraform],
  helm: ["Helm", helm],
  kubernetes: ["Kubernetes", kubernetes],
  docker: ["Docker", docker],
} as const;
export type TechnologyId = keyof typeof definitions;
export const technologyIcons = Object.fromEntries(
  Object.entries(definitions).map(([id, [label, svg]]) => [
    id,
    {
      id,
      label,
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    },
  ]),
) as Record<TechnologyId, { id: TechnologyId; label: string; src: string }>;

export function technologyOf(entity: Entity): TechnologyId | null {
  const service =
    typeof entity.metadata.service === "string"
      ? entity.metadata.service.toLowerCase()
      : "";
  const arm =
    typeof entity.metadata.armType === "string"
      ? entity.metadata.armType.toLowerCase()
      : "";
  const azureKind =
    typeof entity.metadata.azureKind === "string"
      ? entity.metadata.azureKind
      : "";
  if (entity.kind === "AzureResource" || entity.kind === "AzureFunction") {
    if (
      entity.kind === "AzureFunction" ||
      azureKind === "function-app" ||
      azureKind === "functionapp"
    )
      return "azure-functions";
    if (service === "service-bus" || arm.startsWith("microsoft.servicebus/"))
      return "azure-service-bus";
    if (service === "cosmos-db" || arm.startsWith("microsoft.documentdb/"))
      return "azure-cosmos-db";
    if (service === "key-vault" || arm.startsWith("microsoft.keyvault/"))
      return "azure-key-vault";
    if (service === "storage" || arm.startsWith("microsoft.storage/"))
      return "azure-storage";
    if (service === "app-service") return "azure-app-service";
    if (
      azureKind === "sql-database" ||
      /^microsoft\.sql\/servers\/databases(?:\/|$)/.test(arm)
    )
      return "azure-sql";
  }
  if (entity.kind === "HelmChart" || entity.kind === "HelmRelease")
    return "helm";
  if (
    entity.kind.startsWith("Kubernetes") ||
    ["Deployment", "ServiceAccount"].includes(entity.kind)
  )
    return "kubernetes";
  if (
    ["Dockerfile", "DockerStage"].includes(entity.kind) ||
    entity.provenance.some((item) => item.plugin === "infrastructure.docker")
  )
    return "docker";
  if (entity.kind === "File") {
    const file = entity.location?.file ?? entity.qualifiedName ?? "";
    if (
      entity.language === "terraform" ||
      /\.(tf|tfvars)(\.json)?$/i.test(file)
    )
      return "terraform";
    if (/(^|\/)Chart\.ya?ml$/i.test(file)) return "helm";
    if (/(^|\/)Dockerfile(?:[.][^/]*)?$/i.test(file)) return "docker";
  }
  return null;
}

export function declarationTechnologies(entity: Entity): TechnologyId[] {
  const tools: TechnologyId[] = [];
  if (
    Array.isArray(entity.metadata.declaredIn) &&
    entity.metadata.declaredIn.some((value) => value === "terraform")
  )
    tools.push("terraform");
  if (
    entity.metadata.sourceScope === "helm-release" ||
    entity.provenance.some((item) => item.plugin === "infrastructure.helm")
  )
    tools.push("helm");
  return tools.filter((id) => id !== technologyOf(entity));
}
