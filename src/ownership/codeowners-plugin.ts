import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { infraDiagnostic, infraEntity, infraProvenance } from "../infrastructure/common.ts";

const ID = "ownership.codeowners";
const VERSION = "1";
const LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS"];
const OWNER = /^(@[\w.-]+(\/[\w.-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

export const codeOwnersPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "workspace",
  async run(ctx: AnalysisContext) {
    const present = LOCATIONS.filter((l) => ctx.files.some((f) => f.path === l));
    if (!present.length) return;
    const file = present[0]!;
    if (present.length > 1) infraDiagnostic(ctx, ID, present[1]!, "codeowners-shadowed", `${present.slice(1).join(", ")} ignored: ${file} takes precedence`);
    const lines = (await ctx.readText(file)).split(/\r?\n/);
    let order = 0;
    let section: string | null = null;
    for (const [i, raw] of lines.entries()) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line) continue;
      const sectionMatch = /^\^?\[([^\]]+)\](\[\d+\])?(\s+.*)?$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1]!.trim();
        continue;
      }
      const [pattern, ...tokens] = line.split(/\s+/);
      const owners = tokens.filter((t) => OWNER.test(t));
      const invalid = tokens.filter((t) => !OWNER.test(t));
      if (invalid.length) infraDiagnostic(ctx, ID, file, "codeowners-invalid-owner", `line ${i + 1}: ignored owner token(s) ${invalid.join(" ")}`);
      order++;
      infraEntity(ctx, {
        key: `ownership-rule|${ctx.repository.id}|${file}|${order}`,
        kind: "OwnershipRule",
        name: pattern!,
        qualifiedName: `${file}:${i + 1}:${pattern}`,
        file,
        line: i + 1,
        metadata: { source: "CODEOWNERS", pattern: pattern!, owners: owners.sort(), order, section, unowned: owners.length === 0 },
      }, infraProvenance(ctx, ID, VERSION, "CODEOWNERS_RULE", "codeowners-static", file, i + 1));
    }
  },
};
