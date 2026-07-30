import type { LibraryFile } from "./library";
import { entryPath, isReaderDocument } from "./library-filter";
import {
  resultsNeedingAttention,
  type ProjectCatalogSnapshot,
  type ProjectReadingPathEntry,
} from "./project-overview";

export type ProjectLibraryMode = "browse" | "attention";

export type LibraryDocumentRole =
  | "overview"
  | "study-document"
  | "key-result-owner"
  | "synthesis"
  | "primary-synthesis"
  | "summary"
  | "graph"
  | "verification"
  | "reference-document"
  | "frontier-document"
  | "supporting-document"
  | "related"
  | "explicit-key";

export type LibraryAttentionReason =
  | "active"
  | "dirty"
  | "save-failed"
  | "comments"
  | "open-questions"
  | "active-task"
  | "validation-frontier";

export type LibraryDerivationCategory =
  | "setting"
  | "demand"
  | "supply"
  | "equilibrium"
  | "dynamics"
  | "welfare"
  | "empirics"
  | "policy"
  | "methods"
  | "other";

export type LibraryReferenceCategory =
  | "results"
  | "interfaces"
  | "provenance"
  | "audit"
  | "other";

export interface ProjectDocumentPlacement {
  area: string;
  section: string;
  purpose: string;
  order: number;
  areaOrder?: number;
  sectionOrder?: number;
  curated: boolean;
}

export interface ProjectLibraryDocument {
  file: LibraryFile;
  roles: LibraryDocumentRole[];
  attention: LibraryAttentionReason[];
  keyResultCount: number;
  derivationCategory: LibraryDerivationCategory | null;
  referenceCategory: LibraryReferenceCategory | null;
  repositoryOrder: number;
  focusPlacement: ProjectDocumentPlacement | null;
  browsePlacement: ProjectDocumentPlacement;
}

export interface ProjectLibrarySubsection {
  key: string;
  label: string;
  sequence: number | null;
  documents: ProjectLibraryDocument[];
}

export interface ProjectLibraryGroup {
  key: string;
  label: string;
  documents: ProjectLibraryDocument[];
  sections: ProjectLibrarySubsection[];
}

export interface ProjectLibraryProjection {
  documents: ProjectLibraryDocument[];
  focusGroups: ProjectLibraryGroup[];
  browseGroups: ProjectLibraryGroup[];
  attentionDocuments: ProjectLibraryDocument[];
  unlistedDocuments: ProjectLibraryDocument[];
  attentionCount: number;
  usedFallback: boolean;
  diagnostics: string[];
}

const ROLE_LABEL: Record<LibraryDocumentRole, string> = {
  overview: "Overview",
  "study-document": "Study",
  "key-result-owner": "Key result owner",
  synthesis: "Synthesis",
  "primary-synthesis": "Primary synthesis",
  summary: "Summary",
  graph: "Graph",
  verification: "Verification",
  "reference-document": "Reference",
  "frontier-document": "Frontier",
  "supporting-document": "Supporting",
  related: "Curated",
  "explicit-key": "Curated",
};

const ATTENTION_LABEL: Record<LibraryAttentionReason, string> = {
  active: "Open",
  dirty: "Changes pending",
  "save-failed": "Sync failed",
  comments: "Comments",
  "open-questions": "Open question",
  "active-task": "Active task",
  "validation-frontier": "Validation frontier",
};

const DERIVATION_CATEGORY_LABEL: Record<LibraryDerivationCategory, string> = {
  setting: "Setting & primitives",
  demand: "Demand",
  supply: "Supply",
  equilibrium: "Equilibrium",
  dynamics: "Dynamics & recursion",
  welfare: "Welfare",
  empirics: "Empirics & identification",
  policy: "Policy & counterfactuals",
  methods: "Proofs & methods",
  other: "Other derivations",
};

const DERIVATION_CATEGORY_ORDER: LibraryDerivationCategory[] = [
  "setting",
  "demand",
  "supply",
  "equilibrium",
  "dynamics",
  "welfare",
  "empirics",
  "policy",
  "methods",
  "other",
];

