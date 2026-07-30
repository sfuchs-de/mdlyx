import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LIBRARY_AUTHORITIES = ["mdlyx", "external", "split"] as const;
export type LibraryAuthority = (typeof LIBRARY_AUTHORITIES)[number];

export interface LibraryInitOptions {
  target: string;
  projectKey: string;
  title: string;
  authority?: LibraryAuthority;
  git?: boolean;
}

export interface LibraryInitResult {
  root: string;
  projectKey: string;
  authority: LibraryAuthority;
  files: string[];
  gitInitialized: boolean;
}

const TEMPLATE_ROOT = fileURLToPath(
  new URL("../templates/research-library/", import.meta.url),
);

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function validateOptions(options: LibraryInitOptions): {
  target: string;
  projectKey: string;
  title: string;
  authority: LibraryAuthority;
} {
  const target = path.resolve(expandHome(options.target.trim()));
  const projectKey = options.projectKey.trim();
  const title = options.title.trim();
  const authority = options.authority ?? "mdlyx";

  if (!target || target === path.parse(target).root) {
    throw new Error("The target must be a dedicated library directory, not a filesystem root.");
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(projectKey) || projectKey.length > 64) {
    throw new Error(
      "Project keys must be 1–64 lowercase letters, numbers, and single hyphens, beginning with a letter.",
    );
  }
  if (title.length < 2 || title.length > 120 || /[\r\n\0]/.test(title)) {
    throw new Error("The project title must be a single line between 2 and 120 characters.");
  }
  if (!LIBRARY_AUTHORITIES.includes(authority)) {
    throw new Error(`Authority must be one of: ${LIBRARY_AUTHORITIES.join(", ")}.`);
  }
  return { target, projectKey, title, authority };
}

async function assertEmptyTarget(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("The target directory must not be a symbolic link.");
    if (!stat.isDirectory()) throw new Error("The target exists and is not a directory.");
    const entries = await readdir(target);
    if (entries.length) throw new Error("The target directory must be empty.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function templateFiles(
  root = TEMPLATE_ROOT,
  prefix = "",
): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; source: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error("The starter template must not contain symbolic links.");
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await templateFiles(absolute, relative));
    } else if (entry.isFile()) {
      files.push({ path: relative, source: await readFile(absolute, "utf8") });
    }
  }
  return files;
}

function substitute(
  value: string,
  variables: Readonly<Record<string, string>>,
): string {
  return Object.entries(variables).reduce(
    (result, [token, replacement]) => result.replaceAll(`__${token}__`, replacement),
    value,
  );
}

async function writeStarter(
  root: string,
  variables: Readonly<Record<string, string>>,
): Promise<string[]> {
  const sources = await templateFiles();
  const written: string[] = [];
  for (const source of sources) {
    const relative = substitute(source.path, variables);
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, substitute(source.source, variables), "utf8");
    written.push(relative);
  }
  return written.sort((left, right) => left.localeCompare(right));
}

/**
 * Create a standalone, privacy-safe library. No network request, remote,
 * commit, credential, or personal identifier is created by this operation.
 */
export async function initializeLibrary(
  options: LibraryInitOptions,
): Promise<LibraryInitResult> {
  const checked = validateOptions(options);
  const targetExists = await assertEmptyTarget(checked.target);
  await access(TEMPLATE_ROOT);

  const variables = {
    PROJECT_KEY: checked.projectKey,
    PROJECT_TITLE: checked.title,
    PROJECT_TITLE_JSON: JSON.stringify(checked.title).slice(1, -1),
    AUTHORITY: checked.authority,
  };
  const temporary = targetExists
    ? checked.target
    : `${checked.target}.mdlyx-init-${randomBytes(6).toString("hex")}`;
  let createdTemporary = !targetExists;
  try {
    if (createdTemporary) {
      await mkdir(path.dirname(temporary), { recursive: true });
      await mkdir(temporary, { recursive: false });
    }
    const files = await writeStarter(temporary, variables);
    if (createdTemporary) {
      await mkdir(path.dirname(checked.target), { recursive: true });
      await rename(temporary, checked.target);
      createdTemporary = false;
    }
    if (options.git) {
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", checked.target]);
    }
    return {
      root: checked.target,
      projectKey: checked.projectKey,
      authority: checked.authority,
      files,
      gitInitialized: options.git === true,
    };
  } catch (error) {
    if (createdTemporary) await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
