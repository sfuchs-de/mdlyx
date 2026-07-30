import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

// Numbers are computed from document order and delivered to NodeViews as
// decorations (#D04). Because a decoration change re-triggers NodeView.update
// even when the node itself is unchanged, inserting/reordering an equation
// renumbers every later one without storing any number on disk.

export interface NumberingConfig {
  equations: "document" | "section" | "subsection";
  /** Show derived section numbers in the editor without storing them in Markdown. */
  headings?: boolean;
}
export const defaultNumbering: NumberingConfig = {
  equations: "document",
  headings: false,
};

export interface RefInfo {
  kind: string;
  number: string;
}

export const numberingKey = new PluginKey<DecorationSet>("numbering");

// How a resolved cross-reference is spelled out, by target kind.
const KIND_WORD: Record<string, string> = {
  eq: "Equation",
  sec: "Section",
  fig: "Figure",
  tbl: "Table",
  thm: "Theorem",
  lem: "Lemma",
  prop: "Proposition",
  cor: "Corollary",
  def: "Definition",
  generic: "",
};

const THEOREM_KIND_PREFIX: Record<string, string> = {
  theorem: "thm",
  lemma: "lem",
  proposition: "prop",
  corollary: "cor",
  definition: "def",
};

export interface NumberingResult {
  labels: Map<string, RefInfo>;
  /** ids defined more than once (ambiguous — a ref to one is flagged). */
  duplicates: Set<string>;
  headingPositions: { pos: number; node: PMNode; num: string }[];
  eqPositions: { pos: number; node: PMNode; num: string }[];
  xrefPositions: { pos: number; node: PMNode }[];
}

// Pure pass over the document: assign section + equation numbers and collect
// the positions that need decorations. Exported for unit testing.
export function computeNumbering(
  doc: PMNode,
  config: NumberingConfig,
): NumberingResult {
  const labels = new Map<string, RefInfo>();
  const duplicates = new Set<string>();
  const headingPositions: NumberingResult["headingPositions"] = [];
  const eqPositions: NumberingResult["eqPositions"] = [];
  const xrefPositions: NumberingResult["xrefPositions"] = [];
  const counters = [0, 0, 0, 0, 0, 0];
  let eqCounter = 0;
  let eqInSection = 0;
  let eqInSubsection = 0;
  let figureCounter = 0;
  let tableCounter = 0;
  const theoremCounters = new Map<string, number>();

  // Define a label; a second definition of the same id is a duplicate — keep the
  // FIRST (deterministic, matches the LaTeX-export dedup) and flag the id (#I47).
  const define = (id: string, info: RefInfo) => {
    if (labels.has(id)) duplicates.add(id);
    else labels.set(id, info);
  };

  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.heading) {
      const level = node.attrs.level as number;
      counters[level - 1]++;
      for (let k = level; k < counters.length; k++) counters[k] = 0;
      if (level === 1) eqInSection = 0;
      if (level <= 2) eqInSubsection = 0;
      const num = counters.slice(0, level).join(".");
      headingPositions.push({ pos, node, num });
      if (node.attrs.id) define(node.attrs.id as string, { kind: "sec", number: num });
    } else if (node.type === schema.nodes.math_display) {
      if (node.attrs.numbered) {
        let num: string;
        if (config.equations === "subsection" && counters[0] > 0 && counters[1] > 0) {
          num = `${counters[0]}.${counters[1]}.${++eqInSubsection}`;
        } else if (
          (config.equations === "section" || config.equations === "subsection")
          && counters[0] > 0
        ) {
          num = `${counters[0]}.${++eqInSection}`;
        } else {
          num = `${++eqCounter}`;
        }
        eqPositions.push({ pos, node, num });
        if (node.attrs.label) define(node.attrs.label as string, { kind: "eq", number: num });
      }
    } else if (node.type === schema.nodes.figure) {
      if (node.attrs.caption || node.attrs.id) {
        const number = String(++figureCounter);
        if (node.attrs.id) define(node.attrs.id as string, { kind: "fig", number });
      }
    } else if (node.type === schema.nodes.table) {
      if (node.attrs.caption || node.attrs.id) {
        const number = String(++tableCounter);
        if (node.attrs.id) define(node.attrs.id as string, { kind: "tbl", number });
      }
    } else if (node.type === schema.nodes.theorem && node.attrs.kind !== "proof") {
      const theoremKind = String(node.attrs.kind || "theorem").toLowerCase();
      const number = (theoremCounters.get(theoremKind) ?? 0) + 1;
      theoremCounters.set(theoremKind, number);
      if (node.attrs.id) {
        define(node.attrs.id as string, {
          kind: THEOREM_KIND_PREFIX[theoremKind] ?? "generic",
          number: String(number),
        });
      }
    } else if (node.type === schema.nodes.xref) {
      xrefPositions.push({ pos, node });
    }
    return true;
  });

  return { labels, duplicates, headingPositions, eqPositions, xrefPositions };
}

// Render text for a resolved (or broken) cross-reference.
export function refText(
  info: RefInfo | undefined,
  kind: string,
): { text: string; broken: boolean } {
  const word = KIND_WORD[kind] ?? "";
  if (info) {
    return {
      text: word ? `${word} (${info.number})` : `(${info.number})`,
      broken: false,
    };
  }
  return { text: `${word ? word + " " : ""}(??)`, broken: true };
}

export function buildNumbering(getConfig: () => NumberingConfig): Plugin {
  const build = (doc: PMNode): DecorationSet => {
    const { labels, duplicates, headingPositions, eqPositions, xrefPositions } = computeNumbering(
      doc,
      getConfig(),
    );
    const decos: Decoration[] = [];
    if (getConfig().headings) {
      for (const heading of headingPositions) {
        decos.push(
          Decoration.node(
            heading.pos,
            heading.pos + heading.node.nodeSize,
            { "data-heading-number": heading.num },
          ),
        );
      }
    }
    for (const e of eqPositions) {
      decos.push(
        Decoration.node(e.pos, e.pos + e.node.nodeSize, {}, { eqNumber: e.num }),
      );
    }
    for (const x of xrefPositions) {
      const kind = (x.node.attrs.kind as string) || "generic";
      const target = x.node.attrs.target as string;
      // A ref to a duplicated (ambiguous) label is flagged like a broken ref, so
      // the author sees the label needs fixing rather than a silent wrong number.
      const info = duplicates.has(target) ? undefined : labels.get(target);
      const { text, broken } = refText(info, kind);
      decos.push(
        Decoration.node(
          x.pos,
          x.pos + x.node.nodeSize,
          {},
          { refText: text, broken },
        ),
      );
    }
    return DecorationSet.create(doc, decos);
  };

  return new Plugin<DecorationSet>({
    key: numberingKey,
    state: {
      init: (_config, state) => build(state.doc),
      apply(tr, old) {
        // Recompute on any doc change, or when the config changes (a meta ping).
        if (tr.docChanged || tr.getMeta(numberingKey)) return build(tr.doc);
        return old;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