const REFERENCE_CATEGORY_LABEL: Record<LibraryReferenceCategory, string> = {
  results: "Result and graph status",
  interfaces: "Notation and theorem interfaces",
  provenance: "Provenance and source authority",
  audit: "Audit and evidence",
  other: "Other reference",
};

const REFERENCE_CATEGORY_ORDER: LibraryReferenceCategory[] = [
  "results",
  "interfaces",
  "provenance",
  "audit",
  "other",
];

const EXPLICIT_REFERENCE_TOKENS: Record<Exclude<LibraryReferenceCategory, "other">, string[]> = {
  results: ["reference-results"],
  interfaces: ["reference-notation", "reference-interface"],
  provenance: ["reference-provenance", "reference-source-map"],
  audit: ["reference-audit", "reference-evidence"],
};

const BROWSE_AREA_ORDER = {
  start: 0,
  synthesis: 1,
  study: 2,
  derivations: 3,
  reference: 4,
  questions: 5,
  supporting: 6,
} as const;

const EXPLICIT_CATEGORY_TOKENS: Record<LibraryDerivationCategory, string[]> = {
  setting: ["derivation-setting", "model-setting"],
  demand: ["derivation-demand", "model-demand"],
  supply: ["derivation-supply", "model-supply"],
  equilibrium: ["derivation-equilibrium", "model-equilibrium"],
  dynamics: ["derivation-dynamics", "model-dynamics"],
  welfare: ["derivation-welfare", "model-welfare"],
  empirics: ["derivation-empirics", "model-empirics"],
  policy: ["derivation-policy", "model-policy"],
  methods: ["derivation-methods", "model-methods"],
  other: ["derivation-other"],
};

const INFERRED_CATEGORY_TOKENS: Record<Exclude<LibraryDerivationCategory, "other">, string[]> = {
  setting: ["setting", "setup", "environment", "foundation", "foundations", "primitive", "primitives", "notation", "timing"],
  demand: ["demand", "preference", "preferences", "utility", "consumption", "choice"],
  supply: ["supply", "production", "technology", "firm", "firms", "capacity", "entry"],
  equilibrium: ["equilibrium", "clearing", "existence", "uniqueness", "fixed", "point"],
  dynamics: ["dynamic", "dynamics", "transition", "recursive", "recursion", "bellman", "state"],
  welfare: ["welfare", "planner", "incidence", "surplus"],
  empirics: ["empirical", "empirics", "estimation", "identification", "moment", "moments", "ppml", "calibration"],
  policy: ["policy", "counterfactual", "counterfactuals", "tax", "taxes", "toll", "tolls", "subsidy", "regulation"],
  methods: ["proof", "proofs", "theorem", "theorems", "lemma", "lemmas", "proposition", "propositions", "method", "methods"],
};

const ACTIONABLE_ATTENTION = new Set<LibraryAttentionReason>([
  "dirty",
  "save-failed",
  "comments",
  "open-questions",
  "active-task",
  "validation-frontier",
]);

const ATTENTION_ORDER: LibraryAttentionReason[] = [
  "save-failed",
  "dirty",
  "comments",
  "open-questions",
  "active-task",
  "validation-frontier",
  "active",
];

export function libraryDocumentRoleLabel(role: LibraryDocumentRole): string {
  return ROLE_LABEL[role];
}

export function libraryAttentionReasonLabel(reason: LibraryAttentionReason): string {
  return ATTENTION_LABEL[reason];
}

export function libraryDerivationCategoryLabel(category: LibraryDerivationCategory): string {
  return DERIVATION_CATEGORY_LABEL[category];
}

/**
 * Build three project views from one stable document projection. Attention is
 * deliberately an orthogonal attribute: changing a comment, task, or save
 * state never moves a document in the Browse hierarchy.
 */
