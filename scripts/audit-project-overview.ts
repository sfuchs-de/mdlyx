import { auditProjectOverviews } from "./project-overview-audit";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = "Usage: npm run audit:overview -- /path/to/library [--project PROJECT] " +
  "[--review-config PATH] [--json-out PATH] [--markdown-out PATH] [--strict]";

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(USAGE);
  return value;
}

function validateArguments(argv: string[]): void {
  const booleanFlags = new Set(["--strict"]);
  const valueFlags = new Set(["--project", "--review-config", "--json-out", "--markdown-out"]);
  for (let index = 3; index < argv.length; index++) {
    const argument = argv[index];
    if (booleanFlags.has(argument)) continue;
    if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(USAGE);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${JSON.stringify(argument)}. ${USAGE}`);
  }
}

export function renderAuditMarkdown(
  report: Awaited<ReturnType<typeof auditProjectOverviews>>,
): string {
  const cell = (value: unknown) => String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const prose = (value: unknown) => String(value).replace(/\r?\n/g, " ");
  const lines = [
    "# MdLyx project-workspace audit",
    "",
    `- Status: **${report.summary.strictPassed ? "passed" : "failed"}**`,
    `- Baseline: \`${path.basename(report.review.path)}\` (reviewed ${report.review.reviewedAt})`,
    `- Diagnostics: ${report.summary.errors} errors, ${report.summary.warnings} warnings (${report.summary.acceptedWarnings} accepted)`,
    `- Count mismatches: ${report.summary.countMismatches}`,
    "",
    "## Projects",
    "",
    "| Project | Documents | Results (V/P/U/D) | Tasks (N/I/B/L/D) | Graph diagnostics |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [project, item] of Object.entries(report.projects)) {
    const results = item.counts.results;
    const tasks = item.counts.tasks;
    lines.push(
      `| \`${cell(project)}\` | ${item.counts.documents} | `
      + `${results.validated}/${results.partial}/${results.unvalidated}/${results.disputed} | `
      + `${tasks.next}/${tasks["in-progress"]}/${tasks.blocked}/${tasks.later}/${tasks.done} | `
      + `${item.counts.graphErrors} errors, ${item.counts.graphWarnings} warnings |`,
    );
  }
  const diagnostics = [
    ...report.libraryDiagnostics,
    ...Object.values(report.projects).flatMap((item) => item.diagnostics),
  ];
  lines.push("", "## Diagnostics", "");
  if (!diagnostics.length) lines.push("No diagnostics.");
  for (const diagnostic of diagnostics) {
    const location = diagnostic.path ?? diagnostic.project ?? "library";
    const accepted = diagnostic.acceptance ? " (accepted)" : "";
    lines.push(
      `- **${diagnostic.severity.toUpperCase()} \`${diagnostic.code}\`**${accepted} — `
      + `${prose(diagnostic.message)} (\`${prose(location)}\`)`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Run the CLI and return the process status so strict-mode behavior is unit-testable. */
export async function runAuditCli(argv = process.argv): Promise<number> {
  const root = argv[2];
  if (!root || root.startsWith("--")) {
    console.error(USAGE);
    return 2;
  }
  try {
    validateArguments(argv);
    const strict = argv.includes("--strict");
    const report = await auditProjectOverviews(root, {
      project: valueAfter(argv, "--project"),
      reviewConfigPath: valueAfter(argv, "--review-config"),
    });
    const renderedJson = `${JSON.stringify(report, null, 2)}\n`;
    const renderedMarkdown = renderAuditMarkdown(report);
    const jsonOut = valueAfter(argv, "--json-out");
    const markdownOut = valueAfter(argv, "--markdown-out");
    if (jsonOut) {
      const target = path.resolve(jsonOut);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, renderedJson, "utf8");
    }
    if (markdownOut) {
      const target = path.resolve(markdownOut);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, renderedMarkdown, "utf8");
    }
    console.log(renderedJson.trimEnd());
    return strict && !report.summary.strictPassed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exitCode = await runAuditCli();
