import {
  InputRule,
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
} from "prosemirror-inputrules";
import { schema } from "./schema";

// $...$ → inline math atom. Fires when the closing `$` is typed.
export const inlineMathRule = new InputRule(
  /(?:^|[^$])\$([^$\n]+)\$$/,
  (state, match, start, end) => {
    const latex = match[1];
    // Anchor on `start` (the match's document position), not `end`: when the
    // closing `$` is typed over a range selection, `end` sits past the selection
    // and an end-relative offset shifts the replaced range right, eating text.
    // The match may include one leading non-$ char; the typed closing `$` is not
    // yet in the document, so the doc range to replace begins at the `$`.
    const dollarStart = start + (match[0].length - (latex.length + 2));
    const node = schema.nodes.math_inline.create({ latex });
    return state.tr.replaceRangeWith(dollarStart, end, node);
  },
);

// `# ` … `###### ` → heading of the matching level.
const headingRule = textblockTypeInputRule(
  /^(#{1,6})\s$/,
  schema.nodes.heading,
  (match) => ({ level: match[1].length }),
);

// `> ` → blockquote.
const blockquoteRule = wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote);

// `- ` or `* ` → bullet list.
const bulletListRule = wrappingInputRule(
  /^\s*([-*])\s$/,
  schema.nodes.bullet_list,
);

// `1. ` → ordered list.
const orderedListRule = wrappingInputRule(
  /^(\d+)\.\s$/,
  schema.nodes.ordered_list,
  (match) => ({ start: Number(match[1]) }),
  (match, node) => node.childCount + node.attrs.start === Number(match[1]),
);

// ``` → code block.
const codeBlockRule = textblockTypeInputRule(
  /^```$/,
  schema.nodes.code_block,
);

export function buildInputRules() {
  return inputRules({
    rules: [
      inlineMathRule,
      headingRule,
      blockquoteRule,
      bulletListRule,
      orderedListRule,
      codeBlockRule,
    ],
  });
}
