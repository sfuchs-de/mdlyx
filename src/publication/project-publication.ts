import {
  defaultPublication,
  type Frontmatter,
  type PublicationOverrides,
  type PublicationSettings,
} from "../markdown/frontmatter";

export interface ProjectPublicationConfig {
  project: string;
  overviewDocumentId: string;
  overviewPath: string;
  settings: PublicationSettings;
}

export interface PublicationDiagnostic {
  severity: "error" | "warning";
  code: "project-style-conflict" | "project-setting-conflict";
  message: string;
  projects: string[];
  field: keyof PublicationSettings;
}

export interface EffectivePublicationSettings extends PublicationSettings {
  projects: string[];
  bibliographySources: Array<{ project: string; path: string }>;
  diagnostics: PublicationDiagnostic[];
  inheritedFields: Array<keyof PublicationSettings>;
  overriddenFields: Array<keyof PublicationSettings>;
}

const FIELDS: Array<keyof PublicationSettings> = [
  "bibliography",
  "documentClass",
  "citationStyle",
  "language",
  "engine",
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function valuesEqual(
  field: keyof PublicationSettings,
  left: PublicationSettings[keyof PublicationSettings],
  right: PublicationSettings[keyof PublicationSettings],
): boolean {
  if (field !== "bibliography") return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolve project defaults first and authored document fields second.
 *
 * Bibliographies are the only compositional setting: a multi-project document
 * sees the stable union of every visible project bibliography. Other fields
 * must agree unless the document explicitly chooses a value. An authored empty
 * bibliography is retained and therefore disables inheritance.
 */
export function resolveEffectivePublication(
  frontmatter: Pick<Frontmatter, "library" | "publication" | "publicationOverrides">,
  projectConfigs: readonly ProjectPublicationConfig[],
): EffectivePublicationSettings {
  const projects = unique(frontmatter.library.projects);
  const configs = projects.flatMap((project) => {
    const config = projectConfigs.find((candidate) => candidate.project === project);
    return config ? [config] : [];
  });
  const result: PublicationSettings = defaultPublication();
  const diagnostics: PublicationDiagnostic[] = [];
  const inheritedFields: Array<keyof PublicationSettings> = [];
  const overriddenFields: Array<keyof PublicationSettings> = [];
  const bibliographySources: Array<{ project: string; path: string }> = [];

  if (configs.length) {
    const paths: string[] = [];
    for (const config of configs) {
      for (const path of config.settings.bibliography) {
        bibliographySources.push({ project: config.project, path });
        if (!paths.includes(path)) paths.push(path);
      }
    }
    result.bibliography = paths;
    inheritedFields.push("bibliography");

    for (const field of ["documentClass", "citationStyle", "language", "engine"] as const) {
      const first = configs[0].settings[field];
      const conflicts = configs.filter((config) => !valuesEqual(field, first, config.settings[field]));
      if (conflicts.length) {
        diagnostics.push({
          severity: "error",
          code: field === "citationStyle" ? "project-style-conflict" : "project-setting-conflict",
          projects: configs.map((config) => config.project),
          field,
          message: `Projects ${configs.map((config) => config.project).join(", ")} declare conflicting ${field} settings; add an explicit document override.`,
        });
      } else {
        if (field === "documentClass") result.documentClass = first;
        else if (field === "citationStyle") {
          result.citationStyle = first as PublicationSettings["citationStyle"];
        }
        else if (field === "language") result.language = first;
        else result.engine = first as PublicationSettings["engine"];
        inheritedFields.push(field);
      }
    }
  }

  const overrides: PublicationOverrides = frontmatter.publicationOverrides;
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, field)) continue;
    const value = overrides[field];
    if (value === undefined) continue;
    if (field === "bibliography") {
      result.bibliography = [...value as string[]];
      bibliographySources.splice(0, bibliographySources.length);
    } else if (field === "citationStyle") {
      result.citationStyle = value as PublicationSettings["citationStyle"];
    } else if (field === "documentClass") {
      result.documentClass = value as string;
    } else if (field === "language") {
      result.language = value as string;
    } else {
      result.engine = value as PublicationSettings["engine"];
    }
    overriddenFields.push(field);
  }

  return {
    ...result,
    projects,
    bibliographySources,
    diagnostics: diagnostics.filter((item) => !overriddenFields.includes(item.field)),
    inheritedFields: inheritedFields.filter((field) => !overriddenFields.includes(field)),
    overriddenFields,
  };
}