export function projectLibraryProjection(
  files: LibraryFile[],
  project: string,
  snapshot: ProjectCatalogSnapshot | null,
  activePath: string | null,
  isDirty: (documentId: string) => boolean = () => false,
  hasSaveFailure: (path: string) => boolean = () => false,
): ProjectLibraryProjection {
  const overview = snapshot?.overviewByProject.get(project);
  const relatedIds = new Set(overview?.keyDocumentIds ?? []);
  const keyResultOwnerCounts = new Map<string, number>();
  for (const item of overview?.keyResults ?? []) {
    const ownerId = item.result?.ownerId;
    if (ownerId) keyResultOwnerCounts.set(ownerId, (keyResultOwnerCounts.get(ownerId) ?? 0) + 1);
  }
  const activeTaskOwners = new Set(
    (snapshot?.tasksByProject.get(project) ?? [])
      .filter((task) => task.state === "blocked" || task.state === "in-progress" || task.state === "next")
      .map((task) => task.ownerId),
  );
  const frontierOwners = new Set(
    snapshot
      ? resultsNeedingAttention(snapshot, project).slice(0, 6).map((item) => item.result.ownerId)
      : [],
  );
  const readingEntries = (overview?.readingPath ?? [])
    .filter((entry): entry is ProjectReadingPathEntry & { document: NonNullable<ProjectReadingPathEntry["document"]> } =>
      !!entry.document
    );
  const readingById = new Map(readingEntries.map((entry) => [entry.documentId, entry]));
  const usedFallback = readingEntries.length === 0;
  const diagnostics: string[] = [];
  const documents: ProjectLibraryDocument[] = [];

  for (const [repositoryOrder, file] of files.entries()) {
    if (!isReaderDocument(file)) continue;
    const id = file.meta.id ?? "";
    const path = entryPath(file);
    const contains = new Set(file.meta.contains);
    const tags = new Set(file.meta.tags.map(normalizeToken));
    const kind = normalizeToken(file.meta.kind ?? "");
    const roles: LibraryDocumentRole[] = [];
    const attention: LibraryAttentionReason[] = [];
    const explicitKey = contains.has("key-document");
    const explicitSupporting = contains.has("supporting-document");
    const explicitFrontier = contains.has("frontier-document");
    const explicitReference = kind === "reference"
      || contains.has("reference-document")
      || explicitReferenceCategories(file).length > 0;
    const primarySynthesis = contains.has("primary-synthesis");
    const explicitKeyDerivation = contains.has("key-derivation");
    const explicitAdditionalDerivation = contains.has("additional-derivation");
    const keyResultCount = keyResultOwnerCounts.get(id) ?? 0;

    if (explicitKey && explicitSupporting) {
      diagnostics.push(`${path} declares both key-document and supporting-document; curated visibility wins.`);
    }
    if (explicitKeyDerivation && explicitAdditionalDerivation) {
      diagnostics.push(`${path} declares both key-derivation and additional-derivation; key derivation wins.`);
    }
    if (explicitKey || explicitKeyDerivation) roles.push("explicit-key");
    if (contains.has("project-overview")) roles.push("overview");
    if (
      contains.has("workbook")
      || contains.has("study-document")
      || kind === "workbook"
    ) roles.push("study-document");
    if (keyResultCount) roles.push("key-result-owner");
    if (
      primarySynthesis
      ||
      contains.has("synthesis")
      || tags.has("synthesis")
      || file.folder.split("/").some((segment) => normalizeToken(segment) === "synthesis")
    ) roles.push("synthesis");
    if (primarySynthesis) roles.push("primary-synthesis");
    if (explicitSupporting) roles.push("supporting-document");
    if (explicitFrontier) roles.push("frontier-document");
    if (explicitReference) roles.push("reference-document");
    if (contains.has("project-summary") || contains.has("summary")) roles.push("summary");
    if (contains.has("dependency-graph")) roles.push("graph");

    const derivationLike = isDerivationDocument(file, roles)
      || explicitKeyDerivation
      || explicitAdditionalDerivation;
    if (
      (contains.has("verification") || contains.has("results"))
      && !derivationLike
    ) roles.push("verification");
    if (relatedIds.has(id)) roles.push("related");

    if (activePath === path) attention.push("active");
    if (id && isDirty(id)) attention.push("dirty");
    if (hasSaveFailure(path)) attention.push("save-failed");
    if (file.openCommentCount > 0) attention.push("comments");
    if (contains.has("open-questions")) attention.push("open-questions");
    if (activeTaskOwners.has(id)) attention.push("active-task");
    if (frontierOwners.has(id)) attention.push("validation-frontier");

    const categoryMatches = explicitDerivationCategories(file);
    if (categoryMatches.length > 1) {
      diagnostics.push(
        `${path} declares multiple derivation categories (${categoryMatches.map(libraryDerivationCategoryLabel).join(", ")}); ${libraryDerivationCategoryLabel(categoryMatches[0])} is used.`,
      );
    }
    const derivationCategory = derivationLike || keyResultCount > 0
      ? categoryMatches[0] ?? inferDerivationCategory(file)
      : null;
    const referenceMatches = explicitReferenceCategories(file);
    if (referenceMatches.length > 1) {
      diagnostics.push(
        `${path} declares multiple reference categories (${referenceMatches.map(referenceCategoryLabel).join(", ")}); ${referenceCategoryLabel(referenceMatches[0])} is used.`,
      );
    }
    const referenceCategory = explicitReference
      ? referenceMatches[0] ?? "other"
      : roles.some((role) => role === "graph" || role === "verification")
        ? referenceMatches[0] ?? "results"
        : null;
    const uniqueRoles = unique(roles);
    const reading = readingById.get(id);
    const focusPlacement = uniqueRoles.includes("overview")
      ? placement("Start here", "", overview?.summary ?? "", -1, true)
      : reading
        ? placement(reading.area, reading.section, reading.purpose, reading.order, true)
        : usedFallback
          ? inferredFocusPlacement(
              uniqueRoles,
              derivationCategory,
              derivationLike,
              explicitSupporting || explicitAdditionalDerivation,
              repositoryOrder,
            )
          : null;

    documents.push({
      file,
      roles: uniqueRoles,
      attention: unique(attention),
      keyResultCount,
      derivationCategory,
      referenceCategory,
      repositoryOrder,
      focusPlacement,
      browsePlacement: browsePlacement(
        uniqueRoles,
        derivationCategory,
        referenceCategory,
        derivationLike,
        contains.has("open-questions"),
        repositoryOrder,
        !!reading,
        reading?.area,
        reading?.section,
      ),
    });
  }

  const focusDocuments = documents.filter((document) => !!document.focusPlacement);
  const curatedIds = new Set(focusDocuments.map((document) => document.file.meta.id).filter(Boolean));
  const unlistedDocuments = documents.filter((document) => !curatedIds.has(document.file.meta.id));
  const attentionDocuments = documents
    .filter((document) => document.attention.some((reason) => ACTIONABLE_ATTENTION.has(reason)))
    .sort((a, b) => attentionRank(a) - attentionRank(b) || a.repositoryOrder - b.repositoryOrder);

  return {
    documents,
    focusGroups: groupDocuments(focusDocuments, (document) => document.focusPlacement!),
    browseGroups: groupDocuments(documents, (document) => document.browsePlacement),
    attentionDocuments,
    unlistedDocuments,
    attentionCount: attentionDocuments.length,
    usedFallback,
    diagnostics,
  };
}

