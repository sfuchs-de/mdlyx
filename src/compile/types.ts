export type CompileJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface CompileDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  generatedLine?: number;
  markdownBlock?: number;
  markdownLine?: number;
  code?: string;
}

export interface CompileJob {
  jobId: string;
  sourceRevision: string;
  state: CompileJobState;
  diagnostics: CompileDiagnostic[];
  createdAt: string;
}

export interface CompileResult {
  jobId: string;
  sourceRevision: string;
  pdfUrl: string;
  diagnostics: CompileDiagnostic[];
}

export interface CompileRequest {
  markdown: string;
  sourceRevision: string;
  profile: "article" | "amsart";
  assets: Array<{ path: string; sha?: string }>;
}

export interface GeneratedSourceBlock {
  generatedFrom: number;
  generatedTo: number;
  markdownBlock: number;
  markdownLine: number;
}

export function mapCompileDiagnostics(
  diagnostics: readonly CompileDiagnostic[],
  blocks: readonly GeneratedSourceBlock[],
): CompileDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.generatedLine == null) return { ...diagnostic };
    const block = blocks.find((candidate) =>
      diagnostic.generatedLine! >= candidate.generatedFrom
      && diagnostic.generatedLine! <= candidate.generatedTo
    );
    if (!block) return { ...diagnostic };
    return {
      ...diagnostic,
      markdownBlock: block.markdownBlock,
      markdownLine: block.markdownLine + diagnostic.generatedLine - block.generatedFrom,
    };
  });
}
