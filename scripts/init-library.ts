import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  initializeLibrary,
  LIBRARY_AUTHORITIES,
  type LibraryAuthority,
} from "./library-init";

const USAGE = `Usage:
  npm run library:init -- --target PATH --project-key KEY --title "TITLE"
    [--authority ${LIBRARY_AUTHORITIES.join("|")}] [--git]`;

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(USAGE);
  return value;
}

function validateArguments(argv: string[]): void {
  const valueFlags = new Set(["--target", "--project-key", "--title", "--authority"]);
  const booleanFlags = new Set(["--git", "--help"]);
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (booleanFlags.has(argument)) continue;
    if (!valueFlags.has(argument)) throw new Error(`Unknown argument ${JSON.stringify(argument)}.\n${USAGE}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(USAGE);
    index++;
  }
}

export async function runLibraryInitCli(argv = process.argv): Promise<number> {
  try {
    validateArguments(argv);
    if (argv.includes("--help")) {
      console.log(USAGE);
      return 0;
    }
    const target = valueAfter(argv, "--target");
    const projectKey = valueAfter(argv, "--project-key");
    const title = valueAfter(argv, "--title");
    if (!target || !projectKey || !title) throw new Error(USAGE);
    const authorityValue = valueAfter(argv, "--authority") ?? "mdlyx";
    if (!LIBRARY_AUTHORITIES.includes(authorityValue as LibraryAuthority)) {
      throw new Error(`Unknown authority ${JSON.stringify(authorityValue)}.\n${USAGE}`);
    }
    const result = await initializeLibrary({
      target,
      projectKey,
      title,
      authority: authorityValue as LibraryAuthority,
      git: argv.includes("--git"),
    });
    console.log(`Created MdLyx library at ${result.root}`);
    console.log(`- Project: ${result.projectKey}`);
    console.log(`- Authority: ${result.authority}`);
    console.log(`- Files: ${result.files.length}`);
    console.log(`- Git: ${result.gitInitialized ? "initialized locally (no remote)" : "not initialized"}`);
    console.log("");
    console.log(`Validate it with: npm run library:validate -- --root ${JSON.stringify(result.root)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exitCode = await runLibraryInitCli();
