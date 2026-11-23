import { expect, test } from "bun:test";
import type { Entity } from "../../src/graph/model.ts";
import {
  declarationTechnologies,
  technologyIcons,
  technologyOf,
} from "../../src/local/web/technology-icons.ts";

function entity(
  kind: Entity["kind"],
  metadata: Entity["metadata"] = {},
  file: string | null = null,
): Entity {
  return {
    id: "test",
    key: "test",
    kind,
    name: "arbitrary-name",
    qualifiedName: null,
    layer: "infrastructure",
    repositoryId: "repo",
    projectId: null,
    assembly: null,
    language: null,
    symbolKey: null,
    location: file ? { file, startLine: 1, startColumn: 1 } : null,
    external: false,
    metadata,
    provenance: [],
  };
}

test("Azure product icons follow service metadata and ARM provider types, not display names", () => {
  for (const [service, icon] of [
    ["service-bus", "azure-service-bus"],
    ["storage", "azure-storage"],
    ["cosmos-db", "azure-cosmos-db"],
    ["key-vault", "azure-key-vault"],
    ["app-service", "azure-app-service"],
  ])
    expect(technologyOf(entity("AzureResource", { service }))).toBe(icon);
  expect(
    technologyOf(
      entity("AzureResource", {
        armType: "Microsoft.ServiceBus/namespaces/topics",
      }),
    ),
  ).toBe("azure-service-bus");
  expect(
    technologyOf(
      entity("AzureResource", { armType: "Microsoft.Sql/servers/databases" }),
    ),
  ).toBe("azure-sql");
  expect(
    technologyOf(
      entity("AzureResource", {
        azureKind: "function-app",
        service: "app-service",
      }),
    ),
  ).toBe("azure-functions");
  const role = entity("AzureResource", {
    service: "authorization",
    armType: "Microsoft.Authorization/roleAssignments",
  });
  role.name = "servicebus-terraform-helm-role";
  expect(technologyOf(role)).toBeNull();
  expect(
    technologyOf(entity("Application", { service: "service-bus" })),
  ).toBeNull();
});

test("Terraform provenance is secondary to the actual Azure service identity", () => {
  const resource = entity(
    "AzureResource",
    { service: "service-bus", declaredIn: ["bicep", "terraform"] },
    "infra/main.tf",
  );
  expect(technologyOf(resource)).toBe("azure-service-bus");
  expect(declarationTechnologies(resource)).toEqual(["terraform"]);
  expect(
    declarationTechnologies(entity("AzureResource", { declaredIn: ["bicep"] })),
  ).toEqual([]);
});

test("Helm, Kubernetes and Terraform file icons use known kinds or file formats", () => {
  expect(technologyOf(entity("HelmChart"))).toBe("helm");
  expect(technologyOf(entity("HelmRelease"))).toBe("helm");
  expect(technologyOf(entity("KubernetesService"))).toBe("kubernetes");
  const workload = entity("Deployment", { sourceScope: "helm-release" });
  expect(technologyOf(workload)).toBe("kubernetes");
  expect(declarationTechnologies(workload)).toEqual(["helm"]);
  expect(technologyOf(entity("File", {}, "infra/main.tf"))).toBe("terraform");
  expect(technologyOf(entity("File", {}, "infra/values.tfvars.json"))).toBe(
    "terraform",
  );
  expect(technologyOf(entity("File", {}, "charts/app/Chart.yaml"))).toBe(
    "helm",
  );
  expect(technologyOf(entity("File", {}, "source/servicebus.cs"))).toBeNull();
  expect(technologyOf(entity("Dockerfile"))).toBe("docker");
  expect(technologyOf(entity("ContainerImage"))).toBeNull();
});

test("every bundled brand icon is an inert inline SVG with no remote dependencies", () => {
  for (const icon of Object.values(technologyIcons)) {
    expect(icon.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const svg = decodeURIComponent(icon.src.split(",").slice(1).join(","));
    expect(svg).toContain("<svg");
    expect(svg).not.toMatch(/<script|<image|(?:href|src)=["']https?:/i);
    expect(icon.label.length).toBeGreaterThan(0);
  }
});
