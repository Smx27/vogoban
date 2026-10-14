import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Chalk } from "chalk";
import figlet from "figlet";
import { stdin, stdout } from "node:process";
import { ANALYZER_GROUPS } from "../plugins/registry.ts";
import {
  validateWorkspaceConfig,
  WorkspaceConfigError,
  type LocalWorkspaceConfig,
  type RepositoryDetection,
} from "../local/workspace.ts";

export const terminalStyle = new Chalk({
  level:
    stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb"
      ? typeof stdout.getColorDepth === "function" && stdout.getColorDepth() >= 24
        ? 3
        : typeof stdout.getColorDepth === "function" && stdout.getColorDepth() >= 8
          ? 2
          : 1
      : 0,
});

const promptTheme = {
  prefix: { idle: terminalStyle.cyan("?"), done: terminalStyle.green("✓") },
  spinner: {
    interval: 80,
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map((frame) =>
      terminalStyle.yellow(frame),
    ),
  },
  icon: {
    checked: terminalStyle.green("●"),
    unchecked: "○",
    cursor: "›",
    disabledChecked: "●",
    disabledUnchecked: "-",
  },
  style: {
    answer: (text: string) => terminalStyle.cyan(text),
    message: (text: string) => terminalStyle.bold(text),
    error: (text: string) => terminalStyle.red(`> ${text}`),
    defaultAnswer: (text: string) => terminalStyle.dim(`(${text})`),
    help: (text: string) => terminalStyle.dim(text),
    highlight: (text: string) => terminalStyle.cyan(text),
    key: (text: string) => terminalStyle.cyan(`<${text}>`),
    disabled: (text: string) => terminalStyle.dim(text),
    description: (text: string) => terminalStyle.dim(text),
    keysHelpTip: (keys: [string, string][]) =>
      keys
        .map(
          ([key, action]) =>
            `${terminalStyle.cyan(key)} ${terminalStyle.dim(action)}`,
        )
        .join(" · "),
    confirmDefault: (text: string) => text.toUpperCase(),
  },
};

export function interactiveTerminal(options: {
  json?: boolean;
  "no-interactive"?: boolean;
  yes?: boolean;
}): boolean {
  return (
    !!stdin.isTTY &&
    !!stdout.isTTY &&
    !options.json &&
    !options["no-interactive"] &&
    !options.yes &&
    !process.env.CI &&
    process.env.TERM !== "dumb"
  );
}

export type WorkspaceFlags = {
  analyzers?: string;
  exclude?: string;
  semantic?: boolean;
  "no-semantic"?: boolean;
  incremental?: boolean;
  "no-incremental"?: boolean;
  snapshots?: boolean;
  "no-snapshots"?: boolean;
  open?: boolean;
  "no-open"?: boolean;
};

export function workspaceOverrides(flags: WorkspaceFlags): {
  analysis: Partial<LocalWorkspaceConfig["analysis"]>;
  ui: Partial<LocalWorkspaceConfig["ui"]>;
} {
  const analysis: Partial<LocalWorkspaceConfig["analysis"]> = {};
  const ui: Partial<LocalWorkspaceConfig["ui"]> = {};
  if (flags.analyzers !== undefined) {
    const ids =
      flags.analyzers === "none"
        ? []
        : flags.analyzers.split(",").map((id) => id.trim());
    if (ids.some((id) => !ANALYZER_GROUPS.some((group) => group.id === id)))
      throw new WorkspaceConfigError(
        `--analyzers must be a comma-separated selection of ${ANALYZER_GROUPS.map((group) => group.id).join(", ")}, or none.`,
      );
    analysis.analyzers = [...new Set(ids)];
  }
  if (flags.exclude !== undefined)
    analysis.exclusions = (flags.exclude.trim() === "none" ? "" : flags.exclude)
      .split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean);
  for (const key of ["semantic", "incremental", "snapshots"] as const) {
    const disabled = flags[`no-${key}`];
    if (flags[key] && disabled)
      throw new WorkspaceConfigError(
        `--${key} and --no-${key} cannot be used together.`,
      );
    if (disabled) analysis[key] = false;
    else if (flags[key] !== undefined) analysis[key] = flags[key];
  }
  if (flags.open && flags["no-open"])
    throw new WorkspaceConfigError(
      "--open and --no-open cannot be used together.",
    );
  if (flags["no-open"]) ui.openAfterAnalysis = false;
  else if (flags.open) ui.openAfterAnalysis = true;
  return { analysis, ui };
}

export function applyWorkspaceOverrides(
  config: LocalWorkspaceConfig,
  overrides: ReturnType<typeof workspaceOverrides>,
): LocalWorkspaceConfig {
  const next = {
    ...config,
    analysis: { ...config.analysis, ...overrides.analysis },
    ui: { ...config.ui, ...overrides.ui },
  };
  validateWorkspaceConfig(next);
  return next;
}

