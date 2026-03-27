(function () {
  const PAGE_TEXT_LIMIT = 12000;
  const REQUEST_TIMEOUT_MS = 45000;
  const BASE_SCALE = 1.4;
  const MIN_SCALE = 0.8;
  const MAX_SCALE = 2.8;
  const PDF_EXT_RE = /\.pdf$/i;
  const PPT_EXT_RE = /\.(ppt|pptx)$/i;

  let pdfDoc = null;
  let currentPage = 0;
  let totalPages = 0;
  let currentScale = BASE_SCALE;
  let currentSourceMode = "";
  let currentSourceKey = "";
  let currentTextSource = "";
  let activeExplainController = null;
  let activeRenderTask = null;

  const sourceStore = new Map();
  const pageTextCache = new Map();

  const pdfPrevBtn = document.getElementById("pdfPrev");
  const pdfNextBtn = document.getElementById("pdfNext");
  const pdfPageEl = document.getElementById("pdfPage");
  const pdfTotalEl = document.getElementById("pdfTotal");
  const studyNoPdf = document.getElementById("studyNoPdf");
  const pdfViewer = document.getElementById("pdfViewer");
  const pdfCanvas = document.getElementById("pdfCanvas");
  const studyDropZone = document.getElementById("studyDropZone");
  const studyFileInput = document.getElementById("studyFileInput");
  const studyDocumentSelect = document.getElementById("studyDocumentSelect");
  const studyZoomOutBtn = document.getElementById("studyZoomOut");
  const studyZoomInBtn = document.getElementById("studyZoomIn");
  const studyZoomResetBtn = document.getElementById("studyZoomReset");
  const studyZoomLevel = document.getElementById("studyZoomLevel");
  const studyToggleTextBtn = document.getElementById("studyToggleText");
  const studyCopyTextBtn = document.getElementById("studyCopyText");
  const studyCopyTextSecondaryBtn = document.getElementById("studyCopyTextSecondary");
  const studyTextDrawer = document.getElementById("studyTextDrawer");
  const studyPageText = document.getElementById("studyPageText");
  const studyDocTextPreview = document.getElementById("studyDocTextPreview");
  const studyChatMessages = document.getElementById("studyChatMessages");
  const studyCustomPrompt = document.getElementById("studyCustomPrompt");
  const studyAskBtn = document.getElementById("studyAskBtn");
  const studyExplainBtn = document.getElementById("studyExplainBtn");
  const studySummarizeBtn = document.getElementById("studySummarizeBtn");
  const studyKeyBtn = document.getElementById("studyKeyBtn");
  const studyFeynmanBtn = document.getElementById("studyFeynmanBtn");
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

  actionButtons.forEach((button) => {
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

  function updatePageCounters() {
    if (pdfPageEl) pdfPageEl.textContent = String(currentPage || 0);
    if (pdfTotalEl) pdfTotalEl.textContent = String(totalPages || 0);
  }

  function updateZoomBadge() {
    if (studyZoomLevel) {
      studyZoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    }
  }

  function updateNavButtons() {
    const isPdf = currentSourceMode === "pdf" && pdfDoc;
    if (pdfPrevBtn) pdfPrevBtn.disabled = !isPdf || currentPage <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = !isPdf || currentPage >= totalPages;
    if (studyZoomOutBtn) studyZoomOutBtn.disabled = !isPdf;
    if (studyZoomInBtn) studyZoomInBtn.disabled = !isPdf;
    if (studyZoomResetBtn) studyZoomResetBtn.disabled = !isPdf;
  }

  function setNoDocVisible(visible) {
    if (studyNoPdf) studyNoPdf.style.display = visible ? "flex" : "none";
    if (pdfViewer) pdfViewer.style.display = visible ? "none" : "flex";
  }

  function setViewerMode(mode) {
    if (!pdfCanvas || !studyDocTextPreview) return;
    const isText = mode === "text";
    pdfCanvas.style.display = isText ? "none" : "block";
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
    } else if (!currentSourceKey && sourceStore.size === 1) {
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

  async function syncTextViews() {
    const sourceText = await getCurrentSourceText();
    if (studyPageText) studyPageText.value = sourceText;

    if (currentSourceMode === "text") {
      if (studyDocTextPreview) studyDocTextPreview.textContent = currentTextSource || sourceText;
    } else if (studyDocTextPreview) {
      studyDocTextPreview.textContent = "";
    }
  }

  function clearCanvas() {
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
    if (studyDocumentSelect) studyDocumentSelect.value = "";
    if (resetMessages) resetStudyMessages();
  }

  async function renderPage(pageNumber) {
    if (!pdfDoc || !pdfCanvas) return;

    currentPage = Math.min(Math.max(pageNumber, 1), totalPages);
    const page = await pdfDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale: currentScale });
    const pixelRatio = window.devicePixelRatio || 1;
    const canvasContext = pdfCanvas.getContext("2d");

    pdfCanvas.width = Math.floor(viewport.width * pixelRatio);
    pdfCanvas.height = Math.floor(viewport.height * pixelRatio);
    pdfCanvas.style.width = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;

    if (activeRenderTask) {
      try {
        activeRenderTask.cancel();
      } catch {}
    }

    const renderTask = page.render({
      canvasContext,
      viewport,
      transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null,
    });
    activeRenderTask = renderTask;

    try {
      await renderTask.promise;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") throw error;
      return;
    }

    const source = sourceStore.get(currentSourceKey);
    if (source) {
      source.lastPage = currentPage;
      source.lastScale = currentScale;
    }

    updatePageCounters();
    updateZoomBadge();
    updateNavButtons();
    await syncTextViews();
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
    setNoDocVisible(false);
    setViewerMode("pdf");
    await renderPage(currentPage);
  }

  async function openTextSource(source) {
    pdfDoc = null;
    totalPages = 1;
    currentPage = 1;
    currentSourceMode = "text";
    currentScale = BASE_SCALE;
    currentTextSource = source.text || "";
    setNoDocVisible(false);
    setViewerMode("text");
    updatePageCounters();
    updateZoomBadge();
    updateNavButtons();
    await syncTextViews();
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
      toast("Study dosyasi acilamadi: " + error.message, "error");
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
      toast("Aktif session veya dokuman bulunamadi.", "error");
      return false;
    }

    const res = await fetch(`/api/session/${sessionId}/document/${documentId}/text`);
    const data = await res.json();
    const apiError = typeof window.getApiError === "function" ? window.getApiError(data) : null;
    if (!res.ok || apiError) {
      throw new Error(apiError?.message || "Dokuman metni alinamadi.");
    }

    const text = String(data.text || "").trim();
    if (!text) {
      throw new Error(data.hint || "Bu dokumandan okunabilir metin cikarilamadi.");
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
    }, { autoOpen: true });

    return !!key;
  }

  async function loadPreviewPdfDocument(documentId, preferredName = "") {
    const cached = Array.from(sourceStore.values()).find((source) => source.documentId === documentId && source.kind === "pdf" && source.url);
    if (cached) {
      await openSourceByKey(cached.key);
      return true;
    }

    const sessionId = window.currentSessionId;
    if (!sessionId || !documentId) {
      toast("Aktif session veya preview dokumani bulunamadi.", "error");
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
    }, { autoOpen: true });

    return !!key;
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
    const text = await getCurrentSourceText();
    if (!text) {
      toast("Kopyalanacak metin bulunamadi.", "error");
      return;
    }

    await navigator.clipboard.writeText(text);
    toast("Metin panoya kopyalandi.", "success");
  }

  function toggleTextDrawer() {
    if (!studyTextDrawer) return;
    studyTextDrawer.classList.toggle("visible");
  }

  async function zoomTo(nextScale) {
    if (currentSourceMode !== "pdf" || !pdfDoc) {
      toast("Zoom yalnizca PDF goruntulemede destekleniyor.", "error");
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

  function getStudyRequestLabel(mode, customPrompt) {
    const pageLabel = currentSourceMode === "pdf" ? `Page ${currentPage || 1}` : "Current source";
    if (customPrompt) return `You: ${pageLabel}: ${customPrompt}`;

    const labelMap = {
      explain: "explain",
      summarize: "summarize",
      keypoints: "list key points",
      feynman: "explain with the Feynman technique",
    };

    return `You: ${pageLabel}: ${labelMap[mode] || "analyze"}`;
  }

  async function explainCurrentPage(mode = "explain", customPrompt = "") {
    if (!currentSourceKey) {
      toast("Once bir PDF veya PowerPoint secin.", "error");
      return;
    }

    if (activeExplainController) {
      toast("Mevcut analiz tamamlanmadan yeni istek baslatilamaz.", "error");
      return;
    }

    const sourceText = await getCurrentSourceText();
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

    appendStudyMessage("user", getStudyRequestLabel(mode, customPrompt));
    setStudyButtonsBusy(true, activeButton);

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
          teachingMode: typeof window.getSelectedStudyMode === "function"
            ? window.getSelectedStudyMode()
            : "deep",
          language: typeof window.getCurrentResponseLanguage === "function"
            ? window.getCurrentResponseLanguage()
            : "tr-TR",
        }),
      });

      const data = await res.json();
      const apiError = typeof window.getApiError === "function" ? window.getApiError(data) : null;
      if (!res.ok || apiError) {
        const message = apiError?.message || "Analiz istegi basarisiz oldu.";
        const hint = apiError?.hint ? `\n\nIpucu: ${apiError.hint}` : "";
        appendStudyMessage("system", `Warning: ${message}${hint}`);
        toast(message, "error");
        return;
      }

      appendStudyMessage("ai", data.response || "Yanıt alinamadi.");
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

    if (!isPdf && !isPpt) {
      toast("Study sekmesinde yalnizca PDF ve PowerPoint destekleniyor.", "error");
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

      if (result?.documentId && result?.indexed) {
        await loadIndexedTextDocument(result.documentId, result.fileName || fileName);
        if (typeof window.switchTab === "function") window.switchTab("study");
        toast("PowerPoint Study sekmesinde metin kaynagi olarak acildi.", "success");
        return;
      }

      throw new Error(result?.hint || result?.reason || "PowerPoint kaynak olarak hazirlanamadi.");
    } catch (error) {
      if (isPdf) {
        await loadPDF(file, { fileName, autoOpen: true });
        toast("PDF onizlemesi acildi, fakat sunucuya yukleme/indexleme tamamlanamadi.", "error");
        return;
      }

      toast(error.message || "PowerPoint yuklenemedi.", "error");
    }
  }

  function bindPaneResizer() {
    if (!studyPaneResizer || !studyAiPane) return;

    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (event) => {
      const delta = startX - event.clientX;
      const nextWidth = Math.min(760, Math.max(380, startWidth + delta));
      studyAiPane.style.width = `${nextWidth}px`;
    };

    const stopDrag = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", stopDrag);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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

  pdfPrevBtn?.addEventListener("click", async () => {
    if (currentSourceMode !== "pdf" || currentPage <= 1) return;
    await renderPage(currentPage - 1);
  });

  pdfNextBtn?.addEventListener("click", async () => {
    if (currentSourceMode !== "pdf" || currentPage >= totalPages) return;
    await renderPage(currentPage + 1);
  });

  studyDocumentSelect?.addEventListener("change", async (event) => {
    const sourceKey = event.target.value;
    if (!sourceKey) return;
    try {
      await openSourceByKey(sourceKey);
    } catch (error) {
      toast(error.message || "Kaynak acilamadi.", "error");
    }
  });

  studyZoomOutBtn?.addEventListener("click", () => zoomTo(currentScale - 0.15));
  studyZoomInBtn?.addEventListener("click", () => zoomTo(currentScale + 0.15));
  studyZoomResetBtn?.addEventListener("click", () => zoomTo(BASE_SCALE));
  studyToggleTextBtn?.addEventListener("click", () => toggleTextDrawer());
  studyCopyTextBtn?.addEventListener("click", () => copyCurrentText().catch((error) => toast(error.message, "error")));
  studyCopyTextSecondaryBtn?.addEventListener("click", () => copyCurrentText().catch((error) => toast(error.message, "error")));

  studyExplainBtn?.addEventListener("click", () => explainCurrentPage("explain"));
  studySummarizeBtn?.addEventListener("click", () => explainCurrentPage("summarize"));
  studyKeyBtn?.addEventListener("click", () => explainCurrentPage("keypoints"));
  studyFeynmanBtn?.addEventListener("click", () => explainCurrentPage("feynman"));

  studyAskBtn?.addEventListener("click", () => {
    const prompt = (studyCustomPrompt?.value || "").trim();
    if (!prompt) {
      toast("Once ek soruyu yazin.", "error");
      return;
    }
    explainCurrentPage("explain", prompt);
  });

  studyCustomPrompt?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      studyAskBtn?.click();
    }
  });

  studyDropZone?.addEventListener("click", () => studyFileInput?.click());
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

  bindPaneResizer();
  updatePageCounters();
  updateZoomBadge();
  updateNavButtons();
  clearStudyState(false);

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
  };
})();
