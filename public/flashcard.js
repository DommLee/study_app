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

  async function loadFlashTopics(documentId = "") {
    const sessionId = window.currentSessionId;
    if (!flashTopicSelect) return;

    fillSelectOptions(flashTopicSelect, [], "Konular yukleniyor...");

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
        topics.length ? "Otomatik / tum konular" : "Konu bulunamadi"
      );
    } catch (error) {
      fillSelectOptions(flashTopicSelect, [], "Konu listesi alinamadi");
      if (window.showToast) window.showToast("Flashcard konu listesi alinamadi: " + error.message, "error");
    }
  }

  async function loadFlashSources(preferredDocumentId = "") {
    if (!flashDocumentSelect) return;

    try {
      const docs = await fetchIndexedDocuments();
      fillSelectOptions(
        flashDocumentSelect,
        docs.map((doc) => ({ value: doc.id, label: doc.name })),
        docs.length ? "Tum indexed belgeler" : "Indexed dokuman yok"
      );

      const nextValue = docs.some((doc) => doc.id === preferredDocumentId)
        ? preferredDocumentId
        : "";
      flashDocumentSelect.value = nextValue;
      await loadFlashTopics(nextValue);
    } catch (error) {
      fillSelectOptions(flashDocumentSelect, [], "Belgeler alinamadi");
      fillSelectOptions(flashTopicSelect, [], "Konu listesi alinamadi");
    }
  }

  function saveDecks() {
    localStorage.setItem("ot_decks", JSON.stringify(decks));
  }

  function renderDeckList() {
    if (!deckList) return;
    deckList.innerHTML = "";

    const names = Object.keys(decks);
    if (names.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:var(--text-muted);font-size:12px;text-align:center;padding:8px";
      empty.textContent = "Henüz deste yok";
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
      openBtn.textContent = "Aç";
      openBtn.addEventListener("click", () => loadDeck(name));

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-sm btn-danger";
      deleteBtn.textContent = "Sil";
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
    if (!confirm(`"${name}" destesi silinsin mi?`)) return;
    delete decks[name];
    saveDecks();
    if (currentDeck === name) {
      currentDeck = null;
      if (noDeckMsg) noDeckMsg.style.display = "block";
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
    next();
    if (window.showToast) window.showToast("Kolay — bir sonraki kart planlandı", "success");
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
    next();
    if (window.showToast) window.showToast("Zor — yarın tekrar gösterilecek", "success");
  }

  async function generateFromAI() {
    const btn = document.getElementById("genFlashBtn");
    const topic = (flashTopicInput?.value || "").trim();
    const count = parseInt(document.getElementById("flashCount").value || "10", 10);
    const sessionId = window.currentSessionId;
    const documentId = flashDocumentSelect ? flashDocumentSelect.value : "";
    const language = window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR";

    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "Üretiliyor...";

    try {
      const res = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, topic, count, documentId, language }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);
      if (!Array.isArray(data.cards) || !data.cards.length) throw new Error("Kart üretilemedi");

      const selectedDocLabel = flashDocumentSelect?.selectedOptions?.[0]?.textContent || "";
      const deckName = topic || (documentId ? `${selectedDocLabel} Kartlari` : `Kart Destesi ${Object.keys(decks).length + 1}`);
      decks[deckName] = {
        cards: data.cards.map((c) => ({ ...c, easeFactor: 2, interval: 1, dueDate: Date.now() })),
        createdAt: Date.now(),
      };
      saveDecks();
      renderDeckList();
      loadDeck(deckName);
      if (window.showToast) window.showToast(`${data.cards.length} kart oluşturuldu!`, "success");
    } catch (e) {
      if (window.showToast) window.showToast("Kart üretilemedi: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "🃏 Kart Üret";
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
    flashDocumentSelect.addEventListener("change", () => loadFlashTopics(flashDocumentSelect.value));
  }
  if (flashTopicSelect) {
    flashTopicSelect.addEventListener("change", () => {
      if (flashTopicInput && flashTopicSelect.value) {
        flashTopicInput.value = flashTopicSelect.value;
      }
    });
  }

  if (nextBtn) nextBtn.addEventListener("click", next);
  if (prevBtn) prevBtn.addEventListener("click", prev);
  if (easyBtn) easyBtn.addEventListener("click", markEasy);
  if (hardBtn) hardBtn.addEventListener("click", markHard);
  if (genBtn) genBtn.addEventListener("click", generateFromAI);

  window.addEventListener("documents:updated", (event) => {
    const preferredDocumentId = event?.detail?.indexed ? event.detail.documentId : "";
    loadFlashSources(preferredDocumentId);
  });

  renderDeckList();
  loadFlashSources();

  window.flashcardModule = { loadDeck, deleteDeck, flip, next, prev, markEasy, markHard, loadFlashSources };
})();