export function workspaceSummary(config: LocalWorkspaceConfig): string {
  const label = (value: boolean) =>
    value ? terminalStyle.green("on") : terminalStyle.dim("off");
  return [
    `  Analyzers: ${config.analysis.analyzers.join(", ") || "discovery only"}`,
    `  Exclude: ${config.analysis.exclusions.join(", ") || "none (built-in safety exclusions remain)"}`,
    `  Semantic analysis: ${label(config.analysis.semantic ?? true)}`,
    `  Incremental graph sync: ${label(config.analysis.incremental)}`,
    `  Snapshot capture: ${label(config.analysis.snapshots)}`,
    `  Open graph after interactive analysis: ${label(config.ui.openAfterAnalysis)}`,
  ].join("\n");
}

export async function workspaceWizard(
  config: LocalWorkspaceConfig,
  detection: RepositoryDetection,
  reconfigure: boolean,
): Promise<LocalWorkspaceConfig | null> {
  const title =
    (stdout.columns ?? 80) >= 60
      ? figlet.textSync("Vogoban", { font: "Small" })
      : "Vogoban";
  console.log(terminalStyle.hex("#8bd2bf")(title));
  console.log(
    terminalStyle.bold(
      reconfigure ? "Configure this repository" : "Initialize this repository",
    ),
  );
  console.log(`  ${detection.root}`);
  console.log(
    terminalStyle.dim(
      `  ${[...detection.languages, ...detection.frameworks].join(" · ") || "No specialized repository signals detected"}`,
    ),
  );
  console.log(
    terminalStyle.dim(
      "  Local only. No account, uploads, or changes to your existing graph.\n",
    ),
  );
  const scope = await select({
    theme: promptTheme,
    message: "Choose analysis scope",
    choices: [
      ...(reconfigure
        ? [
            {
              value: "current",
              name: "Keep current analyzers",
              description:
                config.analysis.analyzers.join(", ") || "Discovery only",
            },
          ]
        : []),
      {
        value: "detected",
        name: "Recommended for this repository",
        description:
          detection.analyzers.join(", ") ||
          "Discovery only; customize to enable analyzers",
      },
      { value: "full", name: "Full — all supported analyzers" },
      { value: "minimal", name: "Minimal — detected language analyzers only" },
      { value: "custom", name: "Custom — select analyzer groups" },
      { value: "none", name: "Discovery only — no analyzer plugins" },
    ],
  });
  const analyzers =
    scope === "full"
      ? ANALYZER_GROUPS.map((group) => group.id)
      : scope === "detected"
        ? detection.analyzers
        : scope === "minimal"
          ? detection.analyzers.filter(
              (id) => id === "dotnet" || id === "frontend",
            )
          : scope === "none"
            ? []
            : scope === "custom"
              ? await checkbox({
                  theme: promptTheme,
                  message: "Analyzer groups (Space toggles, Enter continues)",
                  choices: ANALYZER_GROUPS.map((group) => ({
                    value: group.id,
                    name: `${group.label} — ${group.description}`,
                    checked: config.analysis.analyzers.includes(group.id),
                  })),
                  validate: (values) =>
                    values.length > 0 || "Select at least one analyzer group.",
                })
              : config.analysis.analyzers;
  console.log(
    terminalStyle.dim(
      "Azure source and contract resolvers use facts from the selected language groups.",
    ),
  );
  const exclusions = await input({
    theme: promptTheme,
    message:
      "Excluded directories or repository-relative globs (comma-separated; none clears)",
    default: config.analysis.exclusions.join(", "),
    validate: (value) => {
      try {
        applyWorkspaceOverrides(config, workspaceOverrides({ exclude: value }));
        return true;
      } catch {
        return "Use repository-relative names or glob patterns, not absolute paths or parent-directory paths.";
      }
    },
  });
  const semantic = await confirm({
    theme: promptTheme,
    message: "Enable semantic language analysis?",
    default: config.analysis.semantic ?? true,
  });
  const incremental = await confirm({
    theme: promptTheme,
    message:
      "Allow incremental updates with graph sync? (analyze always runs a full analysis)",
    default: config.analysis.incremental,
  });
  const snapshots = await confirm({
    theme: promptTheme,
    message:
      "Capture graph snapshots after analysis? (existing snapshots are preserved)",
    default: config.analysis.snapshots,
  });
  const openAfterAnalysis = await confirm({
    theme: promptTheme,
    message: "Open the local graph after interactive analysis?",
    default: config.ui.openAfterAnalysis,
  });
  const next = {
    ...config,
    analysis: {
      ...config.analysis,
      analyzers,
      exclusions: workspaceOverrides({ exclude: exclusions }).analysis
        .exclusions!,
      semantic,
      incremental,
      snapshots,
    },
    ui: { ...config.ui, openAfterAnalysis },
  };
  validateWorkspaceConfig(next);
  console.log(
    `\n${terminalStyle.bold("Review settings")}\n${workspaceSummary(next)}\n`,
  );
  return (await confirm({
    theme: promptTheme,
    message: reconfigure
      ? "Save configuration changes? Graph, cache, and snapshots will not be deleted."
      : "Create this repository-local workspace?",
    default: true,
  }))
    ? next
    : null;
}

export async function offerGraph(defaultOpen: boolean): Promise<boolean> {
  return confirm({
    theme: promptTheme,
    message: "Open the local graph now? (Ctrl+C stops its loopback server)",
    default: defaultOpen,
  });
}
