export interface SearchDocument {
  id?: string;
  title: string;
  path: string;
  projects: string[];
  visibility?: "reader" | "support";
  text: string;
}

export interface ProjectSearchResult {
  id?: string;
  title: string;
  path: string;
  project?: string;
  line: number;
  excerpt: string;
}

export interface SearchIndexSnapshot {
  revision: string;
  documents: SearchDocument[];
  truncated?: boolean;
  omittedDocuments?: number;
}

export const MAX_SEARCH_DOCUMENTS = 5_000;
export const MAX_SEARCH_DOCUMENT_CHARS = 1_000_000;
export const MAX_SEARCH_INDEX_CHARS = 50_000_000;

export function searchProjectDocuments(
  documents: SearchDocument[],
  rawQuery: string,
  project?: string,
  limit = 100,
): ProjectSearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];
  const results: ProjectSearchResult[] = [];
  for (const document of documents) {
    if (project && !document.projects.includes(project)) continue;
    if (document.visibility === "support") {
      const exactId = document.id?.toLocaleLowerCase() === query;
      const exactPath = document.path.toLocaleLowerCase() === query;
      if (!exactId && !exactPath) continue;
      results.push({
        id: document.id,
        title: document.title,
        path: document.path,
        project: project ?? document.projects[0],
        line: 1,
        excerpt: "Retained archive or compatibility document.",
      });
      if (results.length >= limit) return results;
      continue;
    }
    const lines = document.text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const match = line.toLocaleLowerCase().indexOf(query);
      if (match < 0) continue;
      const start = Math.max(0, match - 60);
      const end = Math.min(line.length, match + query.length + 90);
      results.push({
        id: document.id,
        title: document.title,
        path: document.path,
        project: project ?? document.projects[0],
        line: index + 1,
        excerpt: `${start ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`,
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}
