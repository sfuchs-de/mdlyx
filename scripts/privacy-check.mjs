import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((path) => path !== "scripts/privacy-check.mjs")
  .filter((path) => !/\.(?:png|ico|icns|jpg|jpeg|gif|pdf)$/.test(path))
  .filter((path) => !["package-lock.json", "src-tauri/Cargo.lock"].includes(path));

const forbidden = [
  { label: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "absolute user home path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "Windows user home path", pattern: /[A-Z]:\\Users\\[^\\]+\\/i },
  { label: "private development repository", pattern: /\b(?:mathdown-lite|mathdown-library|Task_Manager)\b/i },
  { label: "private deployment host", pattern: /mathdown-library-api\.onrender\.com/i },
  {
    label: "private research project",
    pattern: /\b(?:continuum-model|uboat|u-boat|container-ports|maritime-vulnerability|spatial-substitution|spoils-of-war|trade-transport-bottlenecks|transport-network-welfare|value-of-reliability)\b/i,
  },
];

const findings = [];
for (const path of files) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) findings.push(`${path}: ${rule.label}`);
  }
}

if (findings.length) {
  console.error("Privacy check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Privacy check passed (${files.length} repository text files inspected).`);
