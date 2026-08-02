import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { schema } from "./schema";
import type { LeanCertificateEvidence } from "../app/lean-certificates";
import { createLeanCertificateBadge } from "../app/lean-certificate-ui";

/**
 * A formal result that can be resolved through the active library's dependency
 * catalog. These are deliberately provider-neutral: no repository path or
 * credential is retained in the editor state.
 */
export interface ResultReference {
  id: string;
  title: string;
  ownerLabel: string;
  certificate?: LeanCertificateEvidence;
}

export interface ResultReferenceMatch {
  from: number;
  to: number;
  reference: ResultReference;
}

export const resultReferencesKey = new PluginKey<DecorationSet>("result-references");

const TOKEN_CHAR = /[A-Za-z0-9_-]/;
interface ReferenceIndex {
  byId: Map<string, ResultReference>;
  pattern: RegExp | null;
}
const referenceIndexes = new WeakMap<object, ReferenceIndex>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indexReferences(references: readonly ResultReference[]): ReferenceIndex {
  const cached = referenceIndexes.get(references);
  if (cached) return cached;
  const byId = new Map(
    references
      .filter((reference) => reference.id.trim())
      .map((reference) => [reference.id, reference]),
  );
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const created = {
    byId,
    pattern: ids.length ? new RegExp(ids.map(escapeRegExp).join("|"), "g") : null,
  };
  referenceIndexes.set(references, created);
  return created;
}

/**
 * Find exact, catalog-known result IDs without guessing from their spelling.
 * This keeps ordinary mathematical identifiers inert and makes the feature
 * work for every project's existing result-ID convention.
 */
export function findResultReferences(
  doc: PMNode,
  references: readonly ResultReference[],
): ResultReferenceMatch[] {
  const { byId, pattern } = indexReferences(references);
  if (!pattern) return [];
  const matches: ResultReferenceMatch[] = [];

  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text || parent?.type.spec.code) return true;
    // Authored links already have their own destination. Never place a second,
    // competing navigation target over the same characters.
    if (node.marks.some((mark) => mark.type === schema.marks.link)) return true;

    // Longest-first alternation prevents a shorter result ID from consuming a
    // longer one's prefix. Boundary checks are still required because IDs
    // contain hyphens and therefore cannot use word-boundary semantics.
    pattern.lastIndex = 0;
    for (let match = pattern.exec(node.text); match; match = pattern.exec(node.text)) {
      const id = match[0];
      const before = match.index > 0 ? node.text[match.index - 1] : "";
      const end = match.index + id.length;
      const after = end < node.text.length ? node.text[end] : "";
      if ((before && TOKEN_CHAR.test(before)) || (after && TOKEN_CHAR.test(after))) continue;
      const reference = byId.get(id);
      if (!reference) continue;
      matches.push({
        from: pos + match.index,
        to: pos + end,
        reference,
      });
    }
    return true;
  });

  return matches;
}

function buildDecorations(
  doc: PMNode,
  references: readonly ResultReference[],
  openOwner?: (resultId: string) => void,
): DecorationSet {
  const decorations: Decoration[] = findResultReferences(doc, references).map((match) => {
    const description = `${match.reference.id}: ${match.reference.title}. Open ${match.reference.ownerLabel}.`;
    return Decoration.inline(
      match.from,
      match.to,
      {
        class: "result-reference",
        "data-result-id": match.reference.id,
        role: "link",
        tabindex: "0",
        title: description,
        "aria-label": description,
      },
      {
        inclusiveStart: false,
        inclusiveEnd: false,
      },
    );
  });
  const { byId } = indexReferences(references);
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.mathdown_source_marker) return true;
    const directive = typeof node.attrs.directive === "string" ? node.attrs.directive : "";
    const match = /^mathdown-(?:claim|derivation|result):(.+)$/.exec(directive);
    const reference = match ? byId.get(match[1]) : undefined;
    if (!reference?.certificate) return false;
    decorations.push(Decoration.widget(
      pos + node.nodeSize,
      () => {
        const wrap = document.createElement("span");
        wrap.className = "lean-certificate-marker";
        wrap.contentEditable = "false";
        wrap.append(createLeanCertificateBadge(
          reference.certificate!,
          () => openOwner?.(reference.id),
        ));
        return wrap;
      },
      { side: -1, key: `lean-certificate:${directive}` },
    ));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function buildResultReferences(
  getReferences: () => readonly ResultReference[],
  openOwner?: (resultId: string) => void,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: resultReferencesKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc, getReferences(), openOwner),
      apply(tr, previous) {
        if (tr.docChanged || tr.getMeta(resultReferencesKey)) {
          return buildDecorations(tr.doc, getReferences(), openOwner);
        }
        return previous;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

/** Rebuild catalog-backed decorations without changing or dirtying the doc. */
export function refreshResultReferences(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(resultReferencesKey, true));
}
