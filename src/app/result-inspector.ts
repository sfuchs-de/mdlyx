import { renderKatex } from "../editor/math/render-katex";
import { DEPENDENCY_STATUS } from "./dependency-graph-canvas";
import {
  resultInternalLink,
  type DependencyCatalog,
  type ResultNode,
} from "./dependency-graph";
import { createLeanCertificateBadge } from "./lean-certificate-ui";

export interface ResultInspectorHandlers {
  openStatement(result: ResultNode): void;
  openDerivation(result: ResultNode): void;
  openRelated?(result: ResultNode): void;
  copyText?(value: string): Promise<void>;
}

/**
 * One read-only result surface shared by Overview and Graph. Every field is a
 * projection of governed Library data; the inspector never becomes a second
 * mathematical authority.
 */
export function createResultInspector(
  result: ResultNode,
  catalog: DependencyCatalog,
  handlers: ResultInspectorHandlers,
): HTMLElement {
  const inspector = element("article", `result-inspector state-${result.validation}`);
  inspector.setAttribute("aria-label", `Result ${result.id}`);

  const header = element("header", "result-inspector-header");
  const heading = element("div", "result-inspector-heading");
  heading.append(
    element("code", "result-inspector-id", result.id),
    element("h2", "result-inspector-title", result.title),
  );
  const states = element("div", "result-inspector-states");
  states.append(statePill(
    `Registry · ${DEPENDENCY_STATUS[result.validation].label}`,
    `validation-${result.validation}`,
  ));
  states.append(statePill(
    `Curated · ${result.curatedStatus ?? "not recorded"}`,
    `curated-${result.curatedStatus ?? "unknown"}`,
  ));
  states.append(statePill(
    `Derivation audit · ${result.derivationAudit ?? "not recorded"}`,
    `derivation-${normaliseState(result.derivationAudit)}`,
  ));
  header.append(heading, states);
  inspector.append(header);

  // Keep exact navigation at the top of the capsule. On a phone the graph
  // details pane is intentionally shallow, so burying these actions below
  // evidence and certificate prose would make the primary result interfaces
  // appear unavailable.
  const actions = element("div", "result-inspector-actions");
  const derivationAction = normaliseState(result.derivationAudit) === "blocked"
    ? "Conditional derivation and open obligations"
    : "Detailed derivation";
  actions.append(
    action("Registered statement", () => handlers.openStatement(result)),
    action(derivationAction, () => handlers.openDerivation(result)),
  );
  const stableLink = resultInternalLink(result);
  const copyStatus = element("span", "result-inspector-copy-status");
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");
  const copy = action("Copy Mathdown reference", () => {
    void (handlers.copyText ?? copyToClipboard)(stableLink)
      .then(() => {
        copyStatus.textContent = "Link copied";
      })
      .catch(() => {
        copyStatus.textContent = "Could not copy link";
      });
  });
  copy.title = stableLink;
  actions.append(copy, copyStatus);
  inspector.append(actions);

  if (result.headlineStatement) {
    inspector.append(labelledCopy("Curated summary", result.headlineStatement, "result-inspector-statement"));
  }
  if (result.formula) {
    const formula = element("figure", "result-inspector-formula");
    const math = element("div", "result-inspector-math");
    math.setAttribute("aria-label", result.formulaTitle || `Formula for ${result.id}`);
    renderKatex(result.formula, math, true);
    formula.append(math);
    if (result.formulaTitle) {
      formula.append(element("figcaption", "result-inspector-formula-title", result.formulaTitle));
    }
    inspector.append(formula);
  }
  if (result.whyItMatters) {
    inspector.append(labelledCopy("Why it matters", result.whyItMatters, "result-inspector-significance"));
  }

  const metadata = document.createElement("dl");
  metadata.className = "result-inspector-metadata";
  appendDefinition(metadata, "Project", result.project);
  appendDefinition(metadata, "Owner", result.ownerLabel);
  if (result.claimClass) appendDefinition(metadata, "Claim class", result.claimClass);
  if (result.modelState) appendDefinition(metadata, "Model state", result.modelState);
  if (result.branch) appendDefinition(metadata, "Branch", result.branch);
  if (result.jointBlock) appendDefinition(metadata, "Joint block", result.jointBlock);
  inspector.append(metadata);

  inspector.append(
    labelledCopy("Scope and remaining boundary", result.condition || "No remaining condition recorded."),
    labelledCopy("Verification evidence", result.evidence || "No verification evidence recorded."),
  );

  const certificate = element("section", "result-inspector-certificate");
  certificate.append(element("h3", "result-inspector-label", "Formal certificate"));
  if (result.certificate) {
    certificate.append(
      createLeanCertificateBadge(result.certificate, () => handlers.openStatement(result)),
      element(
        "span",
        "result-inspector-certificate-copy",
        `${result.certificate.coverage} Lean-kernel coverage; open the badge for assumptions and exclusions.`,
      ),
    );
  } else {
    certificate.append(element(
      "p",
      "result-inspector-copy",
      "No governed Lean certificate is recorded. Registry validation and mathematical evidence remain separate.",
    ));
  }
  inspector.append(certificate);

  const prerequisites = result.dependsOn.flatMap((id) => {
    const dependency = catalog.byId.get(id);
    return dependency ? [dependency] : [];
  });
  const dependents = catalog.results.filter((candidate) => candidate.dependsOn.includes(result.id));
  const relations = element("div", "result-inspector-relations");
  relations.append(
    relationList("Local public prerequisites", prerequisites, handlers),
    relationList("Used by", dependents, handlers),
  );
  inspector.append(relations);
  inspector.append(element(
    "p",
    "result-inspector-dependency-note",
    "These are local public-result dependencies. Imported and atomic proof obligations remain in the graph and owner derivation.",
  ));
  return inspector;
}

function relationList(
  title: string,
  results: ResultNode[],
  handlers: ResultInspectorHandlers,
): HTMLElement {
  const section = element("section", "result-inspector-relation");
  section.append(element("h3", "result-inspector-label", title));
  if (!results.length) {
    section.append(element("p", "result-inspector-none", "None"));
    return section;
  }
  const list = document.createElement("ul");
  list.className = "result-inspector-relation-list";
  for (const result of results) {
    const item = document.createElement("li");
    const open = action(
      `${DEPENDENCY_STATUS[result.validation].symbol} ${result.id} · ${result.title}`,
      () => (handlers.openRelated ?? handlers.openStatement)(result),
      "result-inspector-related",
    );
    item.append(open);
    list.append(item);
  }
  section.append(list);
  return section;
}

function labelledCopy(label: string, text: string, extra = ""): HTMLElement {
  const section = element("section", `result-inspector-section ${extra}`.trim());
  section.append(
    element("h3", "result-inspector-label", label),
    element("p", "result-inspector-copy", text),
  );
  return section;
}

function appendDefinition(list: HTMLDListElement, term: string, description: string): void {
  list.append(
    element("dt", "result-inspector-term", term),
    element("dd", "result-inspector-definition", description),
  );
}

function statePill(text: string, state: string): HTMLElement {
  return element("span", `result-inspector-state ${state}`, text);
}

function normaliseState(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "unknown";
}

function action(text: string, onClick: () => void, className = "result-inspector-action"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand?.("copy") ?? false;
  field.remove();
  if (!copied) throw new Error("Clipboard API unavailable");
}
