import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashOf } from "../graph/identity.ts";

function sources(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith(".ts") ? [path] : [];
  });
}

/** Hash of every Azure analyzer source file: part of each Azure plugin version, so cached Azure facts are never replayed after an analyzer change. */
export const AZURE_SOURCE_HASH = hashOf(...sources(import.meta.dir).map((p) => `${p.slice(import.meta.dir.length)}\n${readFileSync(p, "utf8")}`)).slice(0, 12);

/** Version of the IaC parsers (Bicep, ARM, Terraform); part of every parse-cache key. */
export const IAC_PARSER_VERSION = hashOf(...sources(join(import.meta.dir, "iac")).map((p) => readFileSync(p, "utf8"))).slice(0, 12);