function placement(
  area: string,
  section: string,
  purpose: string,
  order: number,
  curated: boolean,
  areaOrder?: number,
  sectionOrder?: number,
): ProjectDocumentPlacement {
  return { area, section, purpose, order, areaOrder, sectionOrder, curated };
}

function inferredFocusPlacement(
  roles: LibraryDocumentRole[],
  category: LibraryDerivationCategory | null,
  derivationLike: boolean,
  explicitlySupporting: boolean,
  order: number,
): ProjectDocumentPlacement | null {
  if (explicitlySupporting && !roles.includes("key-result-owner")) return null;
  if (roles.includes("synthesis") || roles.includes("summary")) {
    return placement("Start here", "", "", order, true);
  }
  if (derivationLike && (
    roles.includes("key-result-owner")
    || roles.includes("related")
    || roles.includes("explicit-key")
  )) {
    return placement("Core model", category ? libraryDerivationCategoryLabel(category) : "", "", order, true);
  }
  if (roles.some((role) =>
    role === "graph"
    || role === "verification"
    || role === "related"
    || role === "explicit-key"
  )) {
    return placement("Reference & validation", "", "", order, true);
  }
  return null;
}

function browsePlacement(
  roles: LibraryDocumentRole[],
  category: LibraryDerivationCategory | null,
  referenceCategory: LibraryReferenceCategory | null,
  derivationLike: boolean,
  openQuestions: boolean,
  order: number,
  curated: boolean,
  readingArea?: string,
  readingSection?: string,
): ProjectDocumentPlacement {
  const readingAreaKey = normalizeToken(readingArea ?? "");
  if (roles.includes("overview")) {
    return placement(
      "Start here",
      "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.start,
    );
  }
  if (roles.includes("primary-synthesis")) {
    return placement(
      "Synthesis",
      "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.synthesis,
    );
  }
  if (roles.includes("supporting-document")) {
    return placement(
      "Supporting documents",
      "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.supporting,
    );
  }
  if (
    roles.some((role) => role === "synthesis" || role === "summary")
    || readingAreaKey === "synthesis"
  ) {
    return placement(
      "Synthesis",
      "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.synthesis,
    );
  }
  if (
    roles.includes("study-document")
    || readingAreaKey === "study"
  ) {
    return placement(
      "Study",
      readingSection ?? "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.study,
    );
  }
  if (
    roles.includes("frontier-document")
    || openQuestions
    || readingAreaKey === "open-questions"
  ) {
    return placement(
      "Open questions",
      "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.questions,
    );
  }
  if (
    derivationLike
    || roles.includes("key-result-owner")
    || readingAreaKey === "core-model"
    || readingAreaKey === "model-derivations"
  ) {
    const derivationCategory = category ?? "other";
    return placement(
      "Model derivations",
      libraryDerivationCategoryLabel(derivationCategory),
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.derivations,
      DERIVATION_CATEGORY_ORDER.indexOf(derivationCategory),
    );
  }
  if (
    roles.some((role) =>
      role === "reference-document"
      || role === "graph"
      || role === "verification"
    )
    || readingAreaKey === "reference-validation"
  ) {
    const selectedReference = referenceCategory ?? "other";
    return placement(
      "Reference & validation",
      referenceCategoryLabel(selectedReference),
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.reference,
      REFERENCE_CATEGORY_ORDER.indexOf(selectedReference),
    );
  }
  if (readingAreaKey === "start-here") {
    return placement(
      "Start here",
      "",
      "",
      order,
      curated,
      BROWSE_AREA_ORDER.start,
    );
  }
  return placement(
    "Supporting documents",
    "",
    "",
    order,
    curated,
    BROWSE_AREA_ORDER.supporting,
  );
}

