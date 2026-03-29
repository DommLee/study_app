(function () {
  const PAGE_TEXT_LIMIT = 12000;
  const REQUEST_TIMEOUT_MS = 45000;
  const BASE_SCALE = 1.4;
  const MIN_SCALE = 0.8;
  const MAX_SCALE = 2.8;
  const MAX_RENDERED_VISIBLE_PAGES = 8;
  const PDF_EXT_RE = /\.pdf$/i;
  const PPT_EXT_RE = /\.(ppt|pptx)$/i;
  const DOC_EXT_RE = /\.docx$/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
  const SOURCE_TEXT_LIMIT = 26000;

  function t(key, params = {}, fallback = "") {
    return window.i18n?.t(key, params, fallback) || fallback || key;
  }

  let pdfDoc = null;
  let currentPage = 0;
  let totalPages = 0;
  let currentScale = BASE_SCALE;
  let currentSourceMode = "";
  let currentSourceKey = "";
  let currentTextSource = "";
  let selectedPageSequence = [];
  let activeExplainController = null;
  let renderVersion = 0;

  const sourceStore = new Map();
  const pageTextCache = new Map();
  const documentTextCache = new Map();

  const pdfPrevBtn = document.getElementById("pdfPrev");
  const pdfNextBtn = document.getElementById("pdfNext");
  const pdfPageEl = document.getElementById("pdfPage");
  const pdfTotalEl = document.getElementById("pdfTotal");
  const studyNoPdf = document.getElementById("studyNoPdf");
  const pdfViewer = document.getElementById("pdfViewer");
  const studyPageStack = document.getElementById("studyPageStack");
  const pdfCanvas = document.getElementById("pdfCanvas");
  const studyDropZone = document.getElementById("studyDropZone");
  const studyFileInput = document.getElementById("studyFileInput");
  const studyDocumentSelect = document.getElementById("studyDocumentSelect");
  const studyOnboardingCard = document.getElementById("studyOnboardingCard");
  const studySourcePackCard = document.getElementById("studySourcePackCard");
  const studySourcePackBody = document.getElementById("studySourcePackBody");
  const studySourcePackToggle = document.getElementById("studySourcePackToggle");
  const studySourcePackMeta = document.getElementById("studySourcePackMeta");
  const studySourcePackSummary = document.getElementById("studySourcePackSummary");
  const studySourcePackChips = document.getElementById("studySourcePackChips");
  const studyScopeQuickChips = document.getElementById("studyScopeQuickChips");
  const studyZoomOutBtn = document.getElementById("studyZoomOut");
  const studyZoomInBtn = document.getElementById("studyZoomIn");
  const studyZoomResetBtn = document.getElementById("studyZoomReset");
  const studyZoomLevel = document.getElementById("studyZoomLevel");
  const studyToggleTextBtn = document.getElementById("studyToggleText");
  const studyCopyTextBtn = document.getElementById("studyCopyText");
  const studyCopyTextSecondaryBtn = document.getElementById("studyCopyTextSecondary");
  const studyPageScopeMode = document.getElementById("studyPageScopeMode");
  const studyPageSelectionInput = document.getElementById("studyPageSelectionInput");
  const studyApplyPageSelectionBtn = document.getElementById("studyApplyPageSelection");
  const studySelectionInfo = document.getElementById("studySelectionInfo");
  const studySourcePackInlineToggle = document.getElementById("studySourcePackInlineToggle");
  const studyVisiblePageChips = document.getElementById("studyVisiblePageChips");
  const studyClearScopeBtn = document.getElementById("studyClearScopeBtn");
  const studyAcceptSuggestionsBtn = document.getElementById("studyAcceptSuggestionsBtn");
  const studyTextDrawer = document.getElementById("studyTextDrawer");
  const studyPageText = document.getElementById("studyPageText");
  const studyDocTextPreview = document.getElementById("studyDocTextPreview");
  const studyChatMessages = document.getElementById("studyChatMessages");
  const studyCustomPrompt = document.getElementById("studyCustomPrompt");
  const studyAskBtn = document.getElementById("studyAskBtn");
  const studyToolsToggle = document.getElementById("studyToolsToggle");
  const studyToolsOverlay = document.getElementById("studyToolsOverlay");
  const studyToolsDrawer = document.getElementById("studyToolsDrawer");
  const studyToolsClose = document.getElementById("studyToolsClose");
  const studyExplainBtn = document.getElementById("studyExplainBtn");
  const studySummarizeBtn = document.getElementById("studySummarizeBtn");
  const studyKeyBtn = document.getElementById("studyKeyBtn");
  const studyFeynmanBtn = document.getElementById("studyFeynmanBtn");
  const studyLanguageSelect = document.getElementById("studyLanguageSelect");
  const studyCoverageBadge = document.getElementById("studyCoverageBadge");
  const studySuggestPagesBtn = document.getElementById("studySuggestPagesBtn");
  const studyAudioBtn = document.getElementById("studyAudioBtn");
  const studyMindMapBtn = document.getElementById("studyMindMapBtn");
  const studyRelatedPages = document.getElementById("studyRelatedPages");
  const studyInsightPanel = document.getElementById("studyInsightPanel");
  const studyInsightTitle = document.getElementById("studyInsightTitle");
  const studyInsightContent = document.getElementById("studyInsightContent");
  const studyInsightClose = document.getElementById("studyInsightClose");
  const studyPaneResizer = document.getElementById("studyPaneResizer");
  const studyAiPane = document.querySelector(".study-ai-pane");
  const initialStudyMessages = studyChatMessages ? studyChatMessages.innerHTML : "";

  const actionButtons = [
    studyExplainBtn,
    studySummarizeBtn,
    studyKeyBtn,
    studyFeynmanBtn,
    studyAskBtn,
  ].filter(Boolean);
  const toolButtons = [
    studySuggestPagesBtn,
    studyAudioBtn,
    studyMindMapBtn,
  ].filter(Boolean);

  let relatedPageSuggestions = [];
  let activeStudyToolController = null;
  let speechCancelToken = 0;
  const STUDY_PACK_COLLAPSED_KEY = "omnitutor-study-pack-collapsed";
  const STUDY_TOOLS_OPEN_KEY = "omnitutor-study-tools-open";
  const STUDY_PANE_WIDTH_KEY = "omnitutor-study-pane-width";
  let studyPackManualPreference = null;

  actionButtons.forEach((button) => {
    if (button) button.dataset.baseLabel = button.textContent;
  });
  toolButtons.forEach((button) => {
    if (button) button.dataset.baseLabel = button.textContent;
  });

  function toast(message, type = "") {
    if (typeof window.showToast === "function") {
      window.showToast(message, type);
    }
  }

  function isStudyActive() {
    const panel = document.getElementById("panelStudy");
    return !!panel && panel.classList.contains("active");
  }

  function resetStudyMessages() {
    if (studyChatMessages) {
      studyChatMessages.innerHTML = initialStudyMessages;
    }
  }

  function getApiError(data) {
    return typeof window.getApiError === "function" ? window.getApiError(data) : null;
  }

  async function readJsonResponse(res, fallbackMessage) {
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      const raw = await res.text();
      if (raw.includes("<!DOCTYPE")) {
        throw new Error(`${fallbackMessage} Server HTML hata sayfasi dondurdu.`);
      }
      throw new Error(raw.trim() || fallbackMessage);
    }

    const data = await res.json();
    const apiError = getApiError(data);
    if (!res.ok || apiError) {
      throw new Error(apiError?.message || fallbackMessage);
    }
    return data;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function updatePageCounters() {
    if (pdfPageEl) pdfPageEl.textContent = String(currentPage || 0);
    if (pdfTotalEl) pdfTotalEl.textContent = String(totalPages || 0);
  }

  function formatSelectedPages(pages) {
    if (!Array.isArray(pages) || !pages.length) return t("study.allPagesVisible", {}, "All pages visible");
    const segments = [];
    let start = pages[0];
    let prev = pages[0];

    for (let index = 1; index <= pages.length; index += 1) {
      const value = pages[index];
      if (value === prev + 1) {
        prev = value;
        continue;
      }
      segments.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = value;
      prev = value;
    }

    const unit = getPageUnitLabel() === "Slide"
      ? t("study.slidesLabel", {}, "Slides")
      : t("study.pagesLabel", {}, "Pages");
    return `${unit}: ${segments.join(", ")}`;
  }

  function renderStudySourcePack() {
    const source = getCurrentSource();
    const isPdf = currentSourceMode === "pdf" && !!pdfDoc;

    if (studyOnboardingCard) {
      studyOnboardingCard.style.display = source ? "none" : "block";
    }

    if (!studySourcePackMeta || !studySourcePackSummary || !studySourcePackChips) return;

    studySourcePackChips.innerHTML = "";

    if (!source) {
      studySourcePackMeta.textContent = t("study.packMetaEmpty", {}, "No source selected");
      studySourcePackSummary.textContent = t(
        "study.packSummaryEmpty",
        {},
        "Upload one document, then choose which pages or slides the AI should use."
      );
      return;
    }

    const typeLabel = source.typeLabel || inferSourceTypeLabel(source.name, source.kind);
    const scopeLabel = isPdf
      ? formatSelectedPages(selectedPageSequence)
      : t("study.fullTextVisible", {}, "Full text source visible");

    studySourcePackMeta.textContent = isPdf
      ? `${typeLabel} • ${source.name} • ${scopeLabel}`
      : `${typeLabel} • ${source.name}`;
    studySourcePackSummary.textContent = isPdf
      ? t(
          "study.packSummaryPdf",
          { pages: scopeLabel },
          `Visible scope: ${scopeLabel}. AI uses only these pages/slides and connects them like a teacher.`
        )
      : t(
          "study.packSummaryText",
          {},
          "The full extracted source text is active. Ask directly or narrow the scope with a more specific question."
        );

    const mainChip = document.createElement("span");
    mainChip.className = "source-chip";
    mainChip.textContent = `${typeLabel} ${source.name}`;
    studySourcePackChips.appendChild(mainChip);

    const scopeChip = document.createElement("span");
    scopeChip.className = "source-chip";
    scopeChip.textContent = scopeLabel;
    studySourcePackChips.appendChild(scopeChip);

    if (isPdf && relatedPageSuggestions.length) {
      const relatedChip = document.createElement("span");
      relatedChip.className = "source-chip muted";
      relatedChip.textContent = t(
        "study.relatedSuggestionsCount",
        { count: relatedPageSuggestions.length },
        `${relatedPageSuggestions.length} related suggestions`
      );
      studySourcePackChips.appendChild(relatedChip);
    }

    syncStudyPackForMode();
  }

  function getStoredStudyPackCollapsed() {
    try {
      const stored = localStorage.getItem(STUDY_PACK_COLLAPSED_KEY);
      if (stored === null) {
        return typeof window.getCurrentSimpleMode === "function" ? window.getCurrentSimpleMode() : false;
      }
      return stored === "true";
    } catch {
      return typeof window.getCurrentSimpleMode === "function" ? window.getCurrentSimpleMode() : false;
    }
  }

  function getStoredStudyToolsOpen() {
    try {
      return localStorage.getItem(STUDY_TOOLS_OPEN_KEY) === "true";
    } catch {
      return false;
    }
  }

  function setStudyToolsOpen(open, options = {}) {
    if (!studyToolsDrawer || !studyToolsOverlay || !studyToolsToggle) return;
    const next = !!open;
    studyToolsDrawer.classList.toggle("open", next);
    studyToolsOverlay.classList.toggle("open", next);
    studyAiPane?.classList.toggle("tools-open", next);
    studyToolsDrawer.setAttribute("aria-hidden", next ? "false" : "true");
    studyToolsToggle.setAttribute("aria-expanded", next ? "true" : "false");
    if (options.persist !== false) {
      try {
        localStorage.setItem(STUDY_TOOLS_OPEN_KEY, String(next));
      } catch {}
    }
  }

  function getStoredStudyPaneWidth() {
    try {
      const stored = Number(localStorage.getItem(STUDY_PANE_WIDTH_KEY));
      return Number.isFinite(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  function applyStoredStudyPaneWidth() {
    if (!studyAiPane) return;
    const width = getStoredStudyPaneWidth();
    if (width && width >= 460 && width <= 1100) {
      studyAiPane.style.width = `${width}px`;
    }
  }

  function setStudyPackCollapsed(collapsed, options = {}) {
    if (!studySourcePackCard || !studySourcePackToggle) return;
    const next = !!collapsed;
    if (options.userAction) {
      studyPackManualPreference = next ? "collapsed" : "expanded";
    }
    studySourcePackCard.classList.toggle("collapsed", next);
    if (studySourcePackBody) {
      studySourcePackBody.setAttribute("aria-hidden", next ? "true" : "false");
    }
    studySourcePackToggle.setAttribute("aria-expanded", next ? "false" : "true");
    studySourcePackToggle.textContent = t(
      next ? "study.showSourcePack" : "study.hideSourcePack",
      {},
      next ? "Show" : "Hide"
    );
    if (studySourcePackInlineToggle) {
      studySourcePackInlineToggle.setAttribute("aria-expanded", next ? "false" : "true");
      studySourcePackInlineToggle.textContent = t(
        next ? "study.showSourcePack" : "study.hideSourcePack",
        {},
        next ? "Show" : "Hide"
      );
    }
    if (options.persist !== false) {
      try {
        localStorage.setItem(STUDY_PACK_COLLAPSED_KEY, String(next));
      } catch {}
    }
  }

  function renderVisiblePageChips() {
    if (!studyVisiblePageChips) return;
    studyVisiblePageChips.innerHTML = "";

    const isPdf = currentSourceMode === "pdf" && !!pdfDoc;
    if (!isPdf) {
      if (studyClearScopeBtn) studyClearScopeBtn.disabled = true;
      if (studyAcceptSuggestionsBtn) studyAcceptSuggestionsBtn.disabled = true;
      return;
    }

    const selectedPages = getEffectivePageSequence();
    const chipPages = selectedPages.length > 18
      ? getRenderedPageSequence(currentPage || selectedPages[0] || 1)
      : selectedPages;
    const pageUnit = getPageUnitLabel();
    const canRemovePages = Array.isArray(selectedPageSequence) && selectedPageSequence.length > 0;

    chipPages.forEach((pageNumber) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `study-page-chip${pageNumber === currentPage ? " active" : ""}`;
      chip.textContent = `${pageUnit} ${pageNumber}`;
      chip.title = t(
        pageUnit === "Slide" ? "study.jumpToSlide" : "study.jumpToPage",
        { page: pageNumber },
        `Jump to ${pageUnit} ${pageNumber}`
      );
      chip.addEventListener("click", () => {
        renderPage(pageNumber).catch((error) => toast(error.message || t("study.pageOpenFailed", {}, "Page could not be opened."), "error"));
      });
      if (!canRemovePages) {
        studyVisiblePageChips.appendChild(chip);
        return;
      }

      const group = document.createElement("div");
      group.className = `study-page-chip-group${pageNumber === currentPage ? " active" : ""}`;
      group.appendChild(chip);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "study-page-chip-remove";
      removeButton.textContent = "×";
      removeButton.title = t(
        "study.removePage",
        { page: pageNumber },
        `Remove ${pageUnit} ${pageNumber} from the selection`
      );
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        removePageFromSelection(pageNumber).catch((error) => toast(error.message, "error"));
      });

      group.appendChild(removeButton);
      studyVisiblePageChips.appendChild(group);
    });

    if (selectedPages.length > chipPages.length) {
      const extra = document.createElement("span");
      extra.className = "study-page-chip ghost";
      extra.textContent = t("study.extraPages", { count: selectedPages.length - chipPages.length }, `+${selectedPages.length - chipPages.length} more`);
      studyVisiblePageChips.appendChild(extra);
    }

    if (studyClearScopeBtn) {
      studyClearScopeBtn.disabled = !selectedPageSequence.length;
      studyClearScopeBtn.textContent = t("study.showAllPages", {}, "Show all pages");
    }

    if (studyAcceptSuggestionsBtn) {
      const currentSet = new Set(selectedPages);
      const addable = relatedPageSuggestions.filter((item) => !currentSet.has(Number(item.pageNumber))).length;
      studyAcceptSuggestionsBtn.disabled = addable === 0;
      studyAcceptSuggestionsBtn.textContent = t("study.addAllSuggested", {}, "Add all suggested");
    }
  }

  function updateScopeQuickChips() {
    if (!studyScopeQuickChips) return;
    const isPdf = currentSourceMode === "pdf" && !!pdfDoc;
    studyScopeQuickChips.querySelectorAll(".scope-chip").forEach((button) => {
      const mode = button.dataset.scope || "";
      button.classList.toggle("active", isPdf && mode === (studyPageScopeMode?.value || "all-pages"));
      button.disabled = !isPdf;
    });
  }

  function updateSelectionInfo() {
    if (!studySelectionInfo) return;
    if (currentSourceMode !== "pdf" || !pdfDoc) {
      studySelectionInfo.textContent = currentSourceMode === "text"
        ? t("study.fullTextVisible", {}, "Full text source visible")
        : t("study.allPagesVisible", {}, "All pages visible");
      studySelectionInfo.title = "";
      updateCoverageBadge();
      renderStudySourcePack();
      updateScopeQuickChips();
      renderVisiblePageChips();
      return;
    }
    const pageSequence = getEffectivePageSequence();
    studySelectionInfo.textContent = formatSelectedPages(selectedPageSequence);
    studySelectionInfo.title = pageSequence.length > MAX_RENDERED_VISIBLE_PAGES
      ? `Selected scope is large. Up to ${MAX_RENDERED_VISIBLE_PAGES} pages are rendered in one viewport window.`
      : "Selected pages are used as the AI and viewer scope.";
    updateCoverageBadge();
    renderStudySourcePack();
    updateScopeQuickChips();
    renderVisiblePageChips();
  }

  function getEffectivePageSequence() {
    if (currentSourceMode !== "pdf" || !pdfDoc) return [];
    if (Array.isArray(selectedPageSequence) && selectedPageSequence.length) return selectedPageSequence;
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  function getRenderedPageSequence(focusPage = currentPage || 1) {
    const pageSequence = getEffectivePageSequence();
    if (pageSequence.length <= MAX_RENDERED_VISIBLE_PAGES) return pageSequence;

    const focusIndex = Math.max(0, pageSequence.indexOf(focusPage));
    const windowSize = MAX_RENDERED_VISIBLE_PAGES;
    const halfWindow = Math.floor(windowSize / 2);
    let start = Math.max(0, focusIndex - halfWindow);
    let end = Math.min(pageSequence.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    return pageSequence.slice(start, end);
  }

  function getPageUnitLabel() {
    const source = sourceStore.get(currentSourceKey);
    return source && PPT_EXT_RE.test(source.name) ? "Slide" : "Page";
  }

  function updatePageSelectionInputState() {
    const isCustom = studyPageScopeMode?.value === "custom-pages";
    if (studyPageSelectionInput) {
      studyPageSelectionInput.disabled = !isCustom || currentSourceMode !== "pdf" || !pdfDoc;
    }
  }

  function getActiveStudyLanguage() {
    return studyLanguageSelect?.value
      || (typeof window.getCurrentResponseLanguage === "function" ? window.getCurrentResponseLanguage() : "tr-TR");
  }

  function getCurrentPreset() {
    return typeof window.getCurrentPromptPreset === "function"
      ? window.getCurrentPromptPreset()
      : "auto";
  }

  function getCurrentSource() {
    return sourceStore.get(currentSourceKey) || null;
  }

  function getCurrentContextPack() {
    const source = getCurrentSource();
    const documentIds = source?.documentId ? [source.documentId] : [];
    const selectedPagesByDocument = {};
    if (source?.documentId && currentSourceMode === "pdf" && pdfDoc) {
      const pages = getEffectivePageSequence();
      if (pages.length) {
        selectedPagesByDocument[source.documentId] = pages;
      }
    }

    return {
      documentIds,
      selectedPagesByDocument,
      relatedPageIdsByDocument: {},
      citationsRequired: true,
    };
  }

  function updateCoverageBadge() {
    if (!studyCoverageBadge) return;
    const source = getCurrentSource();
    if (!source) {
      studyCoverageBadge.textContent = "Scope ready";
      return;
    }

    if (currentSourceMode === "pdf" && pdfDoc) {
      const pages = getEffectivePageSequence();
      const unit = getPageUnitLabel().toLowerCase();
      studyCoverageBadge.textContent = `${pages.length || totalPages || 0} ${unit}`;
      return;
    }

    if (currentSourceMode === "text") {
      const textLength = truncateSourceText(currentTextSource, SOURCE_TEXT_LIMIT).length;
      const approxBlocks = Math.max(1, Math.round(textLength / 900));
      studyCoverageBadge.textContent = `${approxBlocks} text blocks`;
      return;
    }

    studyCoverageBadge.textContent = "Scope ready";
  }

  function hideInsightPanel() {
    if (studyInsightPanel) studyInsightPanel.style.display = "none";
    if (studyInsightTitle) studyInsightTitle.textContent = "Generated Insight";
    if (studyInsightContent) studyInsightContent.innerHTML = "";
  }

  async function showInsightPanel(title, html, options = {}) {
    if (!studyInsightPanel || !studyInsightTitle || !studyInsightContent) return;
    studyInsightTitle.textContent = title || "Generated Insight";
    studyInsightContent.innerHTML = html || "";
    studyInsightPanel.style.display = "block";

    if (options.mermaid && window.mermaid) {
      try {
        const container = studyInsightContent.querySelector(".mermaid");
        if (container) {
          const renderId = `study-mermaid-${Date.now()}`;
          const { svg } = await window.mermaid.render(renderId, options.mermaid);
          container.outerHTML = svg;
        }
      } catch (error) {
        console.error("Mermaid render error:", error);
      }
    }
  }

  function shouldAutoCollapseStudyPack() {
    return typeof window.getCurrentSimpleMode === "function" ? window.getCurrentSimpleMode() : false;
  }

  function syncStudyPackForMode() {
    if (!studySourcePackCard) return;
    const hasSource = !!getCurrentSource();
    if (!hasSource) {
      setStudyPackCollapsed(getStoredStudyPackCollapsed(), { persist: false });
      return;
    }
    if (shouldAutoCollapseStudyPack() && studyPackManualPreference !== "expanded") {
      setStudyPackCollapsed(true, { persist: false });
    }
  }

  function stopStudySpeech() {
    speechCancelToken += 1;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function playStudySpeech(lines = [], language = "tr-TR") {
    if (!("speechSynthesis" in window)) {
      toast(t("study.audioUnsupported", {}, "Browser speech synthesis is not supported."), "error");
      return;
    }

    stopStudySpeech();
    const token = speechCancelToken;
    const queue = lines
      .map((line) => `${line.speaker}: ${line.text}`.trim())
      .filter(Boolean);

    function speakNext(index) {
      if (token !== speechCancelToken || index >= queue.length) return;
      const utterance = new SpeechSynthesisUtterance(queue[index]);
      utterance.lang = language || "tr-TR";
      utterance.rate = 1;
      utterance.onend = () => speakNext(index + 1);
      utterance.onerror = () => speakNext(index + 1);
      window.speechSynthesis.speak(utterance);
    }

    speakNext(0);
  }

  function renderRelatedSuggestions() {
    if (!studyRelatedPages) return;
    studyRelatedPages.innerHTML = "";

    const currentSet = new Set(getEffectivePageSequence());
    const pendingSuggestions = relatedPageSuggestions.filter((item) => !currentSet.has(Number(item.pageNumber)));

    if (!pendingSuggestions.length) {
      const empty = document.createElement("span");
      empty.className = "study-custom-hint";
      empty.textContent = t("study.noRelatedSuggestions", {}, "No related-page suggestions yet.");
      studyRelatedPages.appendChild(empty);
      renderVisiblePageChips();
      return;
    }

    pendingSuggestions.slice(0, 6).forEach((suggestion) => {
      const chip = document.createElement("div");
      chip.className = "study-related-chip";
      chip.title = `${suggestion.heading || suggestion.label || ""} | ${suggestion.reason || "related"}`;

      const head = document.createElement("div");
      head.className = "study-related-chip-head";

      const titleWrap = document.createElement("div");

      const label = document.createElement("div");
      label.className = "study-related-chip-title";
      label.textContent = suggestion.label || `${getPageUnitLabel()} ${suggestion.pageNumber}`;
      titleWrap.appendChild(label);

      if (suggestion.heading) {
        const subtitle = document.createElement("div");
        subtitle.className = "study-related-chip-subtitle";
        subtitle.textContent = suggestion.heading;
        titleWrap.appendChild(subtitle);
      }

      head.appendChild(titleWrap);
      chip.appendChild(head);

      const reason = document.createElement("div");
      reason.className = "study-related-chip-reason";
      reason.textContent = suggestion.reason || t("study.relatedReasonFallback", {}, "Related topic continuation");
      chip.appendChild(reason);

      const actions = document.createElement("div");
      actions.className = "study-related-actions";

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.textContent = t("study.addAction", {}, "Add");
      addButton.title = t(
        "study.addSuggestion",
        { page: suggestion.pageNumber },
        `Add ${suggestion.label || `${getPageUnitLabel()} ${suggestion.pageNumber}`}`
      );
      addButton.addEventListener("click", () => {
        const merged = Array.from(new Set([
          ...getEffectivePageSequence(),
          Number(suggestion.pageNumber),
        ])).sort((left, right) => left - right);
        if (studyPageScopeMode) studyPageScopeMode.value = "custom-pages";
        if (studyPageSelectionInput) {
          studyPageSelectionInput.value = merged.join(", ");
        }
        applyPageSelection({ preserveCurrent: true }).catch((error) => toast(error.message, "error"));
        toast(
          t(
            "study.suggestionAdded",
            { label: suggestion.label || `${getPageUnitLabel()} ${suggestion.pageNumber}` },
            `${suggestion.label || `${getPageUnitLabel()} ${suggestion.pageNumber}`} added to the selection.`
          ),
          "success"
        );
      });
      actions.appendChild(addButton);

      const dismissButton = document.createElement("button");
      dismissButton.type = "button";
      dismissButton.className = "secondary";
      dismissButton.textContent = t("study.hideAction", {}, "Hide");
      dismissButton.title = t(
        "study.dismissSuggestion",
        { page: suggestion.pageNumber },
        `Hide ${suggestion.label || `${getPageUnitLabel()} ${suggestion.pageNumber}`}`
      );
      dismissButton.addEventListener("click", () => {
        relatedPageSuggestions = relatedPageSuggestions.filter((item) => Number(item.pageNumber) !== Number(suggestion.pageNumber));
        renderRelatedSuggestions();
      });
      actions.appendChild(dismissButton);
      chip.appendChild(actions);
      studyRelatedPages.appendChild(chip);
    });

    if (pendingSuggestions.length > 6) {
      const more = document.createElement("span");
      more.className = "study-custom-hint";
      more.textContent = t("study.extraPages", { count: pendingSuggestions.length - 6 }, `+${pendingSuggestions.length - 6} more`);
      studyRelatedPages.appendChild(more);
    }
    renderStudySourcePack();
    renderVisiblePageChips();
  }

  function setStudyToolBusy(button, isBusy, busyLabel) {
    if (!button) return;
    button.disabled = isBusy;
    button.textContent = isBusy ? busyLabel : (button.dataset.baseLabel || button.textContent);
  }

  async function recordStudyProgress(payload = {}) {
    const sessionId = window.currentSessionId;
    if (!sessionId) return;
    try {
      await fetch("/api/progress/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, type: "study", payload }),
      });
      if (window.progressModule) window.progressModule.refresh();
    } catch (error) {
      console.error("Study progress record error:", error);
    }
  }

  function parsePageSelection(value) {
    if (!pdfDoc || totalPages <= 0) return [];
    const raw = String(value || "").trim();
    if (!raw) return [];

    const selected = new Set();
    raw.split(",").map((part) => part.trim()).filter(Boolean).forEach((part) => {
      const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        let start = Number(rangeMatch[1]);
        let end = Number(rangeMatch[2]);
        if (start > end) [start, end] = [end, start];
        for (let page = start; page <= end; page += 1) {
          if (page >= 1 && page <= totalPages) selected.add(page);
        }
        return;
      }

      const page = Number(part);
      if (Number.isFinite(page) && page >= 1 && page <= totalPages) {
        selected.add(page);
      }
    });

    return Array.from(selected).sort((left, right) => left - right);
  }

  function buildSelectionFromMode() {
    if (currentSourceMode !== "pdf" || !pdfDoc) return [];

    switch (studyPageScopeMode?.value) {
      case "current-page":
        return currentPage ? [currentPage] : [1];
      case "nearby-3": {
        const pages = [];
        for (let page = currentPage - 1; page <= currentPage + 1; page += 1) {
          if (page >= 1 && page <= totalPages) pages.push(page);
        }
        return pages;
      }
      case "nearby-5": {
        const pages = [];
        for (let page = currentPage - 2; page <= currentPage + 2; page += 1) {
          if (page >= 1 && page <= totalPages) pages.push(page);
        }
        return pages;
      }
      case "custom-pages":
        return parsePageSelection(studyPageSelectionInput?.value || "");
      case "all-pages":
      default:
        return [];
    }
  }

  function updateZoomBadge() {
    if (studyZoomLevel) {
      studyZoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    }
  }

  function updateNavButtons() {
    const isPdf = currentSourceMode === "pdf" && pdfDoc;
    const pageSequence = getEffectivePageSequence();
    const currentIndex = pageSequence.indexOf(currentPage);
    if (pdfPrevBtn) pdfPrevBtn.disabled = !isPdf || currentIndex <= 0;
    if (pdfNextBtn) pdfNextBtn.disabled = !isPdf || currentIndex === -1 || currentIndex >= pageSequence.length - 1;
    if (studyZoomOutBtn) studyZoomOutBtn.disabled = !isPdf;
    if (studyZoomInBtn) studyZoomInBtn.disabled = !isPdf;
    if (studyZoomResetBtn) studyZoomResetBtn.disabled = !isPdf;
    if (studyApplyPageSelectionBtn) studyApplyPageSelectionBtn.disabled = !isPdf;
    if (studySuggestPagesBtn) studySuggestPagesBtn.disabled = !isPdf || !getCurrentSource()?.documentId;
    updatePageSelectionInputState();
    updateSelectionInfo();
  }

  function setNoDocVisible(visible) {
    if (studyNoPdf) studyNoPdf.style.display = visible ? "flex" : "none";
    if (pdfViewer) pdfViewer.style.display = visible ? "none" : "flex";
  }

  function setViewerMode(mode) {
    if (!studyPageStack || !studyDocTextPreview) return;
    const isText = mode === "text";
    studyPageStack.style.display = isText ? "none" : "flex";
    studyDocTextPreview.style.display = isText ? "block" : "none";
  }

  function setStudyButtonsBusy(isBusy, activeButton = null) {
    actionButtons.forEach((button) => {
      button.disabled = isBusy;
      if (!isBusy) {
        button.textContent = button.dataset.baseLabel || button.textContent;
      }
    });

    if (isBusy && activeButton) {
      activeButton.textContent = "Thinking...";
    }
  }

  function normalizeSourceName(name) {
    return String(name || "Study source").trim() || "Study source";
  }

  function inferSourceTypeLabel(name = "", kind = "") {
    if (kind === "pdf") return "PDF";
    if (PPT_EXT_RE.test(name)) return "PPT";
    if (DOC_EXT_RE.test(name)) return "DOC";
    if (IMAGE_EXT_RE.test(name)) return "IMG";
    if (/\.txt$/i.test(name)) return "TXT";
    if (/\.md$/i.test(name)) return "MD";
    return "DOC";
  }

  function buildSourceKey(kind, meta = {}) {
    return meta.documentId || `${kind}:${normalizeSourceName(meta.fileName || meta.name)}:${Date.now()}`;
  }

  function getSourceBadge(source) {
    return `[${source.typeLabel || inferSourceTypeLabel(source.name, source.kind)}]`;
  }

  function refreshDocumentSelect() {
    if (!studyDocumentSelect) return;

    studyDocumentSelect.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = sourceStore.size ? "Select study source" : "Current study file";
    studyDocumentSelect.appendChild(empty);

    Array.from(sourceStore.values()).forEach((source) => {
      const option = document.createElement("option");
      option.value = source.key;
      option.textContent = `${getSourceBadge(source)} ${source.name}`;
      studyDocumentSelect.appendChild(option);
    });

    if (currentSourceKey && sourceStore.has(currentSourceKey)) {
      studyDocumentSelect.value = currentSourceKey;
    }
    updateSelectionInfo();
    renderStudySourcePack();
  }

  function registerSource(source, options = {}) {
    const normalized = {
      key: source.key || buildSourceKey(source.kind || "text", source),
      name: normalizeSourceName(source.name),
      kind: source.kind || "text",
      typeLabel: source.typeLabel || inferSourceTypeLabel(source.name, source.kind),
      file: source.file || null,
      url: typeof source.url === "string" ? source.url : "",
      text: typeof source.text === "string" ? source.text : "",
      documentId: source.documentId || "",
      lastPage: source.lastPage || 1,
      lastScale: source.lastScale || BASE_SCALE,
    };

    sourceStore.set(normalized.key, normalized);
    refreshDocumentSelect();

    if (options.autoOpen) {
      openSourceByKey(normalized.key);
    }

    return normalized.key;
  }

  function registerUploadedPdf(file, meta = {}) {
    return registerSource({
      key: buildSourceKey("pdf", meta),
      name: meta.fileName || file.name,
      kind: "pdf",
      typeLabel: "PDF",
      file,
      documentId: meta.documentId || "",
      lastPage: 1,
      lastScale: BASE_SCALE,
    }, { autoOpen: meta.autoOpen !== false });
  }

  async function waitForPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (window.pdfjsLib) return window.pdfjsLib;
    }

    throw new Error("PDF.js yuklenemedi.");
  }

  async function extractPdfPageText(pageNumber) {
    if (!pdfDoc || !currentSourceKey) return "";
    const cacheKey = `${currentSourceKey}:${pageNumber}`;
    if (pageTextCache.has(cacheKey)) return pageTextCache.get(cacheKey);

    const page = await pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = (textContent.items || [])
      .map((item) => (item && typeof item.str === "string" ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const limited = text.slice(0, PAGE_TEXT_LIMIT);
    pageTextCache.set(cacheKey, limited);
    return limited;
  }

  async function getCurrentSourceText() {
    if (currentSourceMode === "text") {
      return currentTextSource.slice(0, PAGE_TEXT_LIMIT);
    }
    if (currentSourceMode === "pdf" && pdfDoc && currentPage >= 1) {
      return extractPdfPageText(currentPage);
    }
    return "";
  }

  async function getDocumentIndexedText(documentId) {
    if (!documentId) return "";
    if (documentTextCache.has(documentId)) return documentTextCache.get(documentId);

    const sessionId = window.currentSessionId;
    if (!sessionId) return "";

    const res = await fetch(`/api/session/${sessionId}/document/${documentId}/text`);
    const data = await res.json();
    const apiError = typeof window.getApiError === "function" ? window.getApiError(data) : null;
    if (!res.ok || apiError) {
      throw new Error(apiError?.message || "Dokuman metni alinamadi.");
    }

    const text = String(data.text || "").trim();
    documentTextCache.set(documentId, text);
    return text;
  }

  function truncateSourceText(text, limit = SOURCE_TEXT_LIMIT) {
    return String(text || "").slice(0, limit).trim();
  }

  async function getSelectedScopeText() {
    if (currentSourceMode === "text") {
      const source = sourceStore.get(currentSourceKey);
      const title = source?.name || "Current text source";
      return {
        text: `[${title}]\n${truncateSourceText(currentTextSource)}`,
        label: title,
      };
    }

    if (currentSourceMode !== "pdf" || !pdfDoc) {
      return { text: "", label: "Current source" };
    }

    const source = sourceStore.get(currentSourceKey);
    const pageSequence = getEffectivePageSequence();
    const pages = pageSequence.length ? pageSequence : [currentPage || 1];
    const chunks = [];

    for (const pageNumber of pages) {
      const pageText = await extractPdfPageText(pageNumber);
      if (!pageText) continue;
      chunks.push(`[${source?.name || "PDF"} - Page ${pageNumber}]\n${pageText}`);
      if (chunks.join("\n\n").length >= SOURCE_TEXT_LIMIT) break;
    }

    return {
      text: truncateSourceText(chunks.join("\n\n")),
      label: `${source?.name || "PDF"} | ${formatSelectedPages(pages)}`,
    };
  }

  async function applyPageSelection(options = {}) {
    const { preserveCurrent = true } = options;
    if (currentSourceMode !== "pdf" || !pdfDoc) {
      selectedPageSequence = [];
      updateNavButtons();
      return;
    }

    const nextSelection = buildSelectionFromMode();
    if (studyPageScopeMode?.value === "custom-pages" && !nextSelection.length) {
      toast("Gecerli bir sayfa/slayt listesi girin. Ornek: 4-6, 8, 10-12", "error");
      return;
    }

    selectedPageSequence = nextSelection;
    const pageSequence = getEffectivePageSequence();
    if (!pageSequence.length) {
      updateNavButtons();
      return;
    }

    const targetPage = preserveCurrent && pageSequence.includes(currentPage)
      ? currentPage
      : pageSequence[0];

    await renderPage(targetPage);
  }

  async function clearPageScope() {
    if (currentSourceMode !== "pdf" || !pdfDoc) return;
    if (studyPageScopeMode) studyPageScopeMode.value = "all-pages";
    if (studyPageSelectionInput) studyPageSelectionInput.value = "";
    await applyPageSelection({ preserveCurrent: true });
  }

  async function removePageFromSelection(pageNumber) {
    if (currentSourceMode !== "pdf" || !pdfDoc) return;

    const currentPages = getEffectivePageSequence();
    const nextPages = currentPages.filter((page) => page !== Number(pageNumber));

    if (!nextPages.length || nextPages.length >= totalPages) {
      await clearPageScope();
      return;
    }

    if (studyPageScopeMode) studyPageScopeMode.value = "custom-pages";
    if (studyPageSelectionInput) studyPageSelectionInput.value = nextPages.join(", ");
    await applyPageSelection({ preserveCurrent: Number(pageNumber) !== Number(currentPage) });
    toast(
      t(
        "study.pageRemoved",
        { page: pageNumber },
        `${getPageUnitLabel()} ${pageNumber} removed from the current selection.`
      ),
      "success"
    );
  }

  async function acceptAllSuggestedPages() {
    if (currentSourceMode !== "pdf" || !pdfDoc) return;

    const currentPages = getEffectivePageSequence();
    const currentSet = new Set(currentPages);
    const addablePages = relatedPageSuggestions
      .map((item) => Number(item.pageNumber))
      .filter((pageNumber) => Number.isFinite(pageNumber) && !currentSet.has(pageNumber));

    if (!addablePages.length) {
      toast(t("study.noRelatedSuggestions", {}, "No related-page suggestions yet."), "error");
      return;
    }

    const merged = Array.from(new Set([...currentPages, ...addablePages])).sort((left, right) => left - right);
    if (studyPageScopeMode) studyPageScopeMode.value = merged.length >= totalPages ? "all-pages" : "custom-pages";
    if (studyPageSelectionInput) studyPageSelectionInput.value = merged.length >= totalPages ? "" : merged.join(", ");
    await applyPageSelection({ preserveCurrent: true });
    toast(
      t("study.suggestionsAdded", { count: addablePages.length }, `${addablePages.length} related pages added.`),
      "success"
    );
  }

  async function syncTextViews() {
    const currentText = await getCurrentSourceText();
    const scope = await getSelectedScopeText();
    const drawerText = currentSourceMode === "pdf" ? (scope.text || currentText) : currentText;
    if (studyPageText) studyPageText.value = drawerText;

    if (currentSourceMode === "text") {
      if (studyDocTextPreview) studyDocTextPreview.textContent = currentTextSource || currentText;
    } else if (studyDocTextPreview) {
      studyDocTextPreview.textContent = "";
    }
  }

  function clearCanvas() {
    if (studyPageStack) studyPageStack.innerHTML = "";
    if (!pdfCanvas) return;
    const ctx = pdfCanvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
    pdfCanvas.width = 0;
    pdfCanvas.height = 0;
  }

  function clearStudyState(resetMessages = false) {
    pdfDoc = null;
    currentPage = 0;
    totalPages = 0;
    currentScale = BASE_SCALE;
    currentSourceMode = "";
    currentSourceKey = "";
    currentTextSource = "";
    selectedPageSequence = [];
    pageTextCache.clear();
    clearCanvas();
    setNoDocVisible(true);
    setViewerMode("pdf");
    if (studyTextDrawer) studyTextDrawer.classList.remove("visible");
    if (studyPageText) studyPageText.value = "";
    if (studyDocTextPreview) studyDocTextPreview.textContent = "";
    updatePageCounters();
    updateZoomBadge();
    updateNavButtons();
    if (studyPageScopeMode) studyPageScopeMode.value = "all-pages";
    if (studyPageSelectionInput) studyPageSelectionInput.value = "";
    if (studyDocumentSelect) studyDocumentSelect.value = "";
    relatedPageSuggestions = [];
    renderRelatedSuggestions();
    hideInsightPanel();
    stopStudySpeech();
    if (resetMessages) resetStudyMessages();
    renderStudySourcePack();
    updateScopeQuickChips();
  }

  async function renderPage(pageNumber) {
    if (!pdfDoc || !studyPageStack) return;

    currentPage = Math.min(Math.max(pageNumber, 1), totalPages);
    const renderToken = ++renderVersion;
    const pixelRatio = window.devicePixelRatio || 1;
    const source = sourceStore.get(currentSourceKey);
    const pageUnitLabel = getPageUnitLabel();
    const visiblePages = getRenderedPageSequence(currentPage);

    studyPageStack.innerHTML = "";

    for (const visiblePage of visiblePages) {
      const card = document.createElement("article");
      card.className = "study-page-card";
      card.dataset.pageNumber = String(visiblePage);
      if (visiblePage === currentPage) card.classList.add("active");

      const header = document.createElement("div");
      header.className = "study-page-card-header";

      const label = document.createElement("span");
      label.className = "study-page-card-label";
      label.textContent = `${pageUnitLabel} ${visiblePage}`;

      const meta = document.createElement("span");
      meta.className = "study-page-card-meta";
      meta.textContent = visiblePage === currentPage ? "Aktif odak sayfasi" : "Secime dahil";

      header.appendChild(label);
      header.appendChild(meta);
      card.appendChild(header);

      const canvas = document.createElement("canvas");
      card.appendChild(canvas);
      studyPageStack.appendChild(card);

      const page = await pdfDoc.getPage(visiblePage);
      if (renderToken !== renderVersion) return;

      const viewport = page.getViewport({ scale: currentScale });
      const canvasContext = canvas.getContext("2d");

      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const renderTask = page.render({
        canvasContext,
        viewport,
        transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null,
      });

      try {
        await renderTask.promise;
      } catch (error) {
        if (error?.name !== "RenderingCancelledException") throw error;
        return;
      }

      card.addEventListener("click", () => {
        if (visiblePage === currentPage) return;
        renderPage(visiblePage).catch((error) => toast(error.message || "Sayfa acilamadi.", "error"));
      });
    }

    if (source) {
      source.lastPage = currentPage;
      source.lastScale = currentScale;
    }

    updatePageCounters();
    updateZoomBadge();
    updateNavButtons();
    await syncTextViews();
    renderStudySourcePack();
    updateScopeQuickChips();

    const activeCard = studyPageStack.querySelector(`.study-page-card[data-page-number="${currentPage}"]`);
    activeCard?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  async function openPdfSource(source) {
    const pdfjsLib = await waitForPdfJs();
    const loadingTask = source.file
      ? pdfjsLib.getDocument({ data: await source.file.arrayBuffer() })
      : pdfjsLib.getDocument(source.url);
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages || 1;
    currentSourceMode = "pdf";
    currentTextSource = "";
    currentScale = source.lastScale || BASE_SCALE;
    currentPage = Math.min(source.lastPage || 1, totalPages);
    relatedPageSuggestions = [];
    renderRelatedSuggestions();
    hideInsightPanel();
    if (studyPageScopeMode && !studyPageScopeMode.value) {
      studyPageScopeMode.value = "all-pages";
    }
    setNoDocVisible(false);
    setViewerMode("pdf");
    await applyPageSelection({ preserveCurrent: true });
    renderStudySourcePack();
    updateScopeQuickChips();
  }

  async function openTextSource(source) {
    pdfDoc = null;
    totalPages = 1;
    currentPage = 1;
    currentSourceMode = "text";
    currentScale = BASE_SCALE;
    currentTextSource = source.text || "";
    selectedPageSequence = [];
    relatedPageSuggestions = [];
    renderRelatedSuggestions();
    hideInsightPanel();
    setNoDocVisible(false);
    setViewerMode("text");
    updatePageCounters();
    updateZoomBadge();
    updateNavButtons();
    await syncTextViews();
    renderStudySourcePack();
    updateScopeQuickChips();
  }

  async function openSourceByKey(sourceKey) {
    const source = sourceStore.get(sourceKey);
    if (!source) return false;

    currentSourceKey = source.key;
    if (studyDocumentSelect) studyDocumentSelect.value = source.key;

    try {
      if (source.kind === "pdf" && (source.file || source.url)) {
        await openPdfSource(source);
      } else {
        await openTextSource(source);
      }
      return true;
    } catch (error) {
      console.error("Study source open error:", error);
      toast(`${t("study.openFailed", {}, "Study source could not be opened")}: ${error.message}`, "error");
      return false;
    }
  }

  async function loadIndexedTextDocument(documentId, preferredName = "") {
    const cached = Array.from(sourceStore.values()).find((source) => source.documentId === documentId && source.kind === "text");
    if (cached) {
      await openSourceByKey(cached.key);
      return true;
    }

    const sessionId = window.currentSessionId;
    if (!sessionId || !documentId) {
      toast(t("study.missingSessionDocument", {}, "Active session or document was not found."), "error");
      return false;
    }

    const res = await fetch(`/api/session/${sessionId}/document/${documentId}/text`);
    const data = await res.json();
    const apiError = typeof window.getApiError === "function" ? window.getApiError(data) : null;
    if (!res.ok || apiError) {
      throw new Error(apiError?.message || t("study.documentTextMissing", {}, "Document text could not be loaded."));
    }

    const text = String(data.text || "").trim();
    if (!text) {
      throw new Error(data.hint || t("study.documentReadableMissing", {}, "Readable text could not be extracted from this document."));
    }

    const key = registerSource({
      key: documentId,
      name: preferredName || data.name || "Document",
      kind: "text",
      typeLabel: inferSourceTypeLabel(preferredName || data.name || "", "text"),
      text,
      documentId,
      lastPage: 1,
      lastScale: BASE_SCALE,
    }, { autoOpen: false });

    return openSourceByKey(key);
  }

  async function loadPreviewPdfDocument(documentId, preferredName = "") {
    const cached = Array.from(sourceStore.values()).find((source) => source.documentId === documentId && source.kind === "pdf" && source.url);
    if (cached) {
      await openSourceByKey(cached.key);
      return true;
    }

    const sessionId = window.currentSessionId;
    if (!sessionId || !documentId) {
      toast(t("study.previewMissing", {}, "Active session or preview document was not found."), "error");
      return false;
    }

    const key = registerSource({
      key: `preview:${documentId}`,
      name: preferredName || "PowerPoint Preview",
      kind: "pdf",
      typeLabel: inferSourceTypeLabel(preferredName || "preview.pptx", "pdf"),
      url: `/api/session/${sessionId}/document/${documentId}/preview`,
      documentId,
      lastPage: 1,
      lastScale: BASE_SCALE,
    }, { autoOpen: false });

    return openSourceByKey(key);
  }

  async function loadTextSource(name, text, meta = {}) {
    const key = registerSource({
      key: buildSourceKey("text", meta),
      name,
      kind: "text",
      typeLabel: meta.typeLabel || inferSourceTypeLabel(name, "text"),
      text,
      documentId: meta.documentId || "",
      lastPage: 1,
      lastScale: BASE_SCALE,
    }, { autoOpen: meta.autoOpen !== false });

    return key;
  }

  async function loadPDF(file, meta = {}) {
    registerUploadedPdf(file, {
      fileName: meta.fileName || file.name,
      documentId: meta.documentId || "",
      autoOpen: meta.autoOpen !== false,
    });
    return true;
  }

  async function copyCurrentText() {
    const scope = await getSelectedScopeText();
    const text = scope.text || await getCurrentSourceText();
    if (!text) {
      toast(t("study.copyMissing", {}, "There is no text to copy."), "error");
      return;
    }

    await navigator.clipboard.writeText(text);
    toast(t("study.copyDone", {}, "Text copied to clipboard."), "success");
  }

  function toggleTextDrawer() {
    if (!studyTextDrawer) return;
    studyTextDrawer.classList.toggle("visible");
  }

  async function zoomTo(nextScale) {
    if (currentSourceMode !== "pdf" || !pdfDoc) {
      toast(t("study.zoomOnlyPdf", {}, "Zoom is supported only for PDF or preview viewing."), "error");
      return;
    }

    currentScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    await renderPage(currentPage || 1);
  }

  function appendStudyMessage(role, content) {
    if (!studyChatMessages) return;

    const message = document.createElement("div");
    message.className = `study-msg study-msg-${role}`;
    if (role === "ai" || role === "system") {
      message.classList.add("md-content");
      if (typeof window.renderMarkdown === "function") {
        message.innerHTML = window.renderMarkdown(content);
      } else {
        message.textContent = content;
        message.style.whiteSpace = "pre-wrap";
      }
    } else {
      message.textContent = content;
      message.style.whiteSpace = "pre-wrap";
    }
    studyChatMessages.appendChild(message);
    studyChatMessages.scrollTop = studyChatMessages.scrollHeight;
  }

  function getStudyRequestLabel(mode, customPrompt, scopeLabel = "") {
    const activeScope = scopeLabel || (currentSourceMode === "pdf" ? `Page ${currentPage || 1}` : "Current source");
    if (customPrompt) return `You: ${activeScope}: ${customPrompt}`;

    const labelMap = {
      explain: "explain",
      summarize: "summarize",
      keypoints: "list key points",
      feynman: "explain with the Feynman technique",
    };

    return `You: ${activeScope}: ${labelMap[mode] || "analyze"}`;
  }

  async function explainCurrentPage(mode = "explain", customPrompt = "") {
    if (!currentSourceKey) {
      toast("Once bir PDF veya PowerPoint secin.", "error");
      return;
    }

    if (activeExplainController || activeStudyToolController) {
      toast("Mevcut analiz tamamlanmadan yeni istek baslatilamaz.", "error");
      return;
    }

    const scope = await getSelectedScopeText();
    const sourceText = scope.text;
    if (!sourceText.trim()) {
      toast("Aciklanacak metin bulunamadi.", "error");
      return;
    }

    const activeButton = customPrompt
      ? studyAskBtn
      : (mode === "summarize"
        ? studySummarizeBtn
        : mode === "keypoints"
          ? studyKeyBtn
          : mode === "feynman"
            ? studyFeynmanBtn
            : studyExplainBtn);

    appendStudyMessage("user", getStudyRequestLabel(mode, customPrompt, scope.label));
    setStudyButtonsBusy(true, activeButton);
    hideInsightPanel();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    activeExplainController = controller;

    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          text: sourceText,
          mode: customPrompt ? "explain" : mode,
          question: customPrompt,
          pageNumber: currentSourceMode === "pdf" ? currentPage : 1,
          totalPages: currentSourceMode === "pdf" ? totalPages : 1,
          scopeLabel: scope.label,
          teachingMode: typeof window.getSelectedStudyMode === "function"
            ? window.getSelectedStudyMode()
            : "deep",
          language: getActiveStudyLanguage(),
          preset: getCurrentPreset(),
          citationMode: "inline",
          contextPack: getCurrentContextPack(),
        }),
      });
      const data = await readJsonResponse(res, "Analiz istegi basarisiz oldu.");
      appendStudyMessage("ai", data.response || "Yanit alinamadi.");
      recordStudyProgress({
        type: mode || "study",
        seconds: mode === "feynman" ? 120 : mode === "summarize" ? 45 : 75,
        documentId: getCurrentSource()?.documentId || "",
        topic: scope.label || customPrompt || mode,
      });
    } catch (error) {
      const message = error.name === "AbortError"
        ? "Study analizi zaman asimina ugradi. Daha kisa bir sayfa veya daha hizli model deneyin."
        : `Connection error: ${error.message}`;
      appendStudyMessage("system", message);
      toast(message, "error");
    } finally {
      clearTimeout(timeoutId);
      activeExplainController = null;
      setStudyButtonsBusy(false);
    }
  }

  async function handleStudyFile(file) {
    if (!file) return;

    const fileName = file.name || "document";
    const isPdf = file.type === "application/pdf" || PDF_EXT_RE.test(fileName);
    const isPpt = PPT_EXT_RE.test(fileName);
    const isDoc = DOC_EXT_RE.test(fileName);
    const isImage = file.type.startsWith("image/") || IMAGE_EXT_RE.test(fileName);

    if (!isPdf && !isPpt && !isDoc && !isImage) {
      toast("Study sekmesinde DOCX, PDF, PowerPoint ve gorsel dosyalari destekleniyor.", "error");
      return;
    }

    if (typeof window.uploadDocumentFromUI !== "function") {
      toast("Upload modulu hazir degil.", "error");
      return;
    }

    try {
      const result = await window.uploadDocumentFromUI(file);

      if (isPdf) {
        return;
      }

      if (isPpt && result?.preview?.available) {
        if (typeof window.switchTab === "function") window.switchTab("study");
        toast("PowerPoint slide preview Study sekmesinde acildi.", "success");
        return;
      }

      if (result?.documentId && result?.indexed) {
        await loadIndexedTextDocument(result.documentId, result.fileName || fileName);
        if (typeof window.switchTab === "function") window.switchTab("study");
        toast(
          isPpt
            ? "PowerPoint Study sekmesinde kaynak metin olarak acildi."
            : isDoc
              ? "Word dokumani Study sekmesinde kaynak metin olarak acildi."
            : "Gorsel Study sekmesinde kaynak metin olarak acildi.",
          "success"
        );
        return;
      }

      throw new Error(result?.hint || result?.reason || "Kaynak dosya Study icin hazirlanamadi.");
    } catch (error) {
      if (isPdf) {
        await loadPDF(file, { fileName, autoOpen: true });
        toast("PDF onizlemesi acildi, fakat sunucuya yukleme/indexleme tamamlanamadi.", "error");
        return;
      }

      toast(error.message || "Kaynak dosya yuklenemedi.", "error");
    }
  }

  function bindPaneResizer() {
    if (!studyPaneResizer || !studyAiPane) return;

    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (event) => {
      const delta = startX - event.clientX;
      const nextWidth = Math.min(1100, Math.max(460, startWidth + delta));
      studyAiPane.style.width = `${nextWidth}px`;
    };

    const stopDrag = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", stopDrag);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(STUDY_PANE_WIDTH_KEY, String(Math.round(studyAiPane.getBoundingClientRect().width)));
      } catch {}
    };

    studyPaneResizer.addEventListener("mousedown", (event) => {
      event.preventDefault();
      startX = event.clientX;
      startWidth = studyAiPane.getBoundingClientRect().width;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", stopDrag);
    });

    studyPaneResizer.addEventListener("dblclick", () => {
      studyAiPane.style.width = "680px";
      try {
        localStorage.setItem(STUDY_PANE_WIDTH_KEY, "680");
      } catch {}
    });
  }

  function resetStudySources() {
    sourceStore.clear();
    clearStudyState(true);
    refreshDocumentSelect();
  }

  function removeStudySourceByDocumentId(documentId) {
    if (!documentId) return;

    let removedActive = false;
    Array.from(sourceStore.entries()).forEach(([key, source]) => {
      if (source.documentId === documentId || key === documentId) {
        if (currentSourceKey === key) removedActive = true;
        sourceStore.delete(key);
      }
    });

    refreshDocumentSelect();

    if (removedActive) {
      const nextSource = sourceStore.values().next().value;
      if (nextSource) {
        openSourceByKey(nextSource.key);
      } else {
        clearStudyState(false);
      }
    }
  }

  async function suggestRelatedPages() {
    const source = getCurrentSource();
    if (currentSourceMode !== "pdf" || !pdfDoc || !source?.documentId) {
      toast(t("study.relatedNeedsPreview", {}, "An open PDF or PPT preview source is required for related-page suggestions."), "error");
      return;
    }

    if (activeStudyToolController || activeExplainController) {
      toast(t("study.toolBusy", {}, "Another study tool is already running. Wait for it to finish."), "error");
      return;
    }

    setStudyToolBusy(studySuggestPagesBtn, true, "Thinking...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    activeStudyToolController = controller;

    try {
      const res = await fetch("/api/context/suggest-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: window.currentSessionId,
          documentId: source.documentId,
          selectedPages: getEffectivePageSequence(),
          limit: 6,
        }),
      });

      const data = await readJsonResponse(res, "Baglantili sayfa onerisi alinamadi.");
      relatedPageSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      renderRelatedSuggestions();
      toast(
        relatedPageSuggestions.length
          ? t("study.relatedFound", {}, "Related pages were found.")
          : t("study.relatedNotFound", {}, "No extra related-page suggestion was found."),
        "success"
      );
    } catch (error) {
      const message = error.name === "AbortError"
        ? t("study.relatedTimeout", {}, "Related-page suggestion timed out.")
        : error.message || t("study.relatedFailed", {}, "Related-page suggestion could not be loaded.");
      toast(message, "error");
    } finally {
      clearTimeout(timeoutId);
      activeStudyToolController = null;
      setStudyToolBusy(studySuggestPagesBtn, false);
    }
  }

  async function createAudioOverview() {
    const source = getCurrentSource();
    if (!source?.documentId) {
      toast(t("study.audioNeedsSource", {}, "Select an indexed source for audio overview."), "error");
      return;
    }

    if (activeStudyToolController || activeExplainController) {
      toast(t("study.toolBusy", {}, "Another study tool is already running. Wait for it to finish."), "error");
      return;
    }

    hideInsightPanel();
    setStudyToolBusy(studyAudioBtn, true, "Thinking...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    activeStudyToolController = controller;

    try {
      const scope = await getSelectedScopeText();
      const res = await fetch("/api/audio-overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: window.currentSessionId,
          documentId: source.documentId,
          language: getActiveStudyLanguage(),
          preset: getCurrentPreset(),
          teachingMode: typeof window.getSelectedStudyMode === "function"
            ? window.getSelectedStudyMode()
            : "deep",
          topic: (studyCustomPrompt?.value || "").trim(),
          contextPack: getCurrentContextPack(),
        }),
      });

      const data = await readJsonResponse(res, "Audio overview olusturulamadi.");
      const transcript = (data.lines || [])
        .map((line) => {
          const renderedText = typeof window.renderMarkdown === "function"
            ? window.renderMarkdown(line.text || "")
            : `<p>${escapeHtml(line.text || "")}</p>`;
          return `<div class="study-audio-line"><strong>${escapeHtml(line.speaker || "Host")}:</strong>${renderedText}</div>`;
        })
        .join("");
      const html = `
        <div class="study-related-actions" style="margin-bottom:10px">
          <button type="button" id="studyPlayAudioOverview">Play</button>
          <button type="button" id="studyStopAudioOverview">Stop</button>
        </div>
        ${transcript}
      `;
      await showInsightPanel(data.title || "Audio Overview", html);
      document.getElementById("studyPlayAudioOverview")?.addEventListener("click", () => {
        playStudySpeech(data.lines || [], getActiveStudyLanguage());
      });
      document.getElementById("studyStopAudioOverview")?.addEventListener("click", () => {
        stopStudySpeech();
      });
      playStudySpeech(data.lines || [], getActiveStudyLanguage());
      recordStudyProgress({
        type: "audio-overview",
        seconds: 120,
        documentId: source.documentId,
        topic: scope.label || data.title || "Audio Overview",
      });
    } catch (error) {
      const message = error.name === "AbortError"
        ? t("study.audioTimeout", {}, "Audio overview timed out.")
        : error.message || t("study.audioFailed", {}, "Audio overview could not be generated.");
      toast(message, "error");
    } finally {
      clearTimeout(timeoutId);
      activeStudyToolController = null;
      setStudyToolBusy(studyAudioBtn, false);
    }
  }

  async function createMindMap() {
    const source = getCurrentSource();
    if (!source?.documentId) {
      toast(t("study.mindMapNeedsSource", {}, "Select an indexed source for mind map."), "error");
      return;
    }

    if (activeStudyToolController || activeExplainController) {
      toast(t("study.toolBusy", {}, "Another study tool is already running. Wait for it to finish."), "error");
      return;
    }

    hideInsightPanel();
    setStudyToolBusy(studyMindMapBtn, true, "Thinking...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    activeStudyToolController = controller;

    try {
      const scope = await getSelectedScopeText();
      const res = await fetch("/api/mind-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: window.currentSessionId,
          documentId: source.documentId,
          language: getActiveStudyLanguage(),
          preset: getCurrentPreset(),
          teachingMode: typeof window.getSelectedStudyMode === "function"
            ? window.getSelectedStudyMode()
            : "deep",
          topic: (studyCustomPrompt?.value || "").trim(),
          contextPack: getCurrentContextPack(),
        }),
      });

      const data = await readJsonResponse(res, "Mind map olusturulamadi.");
      const safeMermaid = String(data.mermaid || "");
      const fallback = `<pre><code>${safeMermaid.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`;
      await showInsightPanel(data.title || "Mind Map", safeMermaid ? '<div class="mermaid"></div>' : fallback, { mermaid: safeMermaid });
      recordStudyProgress({
        type: "mind-map",
        seconds: 90,
        documentId: source.documentId,
        topic: scope.label || data.title || "Mind Map",
      });
    } catch (error) {
      const message = error.name === "AbortError"
        ? t("study.mindMapTimeout", {}, "Mind map generation timed out.")
        : error.message || t("study.mindMapFailed", {}, "Mind map could not be generated.");
      toast(message, "error");
    } finally {
      clearTimeout(timeoutId);
      activeStudyToolController = null;
      setStudyToolBusy(studyMindMapBtn, false);
    }
  }

  pdfPrevBtn?.addEventListener("click", async () => {
    if (currentSourceMode !== "pdf" || !pdfDoc) return;
    const pageSequence = getEffectivePageSequence();
    const currentIndex = pageSequence.indexOf(currentPage);
    if (currentIndex <= 0) return;
    await renderPage(pageSequence[currentIndex - 1]);
  });

  pdfNextBtn?.addEventListener("click", async () => {
    if (currentSourceMode !== "pdf" || !pdfDoc) return;
    const pageSequence = getEffectivePageSequence();
    const currentIndex = pageSequence.indexOf(currentPage);
    if (currentIndex === -1 || currentIndex >= pageSequence.length - 1) return;
    await renderPage(pageSequence[currentIndex + 1]);
  });

  studyDocumentSelect?.addEventListener("change", async (event) => {
    const sourceKey = event.target.value;
    if (!sourceKey) return;
    try {
      await openSourceByKey(sourceKey);
    } catch (error) {
      toast(error.message || t("study.sourceOpenFailed", {}, "Source could not be opened."), "error");
    }
  });

  studyZoomOutBtn?.addEventListener("click", () => zoomTo(currentScale - 0.15));
  studyZoomInBtn?.addEventListener("click", () => zoomTo(currentScale + 0.15));
  studyZoomResetBtn?.addEventListener("click", () => zoomTo(BASE_SCALE));
  studyToggleTextBtn?.addEventListener("click", () => toggleTextDrawer());
  studyCopyTextBtn?.addEventListener("click", () => copyCurrentText().catch((error) => toast(error.message, "error")));
  studyCopyTextSecondaryBtn?.addEventListener("click", () => copyCurrentText().catch((error) => toast(error.message, "error")));
  studyApplyPageSelectionBtn?.addEventListener("click", () => applyPageSelection({ preserveCurrent: true }));
  studyClearScopeBtn?.addEventListener("click", () => clearPageScope().catch((error) => toast(error.message, "error")));
  studyAcceptSuggestionsBtn?.addEventListener("click", () => acceptAllSuggestedPages().catch((error) => toast(error.message, "error")));
  studyPageScopeMode?.addEventListener("change", () => {
    if (studyPageScopeMode.value !== "custom-pages") {
      applyPageSelection({ preserveCurrent: true }).catch((error) => toast(error.message, "error"));
    } else {
      updatePageSelectionInputState();
      updateScopeQuickChips();
    }
  });
  studyScopeQuickChips?.addEventListener("click", (event) => {
    const button = event.target.closest(".scope-chip");
    if (!button || button.disabled || !studyPageScopeMode) return;
    studyPageScopeMode.value = button.dataset.scope || "all-pages";
    updateScopeQuickChips();
    if (studyPageScopeMode.value === "custom-pages") {
      updatePageSelectionInputState();
      return;
    }
    applyPageSelection({ preserveCurrent: true }).catch((error) => toast(error.message, "error"));
  });
  studyPageSelectionInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyPageSelection({ preserveCurrent: true }).catch((error) => toast(error.message, "error"));
    }
  });

  studyExplainBtn?.addEventListener("click", () => explainCurrentPage("explain"));
  studySummarizeBtn?.addEventListener("click", () => explainCurrentPage("summarize"));
  studyKeyBtn?.addEventListener("click", () => explainCurrentPage("keypoints"));
  studyFeynmanBtn?.addEventListener("click", () => explainCurrentPage("feynman"));

  studyAskBtn?.addEventListener("click", () => {
    const prompt = (studyCustomPrompt?.value || "").trim();
    if (!prompt) {
      toast(t("study.extraPromptRequired", {}, "Write your extra question first."), "error");
      return;
    }
    explainCurrentPage("explain", prompt);
  });
  studySuggestPagesBtn?.addEventListener("click", () => suggestRelatedPages());
  studyAudioBtn?.addEventListener("click", () => createAudioOverview());
  studyMindMapBtn?.addEventListener("click", () => createMindMap());
  studyInsightClose?.addEventListener("click", () => {
    stopStudySpeech();
    hideInsightPanel();
  });
  studyToolsToggle?.addEventListener("click", () => {
    setStudyToolsOpen(!studyToolsDrawer?.classList.contains("open"));
  });
  studyToolsClose?.addEventListener("click", () => {
    setStudyToolsOpen(false);
  });
  studyToolsOverlay?.addEventListener("click", () => {
    setStudyToolsOpen(false);
  });

  studyCustomPrompt?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      studyAskBtn?.click();
    }
  });

  studyDropZone?.addEventListener("click", () => studyFileInput?.click());
  studySourcePackToggle?.addEventListener("click", () => {
    setStudyPackCollapsed(!studySourcePackCard?.classList.contains("collapsed"), { userAction: true });
  });
  studySourcePackInlineToggle?.addEventListener("click", () => {
    setStudyPackCollapsed(!studySourcePackCard?.classList.contains("collapsed"), { userAction: true });
  });
  studyDropZone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    studyDropZone.style.borderColor = "var(--accent)";
  });
  studyDropZone?.addEventListener("dragleave", () => {
    studyDropZone.style.borderColor = "";
  });
  studyDropZone?.addEventListener("drop", (event) => {
    event.preventDefault();
    studyDropZone.style.borderColor = "";
    const file = event.dataTransfer?.files?.[0];
    if (file) handleStudyFile(file);
  });
  studyFileInput?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) handleStudyFile(file);
    event.target.value = "";
  });

  document.addEventListener("keydown", (event) => {
    if (!isStudyActive()) return;
    const tag = event.target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || event.target?.isContentEditable) return;

    if (event.key === "ArrowLeft") {
      pdfPrevBtn?.click();
    } else if (event.key === "ArrowRight") {
      pdfNextBtn?.click();
    }
  });

  window.addEventListener("documents:updated", (event) => {
    if (event.detail?.reset) {
      resetStudySources();
      return;
    }

    if (event.detail?.deletedDocumentId) {
      removeStudySourceByDocumentId(event.detail.deletedDocumentId);
    }
  });

  document.addEventListener("uiLocaleChange", () => {
    updateSelectionInfo();
    updateCoverageBadge();
    renderStudySourcePack();
    updateScopeQuickChips();
    renderRelatedSuggestions();
    renderVisiblePageChips();
    setStudyPackCollapsed(studySourcePackCard?.classList.contains("collapsed"), { persist: false });
  });
  document.addEventListener("simpleModeChange", () => {
    syncStudyPackForMode();
    if (typeof window.getCurrentSimpleMode === "function" && window.getCurrentSimpleMode()) {
      setStudyToolsOpen(false, { persist: false });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && studyToolsDrawer?.classList.contains("open")) {
      setStudyToolsOpen(false);
    }
  });

  bindPaneResizer();
  applyStoredStudyPaneWidth();
  renderRelatedSuggestions();
  updatePageCounters();
  updateZoomBadge();
  updateNavButtons();
  clearStudyState(false);
  setStudyPackCollapsed(getStoredStudyPackCollapsed(), { persist: false });
  setStudyToolsOpen(getStoredStudyToolsOpen(), { persist: false });
  renderStudySourcePack();
  syncStudyPackForMode();
  updateScopeQuickChips();

  window.studyModule = {
    loadPDF,
    loadTextSource,
    explainCurrentPage,
    prevPage: () => pdfPrevBtn?.click(),
    nextPage: () => pdfNextBtn?.click(),
    registerUploadedPdf,
    loadIndexedTextDocument,
    loadPreviewPdfDocument,
    openSourceByKey,
    resetStudySources,
    removeStudySourceByDocumentId,
    getCurrentContextPack,
    suggestRelatedPages,
  };
})();

