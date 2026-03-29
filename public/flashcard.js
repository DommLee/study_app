// ============================================================
// OmniTutor v3 — Flashcard Module
// ============================================================
(function () {
  let decks = JSON.parse(localStorage.getItem("ot_decks") || "{}");
  let currentDeck = null;
  let currentIndex = 0;
  let flipped = false;

  const deckList = document.getElementById("deckList");
  const cardFront = document.getElementById("cardFront");
  const cardBack = document.getElementById("cardBack");
  const cardEl = document.getElementById("flashCard");
  const cardCounter = document.getElementById("cardCounter");
  const noDeckMsg = document.getElementById("noDeckMsg");
  const cardView = document.getElementById("cardView");
  const flashDocumentSelect = document.getElementById("flashDocumentSelect");
  const flashTopicSelect = document.getElementById("flashTopicSelect");
  const flashTopicInput = document.getElementById("flashTopic");
  const flashSupportDocs = document.getElementById("flashSupportDocs");
  const flashSupportChecklist = document.getElementById("flashSupportChecklist");
  const flashSourceHint = document.getElementById("flashSourceHint");
  const flashSourceMeta = document.getElementById("flashSourceMeta");
  const flashSourcePreview = document.getElementById("flashSourcePreview");
  const flashSourceChips = document.getElementById("flashSourceChips");
  const flashStatusLine = document.getElementById("flashStatusLine");
  let indexedDocuments = [];

  function t(key, params = {}, fallback = "") {
    return window.i18n?.t(key, params, fallback) || fallback || key;
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

  async function fetchIndexedDocuments() {
    const sessionId = window.currentSessionId;
    if (!sessionId) return [];

    const res = await fetch(`/api/session/${sessionId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);
    return (data.documents || []).filter((doc) => doc.indexed);
  }

  function getDocumentLabel(doc) {
    if (!doc) return "";
    return `${doc.questionSource ? "[Q] " : ""}${doc.name}`;
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

  function syncSupportChecklistSelection(selectedIds = []) {
    if (!flashSupportChecklist) return;
    const allowed = new Set(selectedIds);
    flashSupportChecklist.querySelectorAll("input[type='checkbox'][data-support-id]").forEach((input) => {
      input.checked = allowed.has(input.dataset.supportId);
    });
  }

  function renderSupportChecklist(items = [], selectedValues = []) {
    if (!flashSupportChecklist) return;
    flashSupportChecklist.innerHTML = "";

    if (!items.length) {
      flashSupportChecklist.classList.add("empty");
      flashSupportChecklist.textContent = t("flash.noSupport", {}, "No support sources");
      return;
    }

    flashSupportChecklist.classList.remove("empty");
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
        Array.from(flashSupportDocs.options).forEach((option) => {
          option.selected = next.includes(option.value);
        });
        syncSupportChecklistSelection(next);
        renderFlashSourcePreview();
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
      flashSupportChecklist.appendChild(row);
    });
  }

  function getSelectedSupportIds() {
    if (!flashSupportDocs || flashSupportDocs.disabled) return [];
    return Array.from(flashSupportDocs.selectedOptions)
      .map((option) => option.value)
      .filter(Boolean);
  }

  function renderSupportDocs(activeDocumentId) {
    if (!flashSupportDocs) return;
    const supportDocs = indexedDocuments.filter((doc) => doc.id !== activeDocumentId);
    const activeDoc = indexedDocuments.find((doc) => doc.id === activeDocumentId);
    const existingSelection = getSelectedSupportIds().filter((id) => supportDocs.some((doc) => doc.id === id));
    const selectedValues = existingSelection.length
      ? existingSelection
      : (activeDoc?.questionSource ? supportDocs.map((doc) => doc.id) : []);

    flashSupportDocs.innerHTML = "";
    if (!supportDocs.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("flash.noSupport", {}, "No support sources");
      flashSupportDocs.appendChild(option);
      flashSupportDocs.disabled = true;
      renderSupportChecklist([], []);
    } else {
      flashSupportDocs.disabled = false;
      supportDocs.forEach((doc) => {
        const option = document.createElement("option");
        option.value = doc.id;
        option.textContent = getDocumentLabel(doc);
        option.selected = selectedValues.includes(doc.id);
        flashSupportDocs.appendChild(option);
      });
      renderSupportChecklist(
        supportDocs.map((doc) => ({ value: doc.id, label: getDocumentLabel(doc), typeLabel: getSupportTypeLabel(doc) })),
        selectedValues
      );
    }

    if (flashSourceHint) {
      flashSourceHint.textContent = activeDoc?.questionSource
        ? t("flash.teacherHint", {}, "Teacher question pack selected. Cards will teach the logic behind those questions and use the selected support sources.")
        : t("flash.sourceHint", {}, "Cards follow the topic flow of the selected document. If you choose teacher questions, they become logic-building recovery cards.");
    }
    renderFlashSourcePreview();
  }

  function renderFlashSourcePreview() {
    if (!flashSourceMeta || !flashSourcePreview || !flashSourceChips) return;
    const activeDoc = indexedDocuments.find((doc) => doc.id === (flashDocumentSelect?.value || "")) || null;
    const supportDocs = getSelectedSupportIds()
      .map((id) => indexedDocuments.find((doc) => doc.id === id))
      .filter(Boolean);
    const topic = (flashTopicInput?.value || flashTopicSelect?.value || "").trim();
    const count = document.getElementById("flashCount")?.value || "10";
    const language = window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR";

    flashSourceChips.innerHTML = "";

    if (!activeDoc) {
      flashSourceMeta.textContent = t("flash.previewMetaEmpty", {}, "No source selected");
      flashSourcePreview.textContent = t(
        "flash.previewEmpty",
        {},
        "Choose the source that should drive the deck. Teacher question packs create recovery cards; regular notes create concept cards."
      );
      if (flashStatusLine) flashStatusLine.textContent = "";
      return;
    }

    flashSourceMeta.textContent = activeDoc.questionSource
      ? t("flash.previewMetaTeacher", {}, "Teacher recovery source")
      : t("flash.previewMetaStudy", {}, "Study note source");
    flashSourcePreview.textContent = activeDoc.questionSource
      ? t(
          "flash.previewTeacher",
          { count, language },
          `This deck will focus on the logic behind the teacher questions in this pack. Cards: ${count}. Language: ${language}.`
        )
      : t(
          "flash.previewStudy",
          { topic: topic || t("flash.allTopics", {}, "Automatic / all topics"), count, language },
          `Deck source: ${activeDoc.name}. Topic: ${topic || "automatic / all topics"}. Cards: ${count}. Language: ${language}.`
        );

    const mainChip = document.createElement("span");
    mainChip.className = "source-chip";
    mainChip.textContent = `${activeDoc.questionSource ? "[Q]" : "[" + getSupportTypeLabel(activeDoc) + "]"} ${activeDoc.name}`;
    flashSourceChips.appendChild(mainChip);

    if (topic) {
      const topicChip = document.createElement("span");
      topicChip.className = "source-chip";
      topicChip.textContent = topic;
      flashSourceChips.appendChild(topicChip);
    }

    const settingsChip = document.createElement("span");
    settingsChip.className = "source-chip muted";
    settingsChip.textContent = `${count} cards • ${language}`;
    flashSourceChips.appendChild(settingsChip);

    supportDocs.forEach((doc) => {
      const chip = document.createElement("span");
      chip.className = "source-chip muted";
      chip.textContent = `${getSupportTypeLabel(doc)} ${doc.name}`;
      flashSourceChips.appendChild(chip);
    });
  }

  async function loadFlashTopics(documentId = "") {
    const sessionId = window.currentSessionId;
    if (!flashTopicSelect) return;

    if (!sessionId) {
      fillSelectOptions(flashTopicSelect, [], t("flash.sessionPreparing", {}, "Session preparing..."));
      return;
    }

    fillSelectOptions(flashTopicSelect, [], t("flash.topicsLoading", {}, "Topics are loading..."));

    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, documentId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);

      const topics = Array.isArray(data.topics) ? data.topics : [];
      fillSelectOptions(
        flashTopicSelect,
        topics.map((topic) => ({ value: topic, label: topic })),
        topics.length ? t("flash.allTopics", {}, "Automatic / all topics") : t("flash.noTopic", {}, "No topics found")
      );
    } catch (error) {
      fillSelectOptions(flashTopicSelect, [], t("flash.topicsFailed", {}, "Topic list could not be loaded"));
      if (window.showToast) window.showToast(t("flash.topicsFailedToast", {}, "Flashcard topic list could not be loaded") + ": " + error.message, "error");
    }
  }

  async function loadFlashSources(preferredDocumentId = "") {
    if (!flashDocumentSelect) return;

    try {
      const docs = await fetchIndexedDocuments();
      indexedDocuments = docs;
      fillSelectOptions(
        flashDocumentSelect,
        docs.map((doc) => ({ value: doc.id, label: getDocumentLabel(doc) })),
        docs.length ? t("flash.allDocuments", {}, "All indexed documents") : t("flash.noIndexed", {}, "No indexed documents")
      );

      if (!docs.length) {
        fillSelectOptions(flashTopicSelect, [], t("flash.uploadFirst", {}, "Upload a document first"));
        renderSupportDocs("");
        return;
      }

      const nextValue = docs.some((doc) => doc.id === preferredDocumentId)
        ? preferredDocumentId
        : "";
      flashDocumentSelect.value = nextValue;
      renderSupportDocs(nextValue);
      await loadFlashTopics(nextValue);
    } catch (error) {
      fillSelectOptions(flashDocumentSelect, [], t("flash.documentsFailed", {}, "Documents could not be loaded"));
      fillSelectOptions(flashTopicSelect, [], t("flash.topicsFailed", {}, "Topic list could not be loaded"));
      renderSupportDocs("");
    }
  }

  function saveDecks() {
    localStorage.setItem("ot_decks", JSON.stringify(decks));
  }

  function syncReviewGrade(deckName, cardId, grade) {
    const sessionId = window.currentSessionId;
    const deck = decks[deckName];
    if (!sessionId || !deck?.serverDeckId || !cardId) return;
    fetch("/api/review-grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        deckId: deck.serverDeckId,
        cardId,
        grade,
      }),
    })
      .then((res) => res.json())
      .then(() => {
        if (window.progressModule) window.progressModule.refresh();
      })
      .catch(() => {});
  }

  function renderDeckList() {
    if (!deckList) return;
    deckList.innerHTML = "";

    const names = Object.keys(decks);
    if (names.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:var(--text-muted);font-size:12px;text-align:center;padding:8px";
      empty.textContent = t("flash.noDecks", {}, "No decks yet");
      deckList.appendChild(empty);
      return;
    }

    names.forEach((name) => {
      const d = decks[name];
      const div = document.createElement("div");
      div.className = "deck-item";

      const title = document.createElement("span");
      title.className = "deck-name";
      title.textContent = `📚 ${name} `;

      const small = document.createElement("small");
      small.style.color = "var(--text-muted)";
      small.textContent = `(${(d.cards || []).length} kart)`;
      title.appendChild(small);

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px";

      const openBtn = document.createElement("button");
      openBtn.className = "btn-sm btn-primary";
      openBtn.textContent = t("flash.open", {}, "Open");
      openBtn.addEventListener("click", () => loadDeck(name));

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-sm btn-danger";
      deleteBtn.textContent = t("flash.delete", {}, "Delete");
      deleteBtn.addEventListener("click", () => deleteDeck(name));

      actions.appendChild(openBtn);
      actions.appendChild(deleteBtn);
      div.appendChild(title);
      div.appendChild(actions);
      deckList.appendChild(div);
    });
  }

  function loadDeck(name) {
    currentDeck = name;
    currentIndex = 0;
    flipped = false;
    showCard();
    if (noDeckMsg) noDeckMsg.style.display = "none";
    if (cardView) cardView.style.display = "flex";
    renderDeckList();
  }

  function deleteDeck(name) {
    if (!confirm(t("flash.deleteConfirm", {}, `Delete deck "{name}"?`).replace("{name}", name))) return;
    delete decks[name];
    saveDecks();
    if (currentDeck === name) {
      currentDeck = null;
      if (noDeckMsg) {
        noDeckMsg.style.display = "block";
        noDeckMsg.textContent = t("flash.empty", {}, noDeckMsg.textContent);
      }
      if (cardView) cardView.style.display = "none";
    }
    renderDeckList();
  }

  function showCard() {
    if (!currentDeck || !decks[currentDeck]) return;
    const cards = decks[currentDeck].cards || [];
    if (cards.length === 0) return;

    const card = cards[currentIndex];
    flipped = false;
    if (cardEl) cardEl.classList.remove("flipped");
    if (cardFront) cardFront.textContent = card.front || "";
    if (cardBack) cardBack.textContent = card.back || "";
    if (cardCounter) cardCounter.textContent = `${currentIndex + 1} / ${cards.length}`;
  }

  function flip() {
    flipped = !flipped;
    if (cardEl) cardEl.classList.toggle("flipped", flipped);
  }

  function next() {
    if (!currentDeck || !decks[currentDeck]) return;
    const cards = decks[currentDeck].cards || [];
    if (!cards.length) return;
    currentIndex = (currentIndex + 1) % cards.length;
    showCard();
  }

  function prev() {
    if (!currentDeck || !decks[currentDeck]) return;
    const cards = decks[currentDeck].cards || [];
    if (!cards.length) return;
    currentIndex = (currentIndex - 1 + cards.length) % cards.length;
    showCard();
  }

  function markEasy() {
    if (!currentDeck || !decks[currentDeck]) return;
    const cards = decks[currentDeck].cards || [];
    if (!cards.length) return;
    const card = cards[currentIndex];
    card.easeFactor = (card.easeFactor || 2) + 0.1;
    card.interval = Math.round((card.interval || 1) * card.easeFactor);
    card.dueDate = Date.now() + card.interval * 86400000;
    saveDecks();
    syncReviewGrade(currentDeck, card.id, "easy");
    next();
    if (window.showToast) window.showToast(t("flash.easyToast", {}, "Easy — the next review was scheduled"), "success");
  }

  function markHard() {
    if (!currentDeck || !decks[currentDeck]) return;
    const cards = decks[currentDeck].cards || [];
    if (!cards.length) return;
    const card = cards[currentIndex];
    card.easeFactor = Math.max(1.3, (card.easeFactor || 2) - 0.2);
    card.interval = 1;
    card.dueDate = Date.now() + 86400000;
    saveDecks();
    syncReviewGrade(currentDeck, card.id, "hard");
    next();
    if (window.showToast) window.showToast(t("flash.hardToast", {}, "Hard — this card will be shown again tomorrow"), "success");
  }


  function createDeckFromCards(deckName, cards, options = {}) {
    const safeName = String(deckName || `Deck ${Object.keys(decks).length + 1}`).trim();
    const normalizedCards = Array.isArray(cards)
      ? cards.map((card, index) => ({
          ...card,
          id: Number.isFinite(card?.id) ? card.id : index + 1,
          easeFactor: Number.isFinite(card?.easeFactor) ? card.easeFactor : 2,
          interval: Number.isFinite(card?.interval) ? card.interval : 1,
          dueDate: Number.isFinite(card?.dueDate) ? card.dueDate : Date.now(),
        }))
      : [];

    if (!normalizedCards.length) {
      if (window.showToast) window.showToast(t("flash.noCards", {}, "No cards found to load."), "error");
      return null;
    }

    decks[safeName] = {
      cards: normalizedCards,
      createdAt: Date.now(),
      serverDeckId: options.serverDeckId || "",
      language: options.language || (window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR"),
    };
    saveDecks();
    renderDeckList();
    loadDeck(safeName);
    return decks[safeName];
  }
  async function generateFromAI() {
    const btn = document.getElementById("genFlashBtn");
    const topic = (flashTopicInput?.value || "").trim();
    const count = parseInt(document.getElementById("flashCount").value || "10", 10);
    const sessionId = window.currentSessionId;
    const documentId = flashDocumentSelect ? flashDocumentSelect.value : "";
    const supportDocumentIds = getSelectedSupportIds();
    const language = window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR";
    const preset = window.getCurrentPromptPreset ? window.getCurrentPromptPreset() : "auto";

    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t("flash.generating", {}, "Generating...");
    if (flashStatusLine) {
      flashStatusLine.textContent = t("flash.statusBuilding", {}, "Reading the source, preparing context, and generating recovery cards...");
    }

    try {
      const res = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, topic, count, documentId, supportDocumentIds, language, preset, citationMode: "inline" }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);
      if (!Array.isArray(data.cards) || !data.cards.length) throw new Error(t("flash.generateFailed", {}, "Cards could not be generated"));

      const selectedDocLabel = flashDocumentSelect?.selectedOptions?.[0]?.textContent || "";

      const deckName = data.deckName || topic || (documentId ? `${selectedDocLabel} Kartlari` : `Kart Destesi ${Object.keys(decks).length + 1}`);
      createDeckFromCards(deckName, data.cards, {
        serverDeckId: data.deckId || "",
        language,
      });
      if (flashStatusLine) {
        flashStatusLine.textContent = t("flash.statusReady", {}, "Deck is ready.");
      }
      if (window.showToast) window.showToast(`${data.cards.length} ${t("flash.cardsCreated", {}, "cards created")}`, "success");
    } catch (e) {
      if (flashStatusLine) {
        flashStatusLine.textContent = t("flash.statusFailed", {}, "Card generation failed. Try a narrower topic, a cleaner source, or a more reliable model.");
      }
      if (window.showToast) window.showToast(t("flash.generateFailed", {}, "Cards could not be generated") + ": " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = t("flash.generateButton", {}, "Generate Cards");
    }
  }

  document.addEventListener("keydown", (e) => {
    const panel = document.getElementById("panelFlashcard");
    if (!panel || !panel.classList.contains("active")) return;
    if (e.key === " ") { e.preventDefault(); flip(); }
    if (e.key === "ArrowRight") next();
    if (e.key === "ArrowLeft") prev();
    if (e.key === "1") markEasy();
    if (e.key === "2") markHard();
  });

  if (cardEl) cardEl.addEventListener("click", flip);
  const nextBtn = document.getElementById("cardNext");
  const prevBtn = document.getElementById("cardPrev");
  const easyBtn = document.getElementById("cardEasy");
  const hardBtn = document.getElementById("cardHard");
  const genBtn = document.getElementById("genFlashBtn");
  if (flashDocumentSelect) {
    flashDocumentSelect.addEventListener("change", () => {
      renderSupportDocs(flashDocumentSelect.value);
      loadFlashTopics(flashDocumentSelect.value);
    });
  }
  if (flashTopicSelect) {
    flashTopicSelect.addEventListener("change", () => {
      if (flashTopicInput && flashTopicSelect.value) {
        flashTopicInput.value = flashTopicSelect.value;
      }
      renderFlashSourcePreview();
    });
  }
  flashTopicInput?.addEventListener("input", renderFlashSourcePreview);
  flashSupportDocs?.addEventListener("change", renderFlashSourcePreview);
  document.getElementById("flashCount")?.addEventListener("change", renderFlashSourcePreview);

  if (nextBtn) nextBtn.addEventListener("click", next);
  if (prevBtn) prevBtn.addEventListener("click", prev);
  if (easyBtn) easyBtn.addEventListener("click", markEasy);
  if (hardBtn) hardBtn.addEventListener("click", markHard);
  if (genBtn) genBtn.addEventListener("click", generateFromAI);

  window.addEventListener("documents:updated", (event) => {
    const preferredDocumentId = event?.detail?.indexed ? event.detail.documentId : "";
    loadFlashSources(preferredDocumentId);
  });

  document.addEventListener("uiLocaleChange", () => {
    renderDeckList();
    renderSupportDocs(flashDocumentSelect?.value || "");
    renderFlashSourcePreview();
    if (noDeckMsg) noDeckMsg.textContent = t("flash.empty", {}, noDeckMsg.textContent);
    if (genBtn) genBtn.textContent = t("flash.generateButton", {}, genBtn.textContent);
  });

  if (noDeckMsg) noDeckMsg.textContent = t("flash.empty", {}, noDeckMsg.textContent);
  renderDeckList();
  loadFlashSources();
  renderFlashSourcePreview();

  window.flashcardModule = { loadDeck, deleteDeck, flip, next, prev, markEasy, markHard, loadFlashSources, createDeckFromCards };
})();