function groupDocuments(
  documents: ProjectLibraryDocument[],
  getPlacement: (document: ProjectLibraryDocument) => ProjectDocumentPlacement,
): ProjectLibraryGroup[] {
  const groups = new Map<string, {
    label: string;
    order: number;
    documents: ProjectLibraryDocument[];
    sections: Map<string, { label: string; order: number; documents: ProjectLibraryDocument[] }>;
  }>();
  for (const document of documents) {
    const item = getPlacement(document);
    const areaKey = normalizeToken(item.area) || "documents";
    const group = groups.get(areaKey) ?? {
      label: item.area || "Documents",
      order: item.areaOrder ?? item.order,
      documents: [] as ProjectLibraryDocument[],
      sections: new Map(),
    };
    group.order = Math.min(group.order, item.areaOrder ?? item.order);
    if (item.section) {
      const sectionKey = normalizeToken(item.section) || "documents";
      const section = group.sections.get(sectionKey) ?? {
        label: item.section,
        order: item.sectionOrder ?? item.order,
        documents: [] as ProjectLibraryDocument[],
      };
      section.order = Math.min(section.order, item.sectionOrder ?? item.order);
      section.documents.push(document);
      group.sections.set(sectionKey, section);
    } else {
      group.documents.push(document);
    }
    groups.set(areaKey, group);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([key, group]) => ({
      key,
      label: group.label,
      documents: group.documents.sort((a, b) =>
        getPlacement(a).order - getPlacement(b).order || a.repositoryOrder - b.repositoryOrder
      ),
      sections: [...group.sections.entries()]
        .sort(([, a], [, b]) => a.order - b.order)
        .map(([sectionKey, section]) => ({
          key: sectionKey,
          label: section.label,
          sequence: key === "model-derivations"
            ? derivationSectionSequence(sectionKey)
            : null,
          documents: section.documents.sort((a, b) =>
            getPlacement(a).order - getPlacement(b).order || a.repositoryOrder - b.repositoryOrder
          ),
        })),
    }));
}

