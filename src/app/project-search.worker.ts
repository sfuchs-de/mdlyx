import { searchProjectDocuments, type SearchDocument } from "./project-search-engine";

type SearchRequest =
  | { type: "index"; revision: string; documents: SearchDocument[] }
  | { type: "search"; requestId: number; query: string; project?: string };

let documents: SearchDocument[] = [];

self.addEventListener("message", (event: MessageEvent<SearchRequest>) => {
  if (event.data.type === "index") {
    documents = event.data.documents;
    self.postMessage({ type: "indexed", revision: event.data.revision, count: documents.length });
    return;
  }
  const { requestId, query, project } = event.data;
  self.postMessage({
    type: "results",
    requestId,
    results: searchProjectDocuments(documents, query, project),
  });
});
