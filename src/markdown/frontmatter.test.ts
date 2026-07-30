import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import {
  parseFrontmatter,
  serializeFrontmatter,
  toKatexMacros,
  emptyMeta,
  metaIsEmpty,
  normalizeMeta,
  countUnresolvedComments,
} from "./frontmatter";
import type { DocMeta } from "./frontmatter";

describe("frontmatter", () => {
  it("ignores malformed comment entries while counting unresolved comments", () => {
    expect(countUnresolvedComments([
      null,
      "bad",
      42,
      {},
      { resolved: false },
      { resolved: true },
    ])).toBe(2);
  });

  it("normalizes malformed comment and reply records before editor import", () => {
    const source = `---
comments: [null,"bad",{"id":"safe","quote":"Body","replies":"bad"},{"quote":"Body","replies":[null,{"body":"ok"}]}]
---
Body
`;
    const comments = parseFrontmatter(source).frontmatter.comments;
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ id: "safe", replies: [] });
    expect(comments[1].replies).toEqual([{ body: "ok" }]);
  });

  it("parses macros and numbering, separating the body", () => {
    const md = [
      "---",
      "macros:",
      '  RR: "\\mathbb{R}"',
      '  dd: "\\,\\mathrm{d}"',
      "numbering:",
      "  equations: section",
      "---",
      "# Body",
    ].join("\n");
    const { frontmatter, body, hadFrontmatter } = parseFrontmatter(md);
    expect(hadFrontmatter).toBe(true);
    expect(frontmatter.macros.RR).toBe("\\mathbb{R}");
    expect(frontmatter.macros.dd).toBe("\\,\\mathrm{d}");
    expect(frontmatter.numbering.equations).toBe("section");
    expect(body).toBe("# Body");
  });

  it("treats a document without frontmatter as all body", () => {
    const { hadFrontmatter, body } = parseFrontmatter("# Just body");
    expect(hadFrontmatter).toBe(false);
    expect(body).toBe("# Just body");
  });

  it("round-trips frontmatter", () => {
    const { frontmatter } = parseFrontmatter(
      '---\nmacros:\n  RR: "\\mathbb{R}"\nnumbering:\n  equations: section\n---\nbody',
    );
    const out = serializeFrontmatter(frontmatter);
    const reparsed = parseFrontmatter(out + "body").frontmatter;
    expect(reparsed.macros.RR).toBe("\\mathbb{R}");
    expect(reparsed.numbering.equations).toBe("section");
  });

  it("round-trips subsection equation numbering and editor heading numbers", () => {
    const { frontmatter } = parseFrontmatter([
      "---",
      "numbering:",
      "  equations: subsection",
      "  headings: true",
      "---",
      "body",
    ].join("\n"));
    expect(frontmatter.numbering).toEqual({
      equations: "subsection",
      headings: true,
    });
    const output = serializeFrontmatter(frontmatter);
    expect(output).toContain("equations: subsection");
    expect(output).toContain("headings: true");
    expect(parseFrontmatter(`${output}body`).frontmatter.numbering).toEqual({
      equations: "subsection",
      headings: true,
    });
  });

  it("emits nothing for empty frontmatter", () => {
    const { frontmatter } = parseFrontmatter("# no meta");
    expect(serializeFrontmatter(frontmatter)).toBe("");
  });

  it("round-trips comments as a one-line JSON value", () => {
    const fm = parseFrontmatter("# doc").frontmatter;
    fm.comments = [
      {
        id: "c1",
        kind: "ai",
        author: "AI reviewer",
        body: "clarify this: quotes \" and commas, too",
        resolved: false,
        start: 5,
        end: 12,
        createdAt: 111,
        replies: [],
      },
    ];
    const out = serializeFrontmatter(fm);
    expect(out).toContain("comments:");
    const reparsed = parseFrontmatter(out + "# doc").frontmatter;
    expect(reparsed.comments).toHaveLength(1);
    expect(reparsed.comments[0].kind).toBe("ai");
    expect(reparsed.comments[0].start).toBe(5);
    expect(reparsed.comments[0].body).toContain("commas, too");
  });

  it("round-trips library metadata as a JSON value", () => {
    const fm = parseFrontmatter("# doc").frontmatter;
    fm.library = {
      id: "abc-123",
      title: "OT gradient flow",
      kind: "derivation",
      status: "draft",
      visibility: "support",
      tags: ["optimal-transport", "gradient-flow"],
      contains: ["theorems"],
      projects: ["trade-networks"],
      related: [{ id: "xyz-9", rel: "extends" }],
      task_authority: {
        mode: "external",
        system: "Task Manager",
        url: "https://example.com/projects/sample-model",
      },
    };
    const out = serializeFrontmatter(fm);
    expect(out).toContain("library:");
    const reparsed = parseFrontmatter(out + "# doc").frontmatter.library;
    expect(reparsed.related).toEqual([{ id: "xyz-9", rel: "extends" }]);
    expect(reparsed.id).toBe("abc-123");
    expect(reparsed.title).toBe("OT gradient flow");
    expect(reparsed.kind).toBe("derivation");
    expect(reparsed.visibility).toBe("support");
    expect(reparsed.tags).toEqual(["optimal-transport", "gradient-flow"]);
    expect(reparsed.projects).toEqual(["trade-networks"]);
    expect(reparsed.task_authority).toEqual({
      mode: "external",
      system: "Task Manager",
      url: "https://example.com/projects/sample-model",
    });
  });

  it("omits an empty library block", () => {
    const fm = parseFrontmatter("# doc").frontmatter;
    expect(metaIsEmpty(fm.library)).toBe(true);
    expect(serializeFrontmatter(fm)).toBe("");
  });

  it("preserves other frontmatter blocks alongside library metadata", () => {
    const md =
      '---\nmacros:\n  RR: "\\mathbb{R}"\nlibrary: {"tags":["x"],"kind":"notes"}\n---\nbody';
    const fm = parseFrontmatter(md).frontmatter;
    expect(fm.macros.RR).toBe("\\mathbb{R}");
    expect(fm.library.tags).toEqual(["x"]);
    expect(fm.library.kind).toBe("notes");
  });

  it("preserves unknown keys, comments, and ordering while changing a known key", () => {
    const source = `---
# exporter-owned setting
customClass: research-note
library: {"id":"doc","tags":[],"contains":[],"projects":[],"related":[]}
customTail:
  keep: true
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    expect(output).toContain("# exporter-owned setting");
    expect(output).toContain("customClass: research-note");
    expect(output).toContain("customTail:\n  keep: true");
    expect(output.indexOf("customClass")).toBeLessThan(output.indexOf("library:"));
    expect(output.indexOf("library:")).toBeLessThan(output.indexOf("customTail:"));
    expect(parseFrontmatter(output).frontmatter.library.title).toBe("Updated");
  });

  it("adds semantically reordered library metadata to a conventional top-level block map", () => {
    const source = `---
custom: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library = {
      visibility: "reader",
      related: [],
      projects: [],
      contains: [],
      tags: [],
      title: "Updated",
    };
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const root = parseDocument(raw).toJS() as Record<string, unknown>;
    expect(root.custom).toBe("keep");
    expect(normalizeMeta(root.library).title).toBe("Updated");
  });

  it.each([
    ["flow map", "{ custom: keep }"],
    ["sequence", "- custom"],
  ])("fails closed instead of appending library metadata to a root %s", (_kind, raw) => {
    const parsed = parseFrontmatter(`---\n${raw}\n---\n\nBody\n`);
    parsed.frontmatter.library.title = "Updated";
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(
      "Cannot safely add library metadata to this frontmatter layout",
    );
  });

  it("accepts only a complete absolute external task authority", () => {
    expect(normalizeMeta({
      task_authority: {
        mode: "external",
        system: "Task Manager",
        url: "https://example.test/tasks",
      },
    }).task_authority).toEqual({
      mode: "external",
      system: "Task Manager",
      url: "https://example.test/tasks",
    });
    expect(normalizeMeta({
      task_authority: { mode: "external", system: "Task Manager", url: "/tasks" },
    }).task_authority).toBeUndefined();
    expect(normalizeMeta({
      task_authority: { mode: "local", system: "Task Manager", url: "https://example.test/tasks" },
    }).task_authority).toBeUndefined();
  });

  it("preserves unknown nested library metadata and YAML comments", () => {
    const source = `---
library:
  id: doc # stable external identifier
  title: Old # curated title
  tags: []
  contains: []
  projects: []
  related: []
  exporter:
    review:
      state: approved # do not discard
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    expect(output).toContain("id: doc # stable external identifier");
    expect(output).toContain("title: Updated # curated title");
    expect(output).toContain("exporter:\n    review:\n      state: approved # do not discard");
    expect(output).toContain("customTail: keep");
  });

  it("preserves nested library data when legacy TeX macros invalidate whole-document YAML", () => {
    const source = `---
macros:
  RR: "\\mathbb{R}"
library:
  id: doc # stable external identifier
  title: Old
  tags: []
  contains: []
  projects: []
  related: []
  exporter:
    review:
      state: approved # do not discard
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    expect(output).toContain('RR: "\\mathbb{R}"');
    expect(output).toContain("id: doc # stable external identifier");
    expect(output).toContain("title: Updated");
    expect(output).toContain("exporter:\n    review:\n      state: approved # do not discard");
    expect(output).toContain("customTail: keep");
  });

  it("recovers known library fields when unrelated YAML remains malformed", () => {
    const source = `---
broken: "\\q"
library:
  id: doc
  title: Old
  tags: [keep]
  contains: [results]
  projects: [project]
  related: []
  custom: keep
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    expect(parsed.frontmatter.library).toMatchObject({
      id: "doc",
      tags: ["keep"],
      contains: ["results"],
      projects: ["project"],
    });
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    expect(output).toContain('broken: "\\q"');
    expect(output).toContain("id: doc");
    expect(output).toContain("custom: keep");
    expect(output).toContain("title: Updated");
    expect(parseFrontmatter(output).frontmatter.library).toMatchObject({
      id: "doc",
      title: "Updated",
      tags: ["keep"],
      contains: ["results"],
      projects: ["project"],
    });
  });

  it("resolves library aliases against anchors elsewhere in valid frontmatter", () => {
    const source = `---
defaultTags: &tags [keep]
library:
  id: doc
  title: Old
  tags: *tags
  contains: []
  projects: []
  related: []
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    const reparsed = parseFrontmatter(output);
    expect(output).toContain("defaultTags: &tags [keep]");
    expect(output).toContain("tags: *tags");
    expect(reparsed.frontmatter.library.title).toBe("Updated");
    expect(reparsed.frontmatter.library.tags).toEqual(["keep"]);
  });

  it("fails closed when clearing an anchored library map would strand an alias", () => {
    const source = `---
library: &lib { id: doc }
mirror: *lib
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library = emptyMeta();
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(/Cannot safely/);
  });

  it("retains a whole-library anchor during a safe edit with malformed surrounding YAML", () => {
    const source = `---
broken: "\\q"
library: &lib { id: doc, title: Old }
mirror: *lib
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    expect(output).toContain('broken: "\\q"');
    expect(output).toMatch(/library: &lib \{ id: doc, title: Updated \}/);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const yaml = parseDocument(raw);
    expect(yaml.errors).not.toHaveLength(0);
    const libraryAnchor = (yaml.get("library", true) as { anchor?: string } | undefined)?.anchor;
    const mirror = yaml.get("mirror", true) as { resolve?: (document: typeof yaml) => unknown } | undefined;
    expect(libraryAnchor).toBe("lib");
    expect(mirror?.resolve?.(yaml)).toBe(yaml.get("library", true));
    expect(parseFrontmatter(output).frontmatter.library.title).toBe("Updated");
  });

  it("rejects a newly unresolved outer alias when changing an anchored known field in malformed YAML", () => {
    const source = `---
broken: "\\q"
library:
  tags: &shared [keep]
mirror: *shared
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.tags = ["changed"];
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(/Cannot safely/);
  });

  it("rejects a newly unresolved outer alias when clearing an anchored library in malformed YAML", () => {
    const source = `---
broken: "\\q"
library: &lib { id: doc }
mirror: *lib
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library = emptyMeta();
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(/Cannot safely/);
  });

  it("rejects silent alias retargeting when a duplicate library anchor is removed", () => {
    const source = `---
broken: "\\q"
library:
  custom: &x custom
  tags: &x [keep]
mirror: *x
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.tags = ["changed"];
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(/Cannot safely/);
  });

  it("preserves duplicate library anchors and their last-definition target during a safe edit", () => {
    const source = `---
broken: "\\q"
library:
  custom: &x custom
  tags: &x [keep]
  title: Old
mirror: *x
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    expect(output.match(/&x/g)).toHaveLength(2);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const yaml = parseDocument(raw);
    const mirror = yaml.get("mirror", true) as { resolve?: (document: typeof yaml) => unknown } | undefined;
    expect(mirror?.resolve?.(yaml)).toBe(yaml.getIn(["library", "tags"], true));
    expect(parseFrontmatter(output).frontmatter.library).toMatchObject({
      title: "Updated",
      tags: ["keep"],
    });
  });

  it("preserves aliased exporter-owned keys when clearing Mathdown metadata", () => {
    const source = `---
customKey: &custom custom
library:
  id: doc
  ? *custom
  : keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library = emptyMeta();
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const yaml = parseDocument(raw);
    expect(yaml.errors).toHaveLength(0);
    expect(yaml.toJS()).toMatchObject({
      customKey: "custom",
      library: { custom: "keep" },
    });
    expect(parseFrontmatter(output).frontmatter.library).toEqual(emptyMeta());
  });

  it("fails closed for a direct library key duplicated through an alias", () => {
    const source = `---
key: &k library
library:
  id: direct
? *k
: { id: alias }
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(
      "Cannot safely update duplicate library frontmatter",
    );
  });

  it.each([
    ["id", "id: &owned doc"],
    ["title", "title: &owned Title"],
    ["kind", "kind: &owned notes"],
    ["status", "status: &owned draft"],
    ["tags", "tags: &owned [tag]"],
    ["contains", "contains: &owned [result]"],
    ["projects", "projects: &owned [project]"],
    ["related", "related: &owned [{ id: other, rel: cites }]"],
    [
      "task_authority",
      "task_authority: &owned { mode: external, system: Tasks, url: 'https://example.test/tasks' }",
    ],
  ])("validates the complete candidate before removing anchored known field %s", (field, declaration) => {
    const sentinel = field === "title" ? "  id: keep\n" : "  title: Keep\n";
    const source = `---
library:
${sentinel}  ${declaration}
mirror: *owned
---

Body
`;
    const parsed = parseFrontmatter(source);
    clearKnownField(parsed.frontmatter.library, field);
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(/Cannot safely/);
  });

  it("refuses a lossy rewrite when malformed surrounding YAML hides an alias anchor", () => {
    const source = `---
broken: "\\q"
defaultTags: &tags [keep]
library:
  id: doc
  title: Old
  tags: *tags
  custom: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(
      "Cannot safely update library frontmatter with unresolved aliases",
    );
  });

  it("opens frontmatter with an unresolved alias without discarding its raw source", () => {
    const source = `---
library:
  id: doc
  title: Old
  tags: *missing
---

Body
`;
    const parsed = parseFrontmatter(source);
    expect(parsed.body).toBe("\nBody\n");
    expect(parsed.frontmatter.library.tags).toEqual([]);
    expect(serializeFrontmatter(parsed.frontmatter)).toBe(source.slice(0, source.indexOf("Body")));
  });

  it("refuses to detach exporter metadata behind a whole-map library alias", () => {
    const source = `---
base: &lib { id: doc, title: Old, custom: keep }
library: *lib
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(
      "Cannot safely update non-map library frontmatter",
    );
  });

  it("fails closed when an aliased mapping key resolves to library", () => {
    const source = `---
key: &k library
? *k
: { id: doc, title: Old, custom: keep }
tail: ok
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(
      "Cannot safely locate library frontmatter source",
    );
  });

  it.each([
    ["quoted key", `'library': { id: doc, title: Old }\ntail: keep`],
    ["spaced key", `library : { id: doc, title: Old }\ntail: keep`],
    ["explicit key", `? library\n: { id: doc, title: Old }\ntail: keep`],
    ["indented root", `  library: { id: doc, title: Old }\n  tail: keep`],
    ["root flow map", `{ library: { id: doc, title: Old }, tail: keep }`],
  ])("fails closed for a library map using a source layout it cannot splice: %s", (_kind, raw) => {
    const source = `---\n${raw}\n---\n\nBody\n`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    expect(() => serializeFrontmatter(parsed.frontmatter)).toThrow(
      "Cannot safely locate library frontmatter source",
    );
  });

  it("keeps column-zero comments inside an indented library mapping", () => {
    const source = `---
library:
  id: doc
# section note
  title: Old
  tags: []
  contains: []
  projects: []
  related: []
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const yaml = parseDocument(raw);
    expect(yaml.errors).toHaveLength(0);
    expect(output).toContain("# section note");
    expect((yaml.toJS() as Record<string, { title: string }>).library.title).toBe("Updated");
    expect((output.match(/title:/g) ?? [])).toHaveLength(1);
  });

  it("does not truncate a flow map containing a quoted closing brace", () => {
    const source = `---
library: { id: doc, title: Old, custom: { pattern: 'literal } brace' } } # keep
customTail: { value: "also } intact" }
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const yaml = parseDocument(raw);
    expect(yaml.errors).toHaveLength(0);
    const root = yaml.toJS() as Record<string, Record<string, unknown>>;
    expect(root.library.custom).toEqual({ pattern: "literal } brace" });
    expect(root.customTail).toEqual({ value: "also } intact" });
    expect(output).toContain("# keep");
  });

  it.each([
    ["anchor", "&lib"],
    ["tag", "!!map"],
  ])("bounds a multiline flow library map prefixed by a YAML %s", (_kind, property) => {
    const source = `---
library: ${property} {
  id: doc,
  title: Old,
  tags: [],
  custom: keep
}
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "Updated";
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    const yaml = parseDocument(raw);
    expect(yaml.errors).toHaveLength(0);
    const root = yaml.toJS() as Record<string, Record<string, unknown> | string>;
    expect((root.library as Record<string, unknown>).title).toBe("Updated");
    expect((root.library as Record<string, unknown>).custom).toBe("keep");
    expect(root.customTail).toBe("keep");
    expect((output.match(/}/g) ?? [])).toHaveLength(1);
  });

  it("replaces a complete pretty-printed comments array without an orphan closer", () => {
    const source = `---
comments: [
  {
    "id": "c1",
    "quote": "q",
    "replies": []
  }
]
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.comments[0].body = "changed";
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    expect(parseDocument(raw).errors).toHaveLength(0);
    expect(output).toContain("customTail: keep");
    expect(output).not.toMatch(/^\]$/m);
  });

  it("replaces a complete pretty-printed library object without an orphan closer", () => {
    const source = `---
library: {
  "id": "d1",
  "tags": []
}
customTail: keep
---

Body
`;
    const parsed = parseFrontmatter(source);
    parsed.frontmatter.library.title = "changed";
    const output = serializeFrontmatter(parsed.frontmatter);
    const raw = /^---\n([\s\S]*?)\n---/.exec(output)![1];
    expect(parseDocument(raw).errors).toHaveLength(0);
    expect(output).toContain("customTail: keep");
    expect(output).not.toMatch(/^\}$/m);
  });

  it("parses and round-trips publication settings", () => {
    const source = `---
publication:
  bibliography:
    - references/library.bib
  documentClass: amsart
  citationStyle: numeric
  language: en
  engine: tectonic
---

Body
`;
    const fm = parseFrontmatter(source).frontmatter;
    expect(fm.publication).toMatchObject({
      bibliography: ["references/library.bib"],
      documentClass: "amsart",
      citationStyle: "numeric",
      engine: "tectonic",
    });
    expect(serializeFrontmatter(fm)).toContain("documentClass: amsart");
  });

  it("distinguishes absent publication fields from an explicitly empty bibliography", () => {
    const absent = parseFrontmatter("---\nlibrary: {\"id\":\"a\"}\n---\nBody\n").frontmatter;
    expect(absent.publicationOverrides).toEqual({});
    const explicit = parseFrontmatter(`---
publication:
  bibliography: []
  citationStyle: authoryear
---
Body
`).frontmatter;
    expect(explicit.publicationOverrides).toEqual({
      bibliography: [],
      citationStyle: "authoryear",
    });
  });

  it("normalizeMeta coerces malformed input to a valid shape", () => {
    const m = normalizeMeta({ tags: ["ok", 3, null], id: "  ", kind: 42, projects: "x" });
    expect(m.tags).toEqual(["ok"]);
    expect(m.id).toBeUndefined(); // blank string dropped
    expect(m.kind).toBeUndefined(); // non-string dropped
    expect(m.projects).toEqual([]); // non-array → empty
    expect(m.related).toEqual([]); // missing → empty
    expect(m.visibility).toBe("reader");
  });

  it("normalizes only the explicit support visibility value", () => {
    expect(normalizeMeta({ visibility: "support" }).visibility).toBe("support");
    expect(normalizeMeta({ visibility: "reader" }).visibility).toBe("reader");
    expect(normalizeMeta({ visibility: "hidden" }).visibility).toBe("reader");
  });

  it("normalizeMeta keeps only well-formed related refs (#I70)", () => {
    const m = normalizeMeta({
      related: [
        { id: "a", rel: "extends" },
        { id: "b" }, // no rel → dropped
        { rel: "cites" }, // no id → dropped
        "junk", // non-object → dropped
        { id: "c", rel: "see-also" },
      ],
    });
    expect(m.related).toEqual([
      { id: "a", rel: "extends" },
      { id: "c", rel: "see-also" },
    ]);
  });

  it("normalizeMeta accepts only a complete absolute external task authority", () => {
    expect(normalizeMeta({
      task_authority: {
        mode: "external",
        system: "Task Manager",
        url: "https://example.test/tasks",
      },
    }).task_authority).toEqual({
      mode: "external",
      system: "Task Manager",
      url: "https://example.test/tasks",
    });
    expect(normalizeMeta({
      task_authority: { mode: "external", system: "Task Manager", url: "/tasks" },
    }).task_authority).toBeUndefined();
    expect(normalizeMeta({
      task_authority: { mode: "local", system: "Task Manager", url: "https://example.test/tasks" },
    }).task_authority).toBeUndefined();
  });

  it("normalizes and round-trips generated projection metadata", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const source = `---\nlibrary: {"id":"claims","tags":[],"contains":["dependency-graph"],"projects":["p"],"related":[],"projection":{"kind":"generated-result-manifest","schema_version":"2.0","sources":["verification/results.yaml","dependency-graph.json","verification/review-exceptions.yaml"],"digest":"${digest}","read_only":true,"acknowledged_warnings":[{"result_id":"R-A","dependencies":["R-B"],"scope":"conditional-test"}]}}\n---\n\nBody\n`;
    const parsed = parseFrontmatter(source);
    expect(parsed.frontmatter.library.projection).toEqual({
      kind: "generated-result-manifest",
      schema_version: "2.0",
      sources: ["verification/results.yaml", "dependency-graph.json", "verification/review-exceptions.yaml"],
      digest,
      read_only: true,
      acknowledged_warnings: [{ result_id: "R-A", dependencies: ["R-B"], scope: "conditional-test" }],
    });
    expect(serializeFrontmatter(parsed.frontmatter)).toBe(source.slice(0, source.indexOf("Body")));
  });

  it("normalizes and round-trips generated dependency reader metadata", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const source = `---\nlibrary: {"id":"graph","tags":[],"contains":["dependency-graph","node-ledger"],"projects":["p"],"related":[],"projection":{"kind":"generated-dependency-reader","schema_version":"2.0","sources":["dependency-graph.json","verification/results.yaml"],"digest":"${digest}","read_only":true}}\n---\n\nBody\n`;
    const parsed = parseFrontmatter(source);
    expect(parsed.frontmatter.library.projection).toEqual({
      kind: "generated-dependency-reader",
      schema_version: "2.0",
      sources: ["dependency-graph.json", "verification/results.yaml"],
      digest,
      read_only: true,
    });
    expect(serializeFrontmatter(parsed.frontmatter)).toBe(source.slice(0, source.indexOf("Body")));
  });

  it("accepts the schema 1.0 generated dependency reader used by legacy projections", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    expect(normalizeMeta({
      projection: {
        kind: "generated-dependency-reader",
        schema_version: "1.0",
        sources: ["dependency-graph.json", "results.yaml"],
        digest,
        read_only: true,
      },
    }).projection).toEqual({
      kind: "generated-dependency-reader",
      schema_version: "1.0",
      sources: ["dependency-graph.json", "results.yaml"],
      digest,
      read_only: true,
    });
  });

  it("prefixes macro names with a backslash for KaTeX", () => {
    const { frontmatter } = parseFrontmatter(
      '---\nmacros:\n  RR: "\\mathbb{R}"\n---\nx',
    );
    expect(toKatexMacros(frontmatter)).toEqual({ "\\RR": "\\mathbb{R}" });
  });
});

function clearKnownField(meta: DocMeta, field: string): void {
  switch (field) {
    case "tags": meta.tags = []; break;
    case "contains": meta.contains = []; break;
    case "projects": meta.projects = []; break;
    case "related": meta.related = []; break;
    default: delete (meta as unknown as Record<string, unknown>)[field];
  }
}
