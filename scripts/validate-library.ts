import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateLibrary,
  type LibraryValidationReport,
} from "./library-validator";

const USAGE = "Usage: npm run library:validate -- --root PATH [--json REPORT.json]";

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(USAGE);
  return value;
}

function validateArguments(argv: string[]): void {
  const valueFlags = new Set(["--root", "--json"]);
  const booleanFlags = new Set(["--help"]);
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (booleanFlags.has(argument)) continue;
    if (!valueFlags.has(argument)) throw new Error(`Unknown argument ${JSON.stringify(argument)}.\n${USAGE}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(USAGE);
    index++;
  }
}

export function renderLibraryValidation(report: LibraryValidationReport): string {
  const status = report.valid ? "passed" : "failed";
  const projects = `${report.summary.projects} project${report.summary.projects === 1 ? "" : "s"}`;
  const lines = [
    `MdLyx library validation ${status}.`,
    `- ${report.summary.documents} documents in ${projects}`,
    `- ${report.summary.results} results and ${report.summary.citations} citation uses`,
    `- ${report.summary.bibliographies} bibliographies`,
    `- ${report.summary.errors} errors and ${report.summary.warnings} warnings`,
  ];
  if (report.diagnostics.length) {
    lines.push("", "Diagnostics:");
    for (const item of report.diagnostics) {
      const location = item.path ?? item.project ?? "library";
      lines.push(`- ${item.severity.toUpperCase()} ${item.code} (${location}): ${item.message}`);
    }
  }
  return lines.join("\n");
}

export async function runLibraryValidateCli(argv = process.argv): Promise<number> {
  try {
    validateArguments(argv);
    if (argv.includes("--help")) {
      console.log(USAGE);
      return 0;
    }
    const root = valueAfter(argv, "--root");
    if (!root) throw new Error(USAGE);
    const report = await validateLibrary(root);
    const json = valueAfter(argv, "--json");
    if (json) {
      const target = path.resolve(json);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(renderLibraryValidation(report));
    return report.valid ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exitCode = await runLibraryValidateCli();
