import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_GUIDES = [
  "docs/AI_WORKFLOWS.md",
  "docs/CREATE_LIBRARY.md",
  "docs/GETTING_STARTED.md",
  "docs/GITHUB_SYNC.md",
  "docs/HOSTING.md",
  "docs/TROUBLESHOOTING.md",
];
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];

async function documentationFiles(): Promise<string[]> {
  const docs = (await readdir(path.join(ROOT, "docs"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `docs/${entry.name}`);
  return [...ROOT_DOCS, ...docs].sort((left, right) => left.localeCompare(right));
}

function localLinks(source: string): string[] {
  const links: string[] = [];
  for (const match of source.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.replace(/\s+["'][^"']*["']$/, "");
    if (
      !target
      || target.startsWith("#")
      || /^(?:https?:|mailto:|tel:)/i.test(target)
    ) continue;
    links.push(target.split("#", 1)[0]);
  }
  return links;
}

export async function checkDocumentation(): Promise<string[]> {
  const findings: string[] = [];
  const files = await documentationFiles();
  for (const required of REQUIRED_GUIDES) {
    try {
      await access(path.join(ROOT, required));
    } catch {
      findings.push(`Missing required guide: ${required}`);
    }
  }
  for (const relative of files) {
    const source = await readFile(path.join(ROOT, relative), "utf8");
    for (const target of localLinks(source)) {
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        findings.push(`${relative}: malformed link encoding ${JSON.stringify(target)}`);
        continue;
      }
      const absolute = path.resolve(path.dirname(path.join(ROOT, relative)), decoded);
      if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${path.sep}`)) {
        findings.push(`${relative}: local link escapes the repository: ${target}`);
        continue;
      }
      try {
        await access(absolute);
      } catch {
        findings.push(`${relative}: missing local link target ${target}`);
      }
    }
  }

  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const script of ["library:init", "library:validate", "docs:check"]) {
    if (!packageJson.scripts?.[script]) findings.push(`package.json: missing ${script} script`);
  }
  return findings;
}

export async function runDocsCheck(): Promise<number> {
  const findings = await checkDocumentation();
  if (findings.length) {
    console.error("Documentation check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    return 1;
  }
  console.log("Documentation check passed: required guides and local links are valid.");
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) process.exitCode = await runDocsCheck();
