import { rm } from "node:fs/promises";
import path from "node:path";
import { initializeLibrary } from "../scripts/library-init";

export default async function globalSetup(): Promise<void> {
  const target = path.resolve(process.cwd(), "test-generated-library");
  await rm(target, { recursive: true, force: true });
  await initializeLibrary({
    target,
    projectKey: "generated-project",
    title: "Generated Research Project",
  });
}
