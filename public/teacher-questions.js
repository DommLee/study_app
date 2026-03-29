// ============================================================
// OmniTutor v3 - Teacher Questions Module
// ============================================================
(function () {
  let indexedDocuments = [];
  let questionDocuments = [];
  let currentQuestions = [];
  let currentQuestion = null;
  let mistakeBook = [];
  let teacherSearchTerm = "";
  let teacherStatusFilter = "all";
  let teacherSortMode = "order";

  const teacherDocumentSelect = document.getElementById("teacherDocumentSelect");
  const teacherSupportDocs = document.getElementById("teacherSupportDocs");
  const teacherSupportChecklist = document.getElementById("teacherSupportChecklist");
  const teacherQuestionSearch = document.getElementById("teacherQuestionSearch");
  const teacherStatusFilterSelect = document.getElementById("teacherStatusFilter");
  const teacherSortModeSelect = document.getElementById("teacherSortMode");
  const teacherSummary = document.getElementById("teacherSummary");
  const teacherSupportCount = document.getElementById("teacherSupportCount");
  const teacherSourcePackMeta = document.getElementById("teacherSourcePackMeta");
  const teacherSourcePackSummary = document.getElementById("teacherSourcePackSummary");
  const teacherSourcePackChips = document.getElementById("teacherSourcePackChips");
  const teacherQuestionCounter = document.getElementById("teacherQuestionCounter");
  const teacherQuestionList = document.getElementById("teacherQuestionList");
  const teacherQuestionMeta = document.getElementById("teacherQuestionMeta");
  const teacherCurrentTitle = document.getElementById("teacherCurrentTitle");
  const teacherCurrentBadges = document.getElementById("teacherCurrentBadges");
  const teacherTypeOverride = document.getElementById("teacherTypeOverride");
  const teacherQuestionText = document.getElementById("teacherQuestionText");
  const teacherQuestionOptions = document.getElementById("teacherQuestionOptions");
  const teacherUserAnswer = document.getElementById("teacherUserAnswer");
  const teacherTeachBtn = document.getElementById("teacherTeachBtn");
  const teacherCheckBtn = document.getElementById("teacherCheckBtn");
  const teacherFeedback = document.getElementById("teacherFeedback");
  const teacherSupportPreview = document.getElementById("teacherSupportPreview");
  const teacherSuggestedSupport = document.getElementById("teacherSuggestedSupport");
  const teacherMistakeCounter = document.getElementById("teacherMistakeCounter");
  const teacherMistakeList = document.getElementById("teacherMistakeList");
  const teacherUploadBtn = document.getElementById("teacherUploadBtn");
  const teacherSelectAllSupportBtn = document.getElementById("teacherSelectAllSupportBtn");
  const teacherClearSupportBtn = document.getElementById("teacherClearSupportBtn");
  const teacherMistakeQuizBtn = document.getElementById("teacherMistakeQuizBtn");
  const teacherMistakeDeckBtn = document.getElementById("teacherMistakeDeckBtn");
  const teacherPrevQuestionBtn = document.getElementById("teacherPrevQuestionBtn");
  const teacherNextQuestionBtn = document.getElementById("teacherNextQuestionBtn");
  const teacherNextOpenBtn = document.getElementById("teacherNextOpenBtn");
  const teacherNextWrongBtn = document.getElementById("teacherNextWrongBtn");
  const teacherCountNew = document.getElementById("teacherCountNew");
  const teacherCountStudying = document.getElementById("teacherCountStudying");
  const teacherCountSolved = document.getElementById("teacherCountSolved");
  const teacherCountWrong = document.getElementById("teacherCountWrong");

  function t(key, params = {}, fallback = "") {
    return window.i18n?.t(key, params, fallback) || fallback || key;
  }

  function applyLocale() {
    const typeLabel = document.querySelector("label[for='teacherTypeOverride'] span");
    if (typeLabel) typeLabel.textContent = t("teacher.typeOverride", {}, "Question type");
    if (teacherQuestionSearch) {
      teacherQuestionSearch.placeholder = t("teacher.searchPlaceholder", {}, teacherQuestionSearch.placeholder);
    }
    if (teacherUserAnswer) {
      teacherUserAnswer.placeholder = t("teacher.answerPlaceholder", {}, teacherUserAnswer.placeholder);
    }
    if (teacherStatusFilterSelect) {
      Array.from(teacherStatusFilterSelect.options).forEach((option) => {
        option.textContent = t(`teacher.filter.${option.value}`, {}, option.textContent);
      });
    }
    if (teacherSortModeSelect) {
      Array.from(teacherSortModeSelect.options).forEach((option) => {
        option.textContent = t(`teacher.sort.${option.value}`, {}, option.textContent);
      });
    }
    if (teacherPrevQuestionBtn) teacherPrevQuestionBtn.textContent = t("teacher.nav.prev", {}, teacherPrevQuestionBtn.textContent);
    if (teacherNextQuestionBtn) teacherNextQuestionBtn.textContent = t("teacher.nav.next", {}, teacherNextQuestionBtn.textContent);
    if (teacherNextOpenBtn) teacherNextOpenBtn.textContent = t("teacher.nav.nextOpen", {}, teacherNextOpenBtn.textContent);
    if (teacherNextWrongBtn) teacherNextWrongBtn.textContent = t("teacher.nav.nextWrong", {}, teacherNextWrongBtn.textContent);
    if (teacherTeachBtn) teacherTeachBtn.textContent = t("teacher.teach", {}, teacherTeachBtn.textContent);
    if (teacherCheckBtn) teacherCheckBtn.textContent = t("teacher.check", {}, teacherCheckBtn.textContent);
    if (teacherTypeOverride) {
      Array.from(teacherTypeOverride.options).forEach((option) => {
        option.textContent = t(`teacher.type.${option.value}`, {}, option.textContent);
      });
    }
    if (teacherSelectAllSupportBtn) teacherSelectAllSupportBtn.textContent = t("teacher.selectAll", {}, teacherSelectAllSupportBtn.textContent);
    if (teacherClearSupportBtn) teacherClearSupportBtn.textContent = t("teacher.clear", {}, teacherClearSupportBtn.textContent);
    if (teacherMistakeQuizBtn) teacherMistakeQuizBtn.textContent = t("teacher.miniQuiz", {}, teacherMistakeQuizBtn.textContent);
    if (teacherMistakeDeckBtn) teacherMistakeDeckBtn.textContent = t("teacher.recoveryCards", {}, teacherMistakeDeckBtn.textContent);
  }

  function fillSelectOptions(selectEl, items, emptyLabel) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    selectEl.appendChild(empty);

    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      selectEl.appendChild(option);
    });
  }

  function renderMultiSelect(selectEl, items, selectedValues = []) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    if (!items.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("teacher.noSupportDocs", {}, "No support sources");
      selectEl.appendChild(option);
      selectEl.disabled = true;
      updateSupportCount(0, 0);
      renderSupportChecklist([], []);
      return;
    }

    selectEl.disabled = false;
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.selected = selectedValues.includes(item.value);
      selectEl.appendChild(option);
    });
    updateSupportCount(selectedValues.length, items.length);
    renderSupportChecklist(items, selectedValues);
  }

  async function readJsonResponse(res) {
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(text || t("teacher.invalidJson", {}, "Response was not valid JSON."));
    }
    if (!res.ok || data?.error) {
      throw new Error(data?.hint ? `${data.error} (${data.hint})` : (data?.error || `HTTP ${res.status}`));
    }
    return data;
  }

  async function fetchSessionSnapshot() {
    const sessionId = window.currentSessionId;
    if (!sessionId) return { documents: [], generated: { mistakeBook: [] } };
    const res = await fetch(`/api/session/${sessionId}`);
    return readJsonResponse(res);
  }

  function getCurrentLanguage() {
    return typeof window.getCurrentResponseLanguage === "function"
      ? window.getCurrentResponseLanguage()
      : "tr-TR";
  }

  function getCurrentPreset() {
    return typeof window.getCurrentPromptPreset === "function"
      ? window.getCurrentPromptPreset()
      : "auto";
  }

  function getDocumentLabel(doc) {
    if (!doc) return "";
    return `${doc.questionSource ? "[Q] " : ""}${doc.name}`;
  }

  function getQuestionDisplayType(question) {
    if (!question) return "classic";
    if (["multiple", "classic", "truefalse"].includes(question.typeOverride)) {
      return question.typeOverride;
    }
    if (Array.isArray(question.options) && question.options.length >= 2) {
      if (question.options.length === 2) {
        const normalized = question.options.map((option) => String(option || "").toLowerCase());
        if (normalized.some((value) => value.includes("true")) || normalized.some((value) => value.includes("false"))) {
          return "truefalse";
        }
      }
      return "multiple";
    }
    if (["multiple", "classic", "truefalse"].includes(question.type)) {
      return question.type;
    }
    return question.type || "classic";
  }

  function getQuestionTypeLabel(type) {
    if (type === "multiple") return t("teacher.type.multiple", {}, "Multiple choice");
    if (type === "truefalse") return t("teacher.type.truefalse", {}, "True / False");
    return t("teacher.type.classic", {}, "Open ended");
  }

  function formatQuestionTypes(types = []) {
    return Array.from(new Set((types || []).filter(Boolean))).map((type) => getQuestionTypeLabel(type)).join(", ");
  }

  function getSupportTypeLabel(doc) {
    if (!doc) return "DOC";
    if (doc.questionSource) return "Q";
    const hint = String(doc.fileType || doc.type || doc.mimeType || doc.name || "").toLowerCase();
    if (hint.includes("pdf")) return "PDF";
    if (hint.includes("ppt")) return "PPT";
    if (hint.includes("doc")) return "DOCX";
    if (hint.includes("png") || hint.includes("jpg") || hint.includes("jpeg") || hint.includes("webp") || hint.includes("image")) return "IMG";
    if (hint.includes("txt") || hint.includes("text")) return "TXT";
    return "DOC";
  }

  function getDocumentConfidenceInfo(doc) {
    const numeric = Number(doc?.parseConfidence);
    if (Number.isFinite(numeric)) {
      if (numeric >= 0.8) return { className: "confidence-high", label: t("teacher.confidence.high", {}, "High confidence") };
      if (numeric >= 0.5) return { className: "confidence-medium", label: t("teacher.confidence.medium", {}, "Medium confidence") };
      return { className: "confidence-low", label: t("teacher.confidence.low", {}, "Low confidence") };
    }

    const raw = String(doc?.ocrQuality || doc?.parseConfidence || "").toLowerCase();
    if (!raw) return null;
    if (raw.includes("high") || raw.includes("good") || raw.includes("iyi")) {
      return { className: "confidence-high", label: t("teacher.confidence.high", {}, "High confidence") };
    }
    if (raw.includes("medium") || raw.includes("orta")) {
      return { className: "confidence-medium", label: t("teacher.confidence.medium", {}, "Medium confidence") };
    }
    return { className: "confidence-low", label: t("teacher.confidence.low", {}, "Low confidence") };
  }

  function getSupportOptionCount() {
    if (!teacherSupportDocs) return 0;
    return Array.from(teacherSupportDocs.options).filter((option) => option.value).length;
  }

  function syncSupportChecklistSelection(selectedIds = []) {
    if (!teacherSupportChecklist) return;
    const allowed = new Set(selectedIds);
    teacherSupportChecklist.querySelectorAll("input[type='checkbox'][data-support-id]").forEach((input) => {
      input.checked = allowed.has(input.dataset.supportId);
    });
  }

  function renderSupportChecklist(items = [], selectedValues = []) {
    if (!teacherSupportChecklist) return;
    teacherSupportChecklist.innerHTML = "";

    if (!items.length) {
      teacherSupportChecklist.classList.add("empty");
      teacherSupportChecklist.textContent = t("teacher.noSupportDocs", {}, "No support sources");
      return;
    }

    teacherSupportChecklist.classList.remove("empty");
    const selected = new Set(selectedValues);

    items.forEach((item) => {
      const row = document.createElement("label");
      row.className = "support-check-item";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.supportId = item.value;
      input.checked = selected.has(item.value);
      input.addEventListener("change", () => {
        const next = input.checked
          ? Array.from(new Set([...getSelectedSupportIds(), item.value]))
          : getSelectedSupportIds().filter((id) => id !== item.value);
        setSupportSelection(next);
      });

      const type = document.createElement("span");
      type.className = "support-type";
      type.textContent = item.typeLabel || "DOC";

      const name = document.createElement("span");
      name.className = "support-name";
      name.textContent = item.label;

      row.appendChild(input);
      row.appendChild(type);
      row.appendChild(name);
      teacherSupportChecklist.appendChild(row);
    });
  }

  function getSelectedSupportIds() {
    if (!teacherSupportDocs || teacherSupportDocs.disabled) return [];
    return Array.from(teacherSupportDocs.selectedOptions)
      .map((option) => option.value)
      .filter(Boolean);
  }

  function setSupportSelection(ids = []) {
    if (!teacherSupportDocs || teacherSupportDocs.disabled) return;
    const allowed = new Set(ids);
    Array.from(teacherSupportDocs.options).forEach((option) => {
      option.selected = allowed.has(option.value);
    });
    syncSupportChecklistSelection(getSelectedSupportIds());
    updateSupportCount(getSelectedSupportIds().length, getSupportOptionCount());
    teacherSupportDocs.dispatchEvent(new Event("change"));
  }

  function updateSupportCount(selectedCount, totalCount) {
    if (!teacherSupportCount) return;
    if (!totalCount) {
      teacherSupportCount.textContent = t("teacher.supportCountEmpty", {}, "0 support docs selected");
      return;
    }
    teacherSupportCount.textContent = t("teacher.supportCount", { selected: selectedCount, total: totalCount }, `${selectedCount} / ${totalCount} support docs selected`);
  }

  function renderSupportPreview() {
    if (!teacherSupportPreview) return;
    teacherSupportPreview.innerHTML = "";

    const selectedIds = getSelectedSupportIds();
    if (!selectedIds.length) {
      const empty = document.createElement("div");
      empty.className = "teacher-empty-card";
      empty.textContent = t("teacher.noSupportSelected", {}, "No support sources selected yet. You can solve with the question pack only, or add multiple PDFs/PPTs/Word notes to strengthen the explanation.");
      teacherSupportPreview.appendChild(empty);
      return;
    }

    selectedIds
      .map((id) => indexedDocuments.find((doc) => doc.id === id))
      .filter(Boolean)
      .forEach((doc) => {
        const chip = document.createElement("span");
        chip.className = "teacher-support-chip";
        chip.textContent = doc.questionSource ? `[Q] ${doc.name}` : doc.name;
        teacherSupportPreview.appendChild(chip);
      });
  }

  function renderSourcePackSummary() {
    if (!teacherSourcePackMeta || !teacherSourcePackSummary || !teacherSourcePackChips) return;
    const activeDoc = indexedDocuments.find((doc) => doc.id === (teacherDocumentSelect?.value || "")) || null;
    const selectedSupportDocs = getSelectedSupportIds()
      .map((id) => indexedDocuments.find((doc) => doc.id === id))
      .filter(Boolean);

    teacherSourcePackChips.innerHTML = "";

    if (!activeDoc) {
      teacherSourcePackMeta.textContent = t("teacher.packMetaEmpty", {}, "No question pack selected");
      teacherSourcePackSummary.textContent = t(
        "teacher.packSummaryEmpty",
        {},
        "First upload a question pack. Then add one or more support notes if you want stronger explanations."
      );
      return;
    }

    const typeList = Array.from(new Set((currentQuestions || []).map((question) => getQuestionDisplayType(question)).filter(Boolean)));
    const types = (typeList.length ? typeList : (activeDoc.questionSummary?.types || [])).map((type) => {
      return getQuestionTypeLabel(type);
    }).join(", ") || t("teacher.unknownType", {}, "unknown");
    const count = activeDoc.questionSummary?.count || currentQuestions.length || 0;

    teacherSourcePackMeta.textContent = `[Q] ${activeDoc.name}`;
    teacherSourcePackSummary.textContent = t(
      "teacher.packSummaryReady",
      { count, types, support: selectedSupportDocs.length },
      `${count} questions detected. Types: ${types}. ${selectedSupportDocs.length} support source(s) selected.`
    );

    const mainChip = document.createElement("span");
    mainChip.className = "source-chip";
    mainChip.textContent = `[Q] ${activeDoc.name}`;
    teacherSourcePackChips.appendChild(mainChip);

    const sourceChip = document.createElement("span");
    sourceChip.className = "source-chip";
    sourceChip.textContent = getSupportTypeLabel(activeDoc);
    teacherSourcePackChips.appendChild(sourceChip);

    const typeChip = document.createElement("span");
    typeChip.className = "source-chip";
    typeChip.textContent = `${count} • ${types}`;
    teacherSourcePackChips.appendChild(typeChip);

    const confidenceInfo = getDocumentConfidenceInfo(activeDoc);
    if (confidenceInfo) {
      const confidenceChip = document.createElement("span");
      confidenceChip.className = `source-chip ${confidenceInfo.className}`;
      confidenceChip.textContent = confidenceInfo.label;
      teacherSourcePackChips.appendChild(confidenceChip);
    }

    selectedSupportDocs.forEach((doc) => {
      const chip = document.createElement("span");
      chip.className = "source-chip muted";
      chip.textContent = `${getSupportTypeLabel(doc)} ${doc.name}`;
      teacherSourcePackChips.appendChild(chip);
    });
  }

  function scoreSupportDocument(doc, activeDoc, question) {
    if (!doc || !question || doc.id === activeDoc?.id) return -1;
    const selectedIds = new Set(getSelectedSupportIds());
    if (selectedIds.has(doc.id)) return -1;

    const sourceText = [
      question.prompt,
      ...(Array.isArray(question.options) ? question.options : []),
      ...(Array.isArray(activeDoc?.questionSummary?.tags) ? activeDoc.questionSummary.tags : []),
    ].join(" ").toLowerCase();
    const docText = [
      doc.name,
      ...(Array.isArray(doc.topics) ? doc.topics : []),
      ...(Array.isArray(doc.questionSummary?.tags) ? doc.questionSummary.tags : []),
    ].join(" ").toLowerCase();

    const tokens = Array.from(new Set(sourceText.split(/[^a-z0-9ğüşöçıİĞÜŞÖÇА-Яа-я]+/i).filter((token) => token.length >= 4)));
    let score = 0;
    tokens.forEach((token) => {
      if (docText.includes(token)) score += 2;
    });
    if (activeDoc?.name && doc.name && activeDoc.name.split(/[\s_.-]+/).some((part) => part.length > 3 && doc.name.toLowerCase().includes(part.toLowerCase()))) {
      score += 3;
    }
    if (Array.isArray(doc.topics) && doc.topics.some((topic) => sourceText.includes(String(topic).toLowerCase()))) {
      score += 2;
    }
    return score;
  }

  function renderSuggestedSupport() {
    if (!teacherSuggestedSupport) return;
    teacherSuggestedSupport.innerHTML = "";

    const activeDoc = indexedDocuments.find((doc) => doc.id === (teacherDocumentSelect?.value || "")) || null;
    const suggestions = indexedDocuments
      .map((doc) => ({ doc, score: scoreSupportDocument(doc, activeDoc, currentQuestion) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (!suggestions.length) {
      const empty = document.createElement("div");
      empty.className = "teacher-empty-card";
      empty.textContent = t("teacher.noSuggestions", {}, "No support suggestions yet.");
      teacherSuggestedSupport.appendChild(empty);
      return;
    }

    suggestions.forEach(({ doc }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "teacher-inline-btn";
      btn.textContent = doc.questionSource ? `[Q] ${doc.name}` : doc.name;
      btn.addEventListener("click", () => {
        const next = Array.from(new Set([...getSelectedSupportIds(), doc.id]));
        setSupportSelection(next);
        renderSupportPreview();
        renderSuggestedSupport();
      });
      teacherSuggestedSupport.appendChild(btn);
    });
  }

  function updateStatusCounts(counts = {}) {
    if (teacherCountNew) teacherCountNew.textContent = counts.new || 0;
    if (teacherCountStudying) teacherCountStudying.textContent = counts.studying || 0;
    if (teacherCountSolved) teacherCountSolved.textContent = counts.solved || 0;
    if (teacherCountWrong) teacherCountWrong.textContent = counts.wrong || 0;
  }

  function renderSupportDocs(activeDocumentId) {
    const supportDocs = indexedDocuments.filter((doc) => doc.id !== activeDocumentId);
    const activeDoc = indexedDocuments.find((doc) => doc.id === activeDocumentId) || null;
    const existingSelection = getSelectedSupportIds().filter((id) => supportDocs.some((doc) => doc.id === id));
    const selectedValues = existingSelection.length
      ? existingSelection
      : (activeDoc?.questionSource ? supportDocs.map((doc) => doc.id) : []);

    renderMultiSelect(
      teacherSupportDocs,
      supportDocs.map((doc) => ({ value: doc.id, label: getDocumentLabel(doc), typeLabel: getSupportTypeLabel(doc) })),
      selectedValues
    );
    renderSupportPreview();
    renderSuggestedSupport();
    renderSourcePackSummary();
  }

  function renderSummary(activeDoc, summary = null) {
    if (!teacherSummary) return;
    if (!activeDoc) {
      updateStatusCounts({ new: 0, studying: 0, solved: 0, wrong: 0 });
      if (indexedDocuments.length) {
        teacherSummary.textContent = t("teacher.noQuestionSourceSummary", {}, "No question source selected. Upload teacher questions as DOCX, PDF, or image. If the system detects a question pack, it will appear here.");
      } else {
        teacherSummary.textContent = t("teacher.noSourcesSummary", {}, "No sources yet. Upload a question pack first, then choose support documents.");
      }
      renderSourcePackSummary();
      return;
    }

    const count = summary?.count || activeDoc.questionSummary?.count || currentQuestions.length || 0;
    const derivedTypes = Array.from(new Set((currentQuestions || []).map((question) => getQuestionDisplayType(question)).filter(Boolean)));
    const types = Array.isArray(summary?.types) && summary.types.length
      ? formatQuestionTypes(summary.types)
      : (derivedTypes.length
        ? formatQuestionTypes(derivedTypes)
        : (formatQuestionTypes(activeDoc.questionSummary?.types || []) || t("teacher.unknownType", {}, "unknown")));
    const tags = Array.isArray(summary?.tags) && summary.tags.length
      ? summary.tags.slice(0, 5).join(" | ")
      : ((activeDoc.questionSummary?.tags || []).slice(0, 5).join(" | ") || t("teacher.noTags", {}, "no tags"));
    const qualityLabel = String(activeDoc.ocrQuality || "medium");
    const ocrNote = activeDoc.ocrRegionCount
      ? ` ${t("teacher.ocrSummary", { regions: activeDoc.ocrRegionCount, quality: qualityLabel }, `OCR regions: ${activeDoc.ocrRegionCount}. Quality: ${qualityLabel}.`)}`
      : "";
    const qualityHint = activeDoc.ocrQuality === "low"
      ? ` ${t("teacher.ocrLowHint", {}, "Parse quality looks low; a cleaner crop or clearer photo may improve question splitting.")}`
      : "";
    teacherSummary.textContent = t("teacher.summaryDetected", { name: activeDoc.name, count, types, tags }, `${activeDoc.name}: detected ${count} questions. Types: ${types}. Topic hints: ${tags}.`) + ocrNote + qualityHint;
    updateStatusCounts(summary?.statusCounts || { new: 0, studying: 0, solved: 0, wrong: 0 });
    renderSourcePackSummary();
  }

  function getStatusBadge(status) {
    const safeStatus = ["new", "studying", "solved", "wrong"].includes(status) ? status : "new";
    const map = {
      new: t("teacher.new", {}, "New"),
      studying: t("teacher.studying", {}, "Studying"),
      solved: t("teacher.solved", {}, "Solved"),
      wrong: t("teacher.wrong", {}, "Wrong"),
    };
    return { safeStatus, label: map[safeStatus] };
  }

  function getVisibleQuestions() {
    const search = teacherSearchTerm.trim().toLowerCase();
    let items = currentQuestions.filter((question) => {
      const statusPass = teacherStatusFilter === "all" ? true : question.status === teacherStatusFilter;
      if (!statusPass) return false;
      if (!search) return true;
      const haystack = [
        question.prompt,
        question.type,
        ...(Array.isArray(question.options) ? question.options : []),
        ...(Array.isArray(question.tags) ? question.tags : []),
      ].join(" ").toLowerCase();
      return haystack.includes(search);
    });

    if (teacherSortMode === "unsolved") {
      items = items.slice().sort((a, b) => {
        const aSolved = a.status === "solved" ? 1 : 0;
        const bSolved = b.status === "solved" ? 1 : 0;
        return aSolved - bSolved || a.id - b.id;
      });
    } else if (teacherSortMode === "wrong") {
      items = items.slice().sort((a, b) => {
        const aWrong = a.status === "wrong" ? 0 : 1;
        const bWrong = b.status === "wrong" ? 0 : 1;
        return aWrong - bWrong || a.id - b.id;
      });
    }

    return items;
  }

  function renderQuestionList() {
    if (!teacherQuestionList) return;
    teacherQuestionList.innerHTML = "";
    const visibleQuestions = getVisibleQuestions();
    const activeDoc = questionDocuments.find((doc) => String(doc.id) === String(teacherDocumentSelect?.value || "")) || null;
    if (teacherQuestionCounter) {
      teacherQuestionCounter.textContent = visibleQuestions.length === currentQuestions.length
        ? `${visibleQuestions.length} soru`
        : `${visibleQuestions.length} / ${currentQuestions.length} soru`;
    }

    if (!visibleQuestions.length) {
      const empty = document.createElement("p");
      empty.className = "teacher-helper-text";
      empty.textContent = currentQuestions.length
        ? t("teacher.noFilterMatch", {}, "No questions match this filter.")
        : questionDocuments.length
        ? t("teacher.parseEmpty", {}, "No separated questions were found in this pack. Try a different file or a cleaner scan.")
        : t("teacher.listDefault", {}, "Questions will be listed here one by one when a teacher question pack is selected.");
      teacherQuestionList.appendChild(empty);
      return;
    }

    visibleQuestions.forEach((question) => {
      const displayType = getQuestionDisplayType(question);
      const item = document.createElement("div");
      item.className = `teacher-question-item${currentQuestion?.id === question.id ? " active" : ""}`;

      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", () => selectQuestion(question.id));

      const title = document.createElement("div");
      title.className = "teacher-question-title";
      title.textContent = `${question.id}. ${question.prompt}`;

      const badgeRow = document.createElement("div");
      badgeRow.className = "teacher-badge-row";

      const typeBadge = document.createElement("span");
      typeBadge.className = "teacher-badge";
      typeBadge.textContent = getQuestionTypeLabel(displayType);
      badgeRow.appendChild(typeBadge);

      if (activeDoc) {
        const sourceBadge = document.createElement("span");
        sourceBadge.className = "teacher-badge source";
        sourceBadge.textContent = getSupportTypeLabel(activeDoc);
        badgeRow.appendChild(sourceBadge);

        const confidenceInfo = getDocumentConfidenceInfo(activeDoc);
        if (confidenceInfo) {
          const confidenceBadge = document.createElement("span");
          confidenceBadge.className = `teacher-badge ${confidenceInfo.className}`;
          confidenceBadge.textContent = confidenceInfo.label;
          badgeRow.appendChild(confidenceBadge);
        }
      }

      if (question.typeOverride && question.originalType && question.typeOverride !== question.originalType) {
        const overrideBadge = document.createElement("span");
        overrideBadge.className = "teacher-badge override";
        overrideBadge.textContent = t("teacher.manualOverride", {}, "Manual");
        badgeRow.appendChild(overrideBadge);
      }

      const statusInfo = getStatusBadge(question.status);
      const statusBadge = document.createElement("span");
      statusBadge.className = `teacher-badge status-${statusInfo.safeStatus}`;
      statusBadge.textContent = statusInfo.label;
      badgeRow.appendChild(statusBadge);

      if (Array.isArray(question.options) && question.options.length) {
        const optionBadge = document.createElement("span");
        optionBadge.className = "teacher-badge";
        optionBadge.textContent = t("teacher.optionCount", { count: question.options.length }, `${question.options.length} options`);
        badgeRow.appendChild(optionBadge);
      }

      if (question.attempts) {
        const attemptBadge = document.createElement("span");
        attemptBadge.className = "teacher-badge";
        attemptBadge.textContent = t("teacher.attemptCount", { count: question.attempts }, `${question.attempts} attempts`);
        badgeRow.appendChild(attemptBadge);
      }

      button.appendChild(title);
      button.appendChild(badgeRow);
      item.appendChild(button);
      teacherQuestionList.appendChild(item);
    });
  }

  function syncCurrentQuestionToVisibleList() {
    const visibleQuestions = getVisibleQuestions();
    if (!visibleQuestions.length) {
      currentQuestion = null;
      return;
    }
    const stillVisible = currentQuestion && visibleQuestions.some((item) => Number(item.id) === Number(currentQuestion.id));
    if (!stillVisible) {
      currentQuestion = visibleQuestions[0];
    }
  }

  function getCurrentQuestionIndex() {
    if (!currentQuestion) return -1;
    return getVisibleQuestions().findIndex((item) => Number(item.id) === Number(currentQuestion.id));
  }

  function updateQuestionNavigation() {
    const visibleQuestions = getVisibleQuestions();
    const currentIndex = getCurrentQuestionIndex();
    const hasQuestion = currentIndex >= 0;
    const nextOpenIndex = visibleQuestions.findIndex((item, index) => index > currentIndex && item.status !== "solved");
    const nextWrongIndex = visibleQuestions.findIndex((item, index) => index > currentIndex && item.status === "wrong");

    if (teacherPrevQuestionBtn) teacherPrevQuestionBtn.disabled = !hasQuestion || currentIndex <= 0;
    if (teacherNextQuestionBtn) teacherNextQuestionBtn.disabled = !hasQuestion || currentIndex >= visibleQuestions.length - 1;
    if (teacherNextOpenBtn) teacherNextOpenBtn.disabled = !hasQuestion || nextOpenIndex < 0;
    if (teacherNextWrongBtn) teacherNextWrongBtn.disabled = !hasQuestion || nextWrongIndex < 0;
  }

  function renderCurrentQuestion() {
    if (!teacherQuestionText || !teacherQuestionOptions || !teacherQuestionMeta || !teacherCurrentTitle) return;
    const activeDoc = questionDocuments.find((doc) => doc.id === teacherDocumentSelect?.value) || null;

    if (!currentQuestion) {
      teacherQuestionMeta.textContent = t("teacher.currentNone", {}, "No question selected");
      teacherCurrentTitle.textContent = t("teacher.currentTitle", {}, "Solve one by one with teaching");
      if (teacherCurrentBadges) teacherCurrentBadges.innerHTML = "";
      teacherQuestionText.textContent = t("teacher.pickQuestionHint", {}, "Pick a question. First use Teach This Question to understand the logic, then write your answer and use Check My Answer.");
      teacherQuestionOptions.innerHTML = "";
      if (teacherTypeOverride) {
        teacherTypeOverride.value = "multiple";
        teacherTypeOverride.disabled = true;
      }
      if (teacherUserAnswer) teacherUserAnswer.value = "";
      renderSupportPreview();
      renderSuggestedSupport();
      renderSourcePackSummary();
      updateQuestionNavigation();
      return;
    }

    const statusInfo = getStatusBadge(currentQuestion.status);
    const displayType = getQuestionDisplayType(currentQuestion);
    if (teacherTypeOverride) {
      teacherTypeOverride.disabled = false;
      teacherTypeOverride.value = displayType;
    }
    const metaParts = [
      activeDoc?.name || t("teacher.questionPack", {}, "Question Pack"),
      t("teacher.questionLabel", { id: currentQuestion.id }, `Question ${currentQuestion.id}`),
      getQuestionTypeLabel(displayType),
      statusInfo.label,
    ];
    if (currentQuestion.typeOverride && currentQuestion.originalType && currentQuestion.typeOverride !== currentQuestion.originalType) {
      metaParts.push(t("teacher.manualOverride", {}, "Manual"));
    }
    teacherQuestionMeta.textContent = metaParts.join(" | ");
    teacherCurrentTitle.textContent = displayType === "multiple" || displayType === "truefalse"
      ? t("teacher.multipleMode", {}, "Multiple-choice solution mode")
      : t("teacher.openMode", {}, "Open-ended solution mode");
    if (teacherCurrentBadges) {
      teacherCurrentBadges.innerHTML = "";

      const appendBadge = (text, className = "") => {
        if (!text) return;
        const badge = document.createElement("span");
        badge.className = `teacher-badge${className ? ` ${className}` : ""}`;
        badge.textContent = text;
        teacherCurrentBadges.appendChild(badge);
      };

      appendBadge(getQuestionTypeLabel(displayType));
      appendBadge(statusInfo.label, `status-${statusInfo.safeStatus}`);
      if (activeDoc) appendBadge(`${t("teacher.sourceType", {}, "Source type")}: ${getSupportTypeLabel(activeDoc)}`, "source");
      const confidenceInfo = getDocumentConfidenceInfo(activeDoc);
      if (confidenceInfo) {
        appendBadge(`${t("teacher.parseConfidence", {}, "Parse confidence")}: ${confidenceInfo.label}`, confidenceInfo.className);
      }
      if (currentQuestion.typeOverride && currentQuestion.originalType && currentQuestion.typeOverride !== currentQuestion.originalType) {
        appendBadge(t("teacher.manualOverride", {}, "Manual"), "override");
      }
      if (Array.isArray(currentQuestion.options) && currentQuestion.options.length) {
        appendBadge(t("teacher.optionCount", { count: currentQuestion.options.length }, `${currentQuestion.options.length} options`));
      }
    }
    teacherQuestionText.textContent = currentQuestion.prompt;
    teacherQuestionOptions.innerHTML = "";

    if (displayType !== "classic") {
      (currentQuestion.options || []).forEach((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "teacher-option";
        item.textContent = option;
        item.addEventListener("click", () => {
          if (teacherUserAnswer) teacherUserAnswer.value = option;
        });
        teacherQuestionOptions.appendChild(item);
      });
    }
    renderSupportPreview();
    renderSuggestedSupport();
    renderSourcePackSummary();
    updateQuestionNavigation();
  }

  function renderFeedback(markdown) {
    if (!teacherFeedback) return;
    const html = typeof window.renderMarkdown === "function"
      ? window.renderMarkdown(markdown || "")
      : (markdown || "");
    teacherFeedback.innerHTML = html || `<p class="teacher-helper-text">${t("teacher.feedbackEmpty", {}, "Teaching output and answer feedback will appear here.")}</p>`;
  }

  function getFilteredMistakes() {
    const activeDocumentId = teacherDocumentSelect?.value || "";
    return mistakeBook.filter((item) => !activeDocumentId || item.documentId === activeDocumentId);
  }

  async function buildRecoveryQuiz(entryIds = []) {
    const sessionId = window.currentSessionId;
    if (!sessionId) return;
    const res = await fetch("/api/mistake-book/recovery-quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        entryIds,
        documentId: teacherDocumentSelect?.value || "",
        supportDocumentIds: getSelectedSupportIds(),
        language: getCurrentLanguage(),
        preset: getCurrentPreset(),
        citationMode: "inline",
      }),
    });
    const data = await readJsonResponse(res);
    if (window.quizModule?.loadGeneratedQuiz) {
      window.quizModule.loadGeneratedQuiz({
        title: data.title || t("teacher.recoveryQuizTitle", {}, "Mistake Recovery Quiz"),
        questions: data.questions || [],
        type: "mixed",
        language: data.language || getCurrentLanguage(),
        questionSource: false,
        supportDocumentIds: getSelectedSupportIds(),
      });
      if (window.switchTab) window.switchTab("quiz");
      if (window.showToast) window.showToast(t("teacher.recoveryQuizReady", {}, "Recovery quiz is ready."), "success");
    }
  }

  async function buildRecoveryCards(entryIds = []) {
    const sessionId = window.currentSessionId;
    if (!sessionId) return;
    const res = await fetch("/api/mistake-book/recovery-flashcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        entryIds,
        documentId: teacherDocumentSelect?.value || "",
        supportDocumentIds: getSelectedSupportIds(),
        language: getCurrentLanguage(),
        preset: getCurrentPreset(),
        citationMode: "inline",
      }),
    });
    const data = await readJsonResponse(res);
    if (window.flashcardModule?.createDeckFromCards) {
      window.flashcardModule.createDeckFromCards(
        data.title || t("teacher.recoveryCardsTitle", {}, "Mistake Recovery Cards"),
        data.cards || [],
        {
          serverDeckId: data.deckId || "",
          language: data.language || getCurrentLanguage(),
        }
      );
      if (window.switchTab) window.switchTab("flashcard");
      if (window.showToast) window.showToast(t("teacher.recoveryCardsReady", {}, "Recovery cards are ready."), "success");
    }
  }

  function renderMistakeBook() {
    if (!teacherMistakeList) return;
    const filtered = getFilteredMistakes();

    teacherMistakeList.innerHTML = "";
    if (teacherMistakeCounter) teacherMistakeCounter.textContent = t("teacher.recordCount", { count: filtered.length }, `${filtered.length} records`);

    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "teacher-helper-text";
      empty.textContent = t("teacher.mistakeEmpty", {}, "Wrong or incomplete answers will accumulate here.");
      teacherMistakeList.appendChild(empty);
      return;
    }

    filtered.forEach((item) => {
      const card = document.createElement("div");
      card.className = "teacher-mistake-item";

      const title = document.createElement("strong");
      title.textContent = item.question;

      const meta = document.createElement("div");
      meta.className = "teacher-badge-row";
      const cat = document.createElement("span");
      cat.className = "teacher-badge";
      cat.textContent = item.category || "general";
      const type = document.createElement("span");
      type.className = "teacher-badge";
      type.textContent = item.questionType || "multiple";
      meta.appendChild(cat);
      meta.appendChild(type);

      const note = document.createElement("small");
      note.textContent = `${t("teacher.yourAnswer", {}, "Your answer")}: ${item.userAnswer || "-"} | ${t("teacher.correctAnswer", {}, "Correct answer")}: ${item.correctAnswer || "-"}${item.citation ? ` | ${item.citation}` : ""}`;

      const actions = document.createElement("div");
      actions.className = "teacher-mistake-actions";
      actions.style.marginTop = "10px";

      const quizBtn = document.createElement("button");
      quizBtn.type = "button";
      quizBtn.className = "teacher-inline-btn";
      quizBtn.textContent = "Mini Quiz";
      quizBtn.addEventListener("click", () => buildRecoveryQuiz([item.id]));

      const cardsBtn = document.createElement("button");
      cardsBtn.type = "button";
      cardsBtn.className = "teacher-inline-btn";
      cardsBtn.textContent = "Recovery Cards";
      cardsBtn.addEventListener("click", () => buildRecoveryCards([item.id]));

      actions.appendChild(quizBtn);
      actions.appendChild(cardsBtn);
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(note);
      card.appendChild(actions);
      teacherMistakeList.appendChild(card);
    });
  }

  async function loadTeacherQuestions(documentId) {
    const sessionId = window.currentSessionId;
    if (!sessionId || !documentId) {
      currentQuestions = [];
      currentQuestion = null;
      renderQuestionList();
      renderCurrentQuestion();
      renderSummary(questionDocuments.find((doc) => doc.id === documentId) || null, null);
      return;
    }

    const res = await fetch(`/api/session/${sessionId}/document/${documentId}/questions`);
    const data = await readJsonResponse(res);
    currentQuestions = Array.isArray(data.questions) ? data.questions : [];
    currentQuestion = currentQuestions.find((item) => item.id === currentQuestion?.id) || currentQuestions[0] || null;
    syncCurrentQuestionToVisibleList();
    renderSummary(questionDocuments.find((doc) => doc.id === documentId) || null, data.summary || null);
    renderQuestionList();
    renderCurrentQuestion();
  }

  async function refresh(preferredDocumentId = "") {
    try {
      const snapshot = await fetchSessionSnapshot();
      indexedDocuments = (snapshot.documents || []).filter((doc) => doc.indexed);
      questionDocuments = indexedDocuments.filter((doc) => doc.questionSource);
      mistakeBook = Array.isArray(snapshot.generated?.mistakeBook) ? snapshot.generated.mistakeBook : [];

      fillSelectOptions(
        teacherDocumentSelect,
        questionDocuments.map((doc) => ({ value: doc.id, label: `[Q] ${doc.name}` })),
        questionDocuments.length ? t("teacher.questionPack", {}, "Question Pack") : t("teacher.questionPackNone", {}, "No question source")
      );

      const nextValue = questionDocuments.some((doc) => doc.id === preferredDocumentId)
        ? preferredDocumentId
        : (teacherDocumentSelect?.value && questionDocuments.some((doc) => doc.id === teacherDocumentSelect.value)
          ? teacherDocumentSelect.value
          : "");
      if (teacherDocumentSelect) teacherDocumentSelect.value = nextValue;

      renderSupportDocs(nextValue);
      renderSummary(questionDocuments.find((doc) => doc.id === nextValue) || null, null);
      renderMistakeBook();
      await loadTeacherQuestions(nextValue);
      syncCurrentQuestionToVisibleList();
    } catch (error) {
      currentQuestions = [];
      currentQuestion = null;
      renderQuestionList();
      renderCurrentQuestion();
      renderFeedback([t("teacher.loadFailed", {}, "Teacher Questions could not be loaded."), error.message || ""].filter(Boolean).join("\n\n"));
    }
  }

  function selectQuestion(questionId) {
    currentQuestion = currentQuestions.find((item) => Number(item.id) === Number(questionId)) || null;
    renderQuestionList();
    renderCurrentQuestion();
    renderFeedback(t("teacher.selectedHint", {}, "This question is selected. You can ask for teaching first or check your own answer directly."));
    requestAnimationFrame(() => {
      const active = teacherQuestionList?.querySelector(".teacher-question-item.active");
      active?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function moveQuestion(step) {
    const visibleQuestions = getVisibleQuestions();
    const currentIndex = getCurrentQuestionIndex();
    if (currentIndex < 0) return;
    const target = visibleQuestions[currentIndex + step];
    if (target) selectQuestion(target.id);
  }

  function goToNextOpenQuestion() {
    const visibleQuestions = getVisibleQuestions();
    const currentIndex = getCurrentQuestionIndex();
    const nextOpen = visibleQuestions.find((item, index) => index > currentIndex && item.status !== "solved");
    if (nextOpen) {
      selectQuestion(nextOpen.id);
      return;
    }
    if (window.showToast) window.showToast(t("teacher.noOpenLeft", {}, "There is no next open question."), "success");
  }

  function goToNextWrongQuestion() {
    const visibleQuestions = getVisibleQuestions();
    const currentIndex = getCurrentQuestionIndex();
    const nextWrong = visibleQuestions.find((item, index) => index > currentIndex && item.status === "wrong");
    if (nextWrong) {
      selectQuestion(nextWrong.id);
      return;
    }
    if (window.showToast) window.showToast(t("teacher.noWrongLeft", {}, "There is no next wrong question."), "success");
  }

  async function teachCurrentQuestion() {
    const sessionId = window.currentSessionId;
    const documentId = teacherDocumentSelect?.value || "";
    if (!sessionId || !documentId || !currentQuestion) {
      if (window.showToast) window.showToast(t("teacher.selectPackFirst", {}, "Select a question pack and a question first."), "error");
      return;
    }

    teacherTeachBtn.disabled = true;
    teacherTeachBtn.textContent = t("teacher.teaching", {}, "Teaching...");
    renderFeedback(t("teacher.loadingTeach", {}, "Question source is being read, support context is being prepared, and AI is building the explanation..."));

    try {
      const res = await fetch("/api/teacher-questions/teach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          documentId,
          questionId: currentQuestion.id,
          supportDocumentIds: getSelectedSupportIds(),
          language: getCurrentLanguage(),
          preset: getCurrentPreset(),
          citationMode: "inline",
        }),
      });
      const data = await readJsonResponse(res);
      renderFeedback(data.explanation || "");
      await refresh(documentId);
      currentQuestion = currentQuestions.find((item) => Number(item.id) === Number(data.question?.id || currentQuestion.id)) || currentQuestion;
      renderQuestionList();
      renderCurrentQuestion();
    } catch (error) {
      renderFeedback([t("teacher.teachFailed", {}, "Teaching explanation could not be generated."), error.message || ""].filter(Boolean).join("\n\n"));
      if (window.showToast) window.showToast(error.message || t("teacher.teachFailed", {}, "Teaching explanation could not be generated."), "error");
    } finally {
      teacherTeachBtn.disabled = false;
      teacherTeachBtn.textContent = t("teacher.teach", {}, "Teach This Question");
    }
  }

  async function checkCurrentQuestion() {
    const sessionId = window.currentSessionId;
    const documentId = teacherDocumentSelect?.value || "";
    const userAnswer = (teacherUserAnswer?.value || "").trim();
    if (!sessionId || !documentId || !currentQuestion) {
      if (window.showToast) window.showToast(t("teacher.selectPackFirst", {}, "Select a question pack and a question first."), "error");
      return;
    }
    if (!userAnswer) {
      if (window.showToast) window.showToast(t("teacher.answerRequired", {}, "Write your answer before checking."), "error");
      return;
    }

    teacherCheckBtn.disabled = true;
    teacherCheckBtn.textContent = t("teacher.checking", {}, "Checking...");
    renderFeedback(t("teacher.loadingCheck", {}, "Your answer is being compared, the support context is being checked, and AI is preparing detailed feedback..."));

    try {
      const currentQuestionId = currentQuestion.id;
      const res = await fetch("/api/teacher-questions/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          documentId,
          questionId: currentQuestion.id,
          userAnswer,
          supportDocumentIds: getSelectedSupportIds(),
          language: getCurrentLanguage(),
          preset: getCurrentPreset(),
          citationMode: "inline",
        }),
      });
      const data = await readJsonResponse(res);

      const evaluation = data.evaluation || {};
      const markdown = [
        `### ${evaluation.isCorrect ? t("teacher.correctState", {}, "Correct") : t("teacher.needsWorkState", {}, "Needs Work")}`,
        evaluation.feedback || "",
        evaluation.correctAnswer ? `**${t("teacher.correctAnswer", {}, "Correct answer")}:** ${evaluation.correctAnswer}` : "",
        evaluation.teachingExplanation || "",
        evaluation.citation ? `${t("teacher.citation", {}, "Citation")}: ${evaluation.citation}` : "",
        !evaluation.isCorrect
          ? t("teacher.recoveryHint", {}, "This question was added to Mistake Book. If you want extra pressure, use Teach This Question again, jump with Next Wrong, or generate Recovery Cards / Mini Quiz from the bottom panel.")
          : "",
      ].filter(Boolean).join("\n\n");
      renderFeedback(markdown);

      await refresh(documentId);
      currentQuestion = currentQuestions.find((item) => Number(item.id) === Number(currentQuestionId)) || currentQuestion;
      renderQuestionList();
      renderCurrentQuestion();
    } catch (error) {
      renderFeedback([t("teacher.checkFailed", {}, "Answer could not be checked."), error.message || ""].filter(Boolean).join("\n\n"));
      if (window.showToast) window.showToast(error.message || t("teacher.checkFailed", {}, "Answer could not be checked."), "error");
    } finally {
      teacherCheckBtn.disabled = false;
      teacherCheckBtn.textContent = t("teacher.check", {}, "Check My Answer");
    }
  }

  async function updateQuestionTypeOverride(nextType) {
    const sessionId = window.currentSessionId;
    const documentId = teacherDocumentSelect?.value || "";
    if (!sessionId || !documentId || !currentQuestion) return;

    const previousType = getQuestionDisplayType(currentQuestion);
    if (nextType === previousType) return;

    if (teacherTypeOverride) teacherTypeOverride.disabled = true;
    try {
      const res = await fetch("/api/teacher-questions/type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          documentId,
          questionId: currentQuestion.id,
          type: nextType,
        }),
      });
      const data = await readJsonResponse(res);
      currentQuestion = {
        ...currentQuestion,
        type: data.question?.type || nextType,
        typeOverride: data.question?.typeOverride || nextType,
      };
      const idx = currentQuestions.findIndex((item) => Number(item.id) === Number(currentQuestion.id));
      if (idx >= 0) {
        currentQuestions[idx] = {
          ...currentQuestions[idx],
          type: currentQuestion.type,
          typeOverride: currentQuestion.typeOverride,
        };
      }
      renderSummary(questionDocuments.find((doc) => doc.id === documentId) || null, null);
      renderQuestionList();
      renderCurrentQuestion();
      renderFeedback(t("teacher.typeUpdated", {}, "Question type updated. If the parser was wrong, the teaching flow will now follow your correction."));
      if (window.showToast) window.showToast(t("teacher.typeUpdatedShort", {}, "Question type updated."), "success");
    } catch (error) {
      if (teacherTypeOverride) teacherTypeOverride.value = previousType;
      if (window.showToast) window.showToast(error.message || t("teacher.typeUpdateFailed", {}, "Question type could not be updated."), "error");
    } finally {
      if (teacherTypeOverride) teacherTypeOverride.disabled = false;
    }
  }

  function openQuestionUpload() {
    const fileInput = document.getElementById("fileInput") || document.getElementById("studyFileInput");
    if (fileInput) fileInput.click();
  }

  if (teacherDocumentSelect) {
    teacherDocumentSelect.addEventListener("change", async () => {
      const documentId = teacherDocumentSelect.value;
      renderSupportDocs(documentId);
      renderSummary(questionDocuments.find((doc) => doc.id === documentId) || null, null);
      await loadTeacherQuestions(documentId);
      renderMistakeBook();
      renderFeedback(t("teacher.packUpdated", {}, "Question pack updated. Pick a question to continue."));
    });
  }

  if (teacherSupportDocs) {
    teacherSupportDocs.addEventListener("change", () => {
      syncSupportChecklistSelection(getSelectedSupportIds());
      updateSupportCount(getSelectedSupportIds().length, getSupportOptionCount());
      renderSupportPreview();
      renderSuggestedSupport();
      renderSourcePackSummary();
    });
  }

  if (teacherUploadBtn) teacherUploadBtn.addEventListener("click", openQuestionUpload);
  if (teacherSelectAllSupportBtn) {
    teacherSelectAllSupportBtn.addEventListener("click", () => {
      const ids = indexedDocuments
        .filter((doc) => doc.id !== (teacherDocumentSelect?.value || ""))
        .map((doc) => doc.id);
      setSupportSelection(ids);
    });
  }
  if (teacherClearSupportBtn) {
    teacherClearSupportBtn.addEventListener("click", () => setSupportSelection([]));
  }
  if (teacherMistakeQuizBtn) {
    teacherMistakeQuizBtn.addEventListener("click", () => buildRecoveryQuiz(getFilteredMistakes().map((item) => item.id)));
  }
  if (teacherMistakeDeckBtn) {
    teacherMistakeDeckBtn.addEventListener("click", () => buildRecoveryCards(getFilteredMistakes().map((item) => item.id)));
  }
  if (teacherPrevQuestionBtn) teacherPrevQuestionBtn.addEventListener("click", () => moveQuestion(-1));
  if (teacherNextQuestionBtn) teacherNextQuestionBtn.addEventListener("click", () => moveQuestion(1));
  if (teacherNextOpenBtn) teacherNextOpenBtn.addEventListener("click", goToNextOpenQuestion);
  if (teacherNextWrongBtn) teacherNextWrongBtn.addEventListener("click", goToNextWrongQuestion);
  if (teacherTeachBtn) teacherTeachBtn.addEventListener("click", teachCurrentQuestion);
  if (teacherCheckBtn) teacherCheckBtn.addEventListener("click", checkCurrentQuestion);
  if (teacherTypeOverride) {
    teacherTypeOverride.addEventListener("change", (event) => {
      updateQuestionTypeOverride(String(event.target.value || "multiple"));
    });
  }
  if (teacherQuestionSearch) {
    teacherQuestionSearch.addEventListener("input", (event) => {
      teacherSearchTerm = String(event.target.value || "");
      syncCurrentQuestionToVisibleList();
      renderQuestionList();
      renderCurrentQuestion();
    });
  }
  if (teacherStatusFilterSelect) {
    teacherStatusFilterSelect.addEventListener("change", (event) => {
      teacherStatusFilter = String(event.target.value || "all");
      syncCurrentQuestionToVisibleList();
      renderQuestionList();
      renderCurrentQuestion();
    });
  }
  if (teacherSortModeSelect) {
    teacherSortModeSelect.addEventListener("change", (event) => {
      teacherSortMode = String(event.target.value || "order");
      syncCurrentQuestionToVisibleList();
      renderQuestionList();
      renderCurrentQuestion();
    });
  }

  document.addEventListener("keydown", (event) => {
    const teacherPanel = document.getElementById("panelTeacher");
    if (!teacherPanel?.classList.contains("active")) return;
    const tag = String(document.activeElement?.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveQuestion(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      moveQuestion(1);
    }
  });

  window.addEventListener("documents:updated", (event) => {
    const preferredDocumentId = event?.detail?.questionSource ? event.detail.documentId : "";
    refresh(preferredDocumentId);
  });

  document.addEventListener("uiLocaleChange", () => {
    applyLocale();
    renderSummary(questionDocuments.find((doc) => doc.id === (teacherDocumentSelect?.value || "")) || null, null);
    renderSupportPreview();
    renderSuggestedSupport();
    renderQuestionList();
    renderCurrentQuestion();
    renderMistakeBook();
  });

  document.addEventListener("tabChange", (event) => {
    if (event?.detail === "teacher") refresh();
  });

  applyLocale();
  refresh();
  window.teacherQuestionsModule = { refresh, selectQuestion, buildRecoveryQuiz, buildRecoveryCards };
})();


