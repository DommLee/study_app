const PAGE_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "into", "than", "then", "they",
  "what", "when", "where", "which", "about", "have", "will", "would", "should", "could", "there",
  "them", "were", "their", "because", "while", "also", "very", "just", "like", "into",
  "kanka", "icin", "gibi", "daha", "olarak", "veya", "yani", "olan", "belge", "konu",
]);

function truncateText(value, maxChars) {
  if (typeof value !== "string") return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]...`;
}

function sanitizeDocumentTextForContext(text, maxChars = 2600) {
  return truncateText(String(text || "").replace(/\u0000/g, "").trim(), maxChars);
}

function extractKeywords(text, limit = 16) {
  const seen = new Set();
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !PAGE_STOPWORDS.has(token))
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    })
    .slice(0, limit);
}

function splitDocumentIntoSegments(doc = {}) {
  const text = String(doc.text || "").replace(/\r/g, "");
  if (!text.trim()) return [];

  const slideMatches = [...text.matchAll(/(?:^|\n)\s*Slide\s+(\d+)\s*\n/gi)];
  if (slideMatches.length >= 2 || (slideMatches.length === 1 && doc.preview?.pageCount)) {
    return slideMatches.map((match, index) => {
      const start = match.index + match[0].length;
      const next = slideMatches[index + 1];
      const end = next ? next.index : text.length;
      const pageNumber = Number(match[1]);
      const body = text.slice(start, end).trim();
      return {
        pageNumber,
        label: `Slide ${pageNumber}`,
        heading: body.split("\n")[0]?.trim() || `Slide ${pageNumber}`,
        text: body,
      };
    }).filter((segment) => segment.text);
  }

  const pageMatches = [...text.matchAll(/(?:^|\n)\s*Page\s+(\d+)\s*\n/gi)];
  if (pageMatches.length >= 2) {
    return pageMatches.map((match, index) => {
      const start = match.index + match[0].length;
      const next = pageMatches[index + 1];
      const end = next ? next.index : text.length;
      const pageNumber = Number(match[1]);
      const body = text.slice(start, end).trim();
      return {
        pageNumber,
        label: `Page ${pageNumber}`,
        heading: body.split("\n")[0]?.trim() || `Page ${pageNumber}`,
        text: body,
      };
    }).filter((segment) => segment.text);
  }

  const paragraphs = text.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter(Boolean);
  return paragraphs.map((chunk, index) => ({
    pageNumber: index + 1,
    label: `Section ${index + 1}`,
    heading: chunk.split("\n")[0]?.trim() || `Section ${index + 1}`,
    text: chunk,
  }));
}

function formatPageList(pages = []) {
  if (!Array.isArray(pages) || !pages.length) return "";
  const sorted = [...new Set(pages.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!sorted.length) return "";

  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = current;
    prev = current;
  }

  return ranges.join(", ");
}

function selectSegments(segments, selectedPages = [], relatedPages = []) {
  if (!Array.isArray(segments) || !segments.length) return [];
  const normalizedSelected = new Set((selectedPages || []).map(Number).filter(Number.isFinite));
  const normalizedRelated = new Set((relatedPages || []).map(Number).filter(Number.isFinite));

  if (!normalizedSelected.size && !normalizedRelated.size) return segments.slice(0, 8);

  return segments.filter((segment) =>
    normalizedSelected.has(segment.pageNumber) || normalizedRelated.has(segment.pageNumber)
  );
}

function buildContextPack({
  session,
  documentIds = [],
  documentId = "",
  selectedPagesByDocument = {},
  relatedPageIdsByDocument = {},
  citationsRequired = true,
  scopeLabel = "",
  scopeText = "",
  maxChars = 14000,
}) {
  const indexedDocs = Array.isArray(session?.documents)
    ? session.documents.filter((doc) => doc.indexed && typeof doc.text === "string" && doc.text.trim())
    : [];

  const explicitDocumentIds = Array.isArray(documentIds) && documentIds.length
    ? documentIds
    : (documentId ? [documentId] : indexedDocs.map((doc) => doc.id));

  const selectedDocs = indexedDocs.filter((doc) => explicitDocumentIds.includes(doc.id));
  const sources = [];
  let usedChars = 0;

  if (scopeText && scopeText.trim()) {
    const truncated = truncateText(scopeText.trim(), Math.min(maxChars, 8000));
    sources.push({
      documentId: explicitDocumentIds[0] || "",
      name: scopeLabel || "Selected study scope",
      label: scopeLabel || "Selected study scope",
      selectedPages: [],
      relatedPages: [],
      text: truncated,
      segments: [],
    });
    usedChars += truncated.length;
  }

  for (const doc of selectedDocs) {
    if (usedChars >= maxChars) break;
    const segments = splitDocumentIntoSegments(doc);
    const selectedPages = (selectedPagesByDocument?.[doc.id] || []).map(Number).filter(Number.isFinite);
    const relatedPages = (relatedPageIdsByDocument?.[doc.id] || []).map(Number).filter(Number.isFinite);
    const selectedSegments = selectSegments(segments, selectedPages, relatedPages);
    const segmentText = selectedSegments.length
      ? selectedSegments.map((segment) => `[${segment.label}] ${segment.heading}\n${segment.text}`).join("\n\n")
      : sanitizeDocumentTextForContext(doc.text || "", 2600);
    const truncated = truncateText(segmentText, Math.max(1200, Math.min(4000, maxChars - usedChars)));

    sources.push({
      documentId: doc.id,
      name: doc.name,
      label: doc.name,
      selectedPages,
      relatedPages,
      text: truncated,
      segments,
      topics: Array.isArray(doc.topics) ? doc.topics : [],
    });
    usedChars += truncated.length;
  }

  const contextText = sources
    .map((source) => `[${source.name}]${source.selectedPages.length ? ` | selected: ${formatPageList(source.selectedPages)}` : ""}${source.relatedPages.length ? ` | related: ${formatPageList(source.relatedPages)}` : ""}\n${source.text}`)
    .join("\n\n");

  const selectedPagesSummary = sources
    .filter((source) => source.selectedPages.length)
    .map((source) => `${source.name}: ${formatPageList(source.selectedPages)}`)
    .join(" | ");

  const relatedPagesSummary = sources
    .filter((source) => source.relatedPages.length)
    .map((source) => `${source.name}: ${formatPageList(source.relatedPages)}`)
    .join(" | ");

  return {
    documentIds: selectedDocs.map((doc) => doc.id),
    selectedPagesByDocument,
    relatedPageIdsByDocument,
    citationsRequired,
    scopeLabel,
    selectedPagesSummary,
    relatedPagesSummary,
    sources,
    contextText,
    coverage: {
      indexedDocumentCount: indexedDocs.length,
      selectedDocumentCount: selectedDocs.length,
      sourceCount: sources.length,
    },
  };
}

function suggestRelatedPages({ session, documentId, selectedPages = [], limit = 4 }) {
  const doc = (session?.documents || []).find((item) => item.id === documentId && item.indexed);
  if (!doc) return [];

  const segments = splitDocumentIntoSegments(doc);
  if (!segments.length) return [];

  const normalizedSelected = [...new Set((selectedPages || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!normalizedSelected.length) return [];

  const selectedSet = new Set(normalizedSelected);
  const selectedText = segments
    .filter((segment) => selectedSet.has(segment.pageNumber))
    .map((segment) => `${segment.heading}\n${segment.text}`)
    .join("\n\n");
  const selectedKeywords = new Set(extractKeywords(selectedText, 18));

  return segments
    .filter((segment) => !selectedSet.has(segment.pageNumber))
    .map((segment) => {
      const segmentKeywords = extractKeywords(`${segment.heading}\n${segment.text}`, 18);
      const overlap = segmentKeywords.filter((keyword) => selectedKeywords.has(keyword)).length;
      const adjacency = normalizedSelected.reduce((best, page) => Math.max(best, Math.max(0, 4 - Math.abs(segment.pageNumber - page))), 0);
      const headingBoost = segment.heading && selectedText.toLowerCase().includes(segment.heading.toLowerCase()) ? 2 : 0;
      const score = overlap * 3 + adjacency * 2 + headingBoost;
      return {
        pageNumber: segment.pageNumber,
        label: segment.label,
        heading: segment.heading,
        score,
        reason: overlap > 0 ? "keyword-overlap" : adjacency >= 3 ? "nearby-continuation" : "topic-neighbor",
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.pageNumber - right.pageNumber)
    .slice(0, limit);
}

module.exports = {
  buildContextPack,
  suggestRelatedPages,
  splitDocumentIntoSegments,
  formatPageList,
  extractKeywords,
  sanitizeDocumentTextForContext,
};