function attentionRank(document: ProjectLibraryDocument): number {
  for (let index = 0; index < ATTENTION_ORDER.length; index++) {
    if (document.attention.includes(ATTENTION_ORDER[index])) return index;
  }
  return ATTENTION_ORDER.length;
}

function isDerivationDocument(file: LibraryFile, roles: LibraryDocumentRole[]): boolean {
  if (roles.some((role) =>
    role === "overview"
    || role === "synthesis"
    || role === "graph"
    || role === "verification"
    || role === "reference-document"
  )) {
    return false;
  }
  const kind = file.meta.kind?.trim().toLocaleLowerCase();
  if (kind === "derivation" || kind === "proof") return true;
  const contains = new Set(file.meta.contains.map(normalizeToken));
  return ["derivation", "derivations", "proof", "proofs", "theorem", "theorems", "proposition", "propositions"]
    .some((token) => contains.has(token));
}

function explicitDerivationCategories(file: LibraryFile): LibraryDerivationCategory[] {
  const tokens = new Set([...file.meta.contains, ...file.meta.tags].map(normalizeToken));
  return DERIVATION_CATEGORY_ORDER.filter((category) =>
    EXPLICIT_CATEGORY_TOKENS[category].some((token) => tokens.has(token))
  );
}

function explicitReferenceCategories(file: LibraryFile): LibraryReferenceCategory[] {
  const tokens = new Set([...file.meta.contains, ...file.meta.tags].map(normalizeToken));
  return REFERENCE_CATEGORY_ORDER.filter((category) =>
    category !== "other"
    && EXPLICIT_REFERENCE_TOKENS[category].some((token) => tokens.has(token))
  );
}

function referenceCategoryLabel(category: LibraryReferenceCategory): string {
  return REFERENCE_CATEGORY_LABEL[category];
}

function inferDerivationCategory(file: LibraryFile): LibraryDerivationCategory {
  const words = new Set(
    [file.meta.title ?? "", file.folder, ...file.meta.tags, ...file.meta.contains]
      .flatMap((value) => normalizeToken(value).split("-"))
      .filter(Boolean),
  );
  for (const category of DERIVATION_CATEGORY_ORDER) {
    if (category === "other") continue;
    if (INFERRED_CATEGORY_TOKENS[category].some((token) => words.has(token))) return category;
  }
  return "other";
}

function derivationSectionSequence(sectionKey: string): number | null {
  const index = DERIVATION_CATEGORY_ORDER.findIndex((category) =>
    normalizeToken(DERIVATION_CATEGORY_LABEL[category]) === sectionKey
  );
  return index >= 0 ? index + 1 : null;
}

function normalizeToken(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
