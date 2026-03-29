// ============================================================
// OmniTutor v3 — Quiz Module
// ============================================================
(function () {
  let questions = [];
  let currentQ = 0;
  let score = 0;
  let answers = [];
  let timerInterval = null;
  let secondsLeft = 0;
  let savedQuizzes = [];
  let indexedDocuments = [];
  let currentQuizContext = {};

  const genBtn = document.getElementById("genQuizBtn");
  const quizSetup = document.getElementById("quizSetup");
  const quizPlay = document.getElementById("quizPlay");
  const quizDone = document.getElementById("quizDone");
  const quizDocumentSelect = document.getElementById("quizDocumentSelect");
  const quizTopicSelect = document.getElementById("quizTopicSelect");
  const quizTopicInput = document.getElementById("quizTopic");
  const quizSupportDocs = document.getElementById("quizSupportDocs");
  const quizSupportChecklist = document.getElementById("quizSupportChecklist");
  const quizSavedList = document.getElementById("quizSavedList");
  const quizSourceHint = document.getElementById("quizSourceHint");
  const quizSourceMeta = document.getElementById("quizSourceMeta");
  const quizSourcePreview = document.getElementById("quizSourcePreview");
  const quizSourceChips = document.getElementById("quizSourceChips");
  const quizStatusLine = document.getElementById("quizStatusLine");

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

  function renderMultiSelect(selectEl, items, selectedValues = []) {
    if (!selectEl) return;
    selectEl.innerHTML = "";

    if (!items.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Destek dokuman yok";
      selectEl.appendChild(option);
      selectEl.disabled = true;
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
    renderSupportChecklist(items, selectedValues);
  }

  async function fetchSessionSnapshot() {
    const sessionId = window.currentSessionId;
    if (!sessionId) {
      return { documents: [], generated: { solvedQuizzes: [] } };
    }

    const res = await fetch(`/api/session/${sessionId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);
    return data;
  }

  function getDocumentLabel(doc) {
    if (!doc) return "";
    const prefix = doc.questionSource ? "[Q] " : "";
    return `${prefix}${doc.name}`;
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
    if (!quizSupportChecklist) return;
    const allowed = new Set(selectedIds);
    quizSupportChecklist.querySelectorAll("input[type='checkbox'][data-support-id]").forEach((input) => {
      input.checked = allowed.has(input.dataset.supportId);
    });
  }

  function renderSupportChecklist(items = [], selectedValues = []) {
    if (!quizSupportChecklist) return;
    quizSupportChecklist.innerHTML = "";

    if (!items.length) {
      quizSupportChecklist.classList.add("empty");
      quizSupportChecklist.textContent = t("quiz.noSupportDocs", {}, "No support sources");
      return;
    }

    quizSupportChecklist.classList.remove("empty");
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
        Array.from(quizSupportDocs.options).forEach((option) => {
          option.selected = next.includes(option.value);
        });
        syncSupportChecklistSelection(next);
        renderQuizSourcePreview();
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
      quizSupportChecklist.appendChild(row);
    });
  }

  function getSelectedSupportIds() {
    if (!quizSupportDocs || quizSupportDocs.disabled) return [];
    return Array.from(quizSupportDocs.selectedOptions)
      .map((option) => option.value)
      .filter(Boolean);
  }

  function renderSavedQuizList(items) {
    if (!quizSavedList) return;
    quizSavedList.innerHTML = "";

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "quiz-helper-text";
      empty.textContent = t("quiz.savedEmpty", {}, "Solved quizzes stay here in this session. After the first quiz, you can reopen and review them.");
      quizSavedList.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const card = document.createElement("div");
      card.className = "quiz-saved-item";

      const meta = document.createElement("div");
      meta.className = "quiz-saved-meta";

      const title = document.createElement("div");
      title.className = "quiz-saved-title";
      title.textContent = item.title || item.documentName || t("quiz.savedTitle", {}, "Solved Quiz");

      const note = document.createElement("div");
      note.className = "quiz-saved-note";
      const locale = typeof window.getCurrentUiLocale === "function" ? window.getCurrentUiLocale() : "en-US";
      const when = item.createdAt ? new Date(item.createdAt).toLocaleString(locale) : "";
      const docNote = item.documentName ? `${t("quiz.source", {}, "Source Document")}: ${item.documentName}` : t("quiz.generalPool", {}, "Source: general document pool");
      const scoreNote = `${t("quiz.score", {}, "Score")}: ${item.score || 0}/${item.total || 0} (%${item.pct || 0})`;
      note.textContent = [when, docNote, scoreNote].filter(Boolean).join(" • ");

      meta.appendChild(title);
      meta.appendChild(note);

      const actions = document.createElement("div");
      actions.className = "quiz-saved-actions";

      const openBtn = document.createElement("button");
      openBtn.textContent = t("quiz.openReview", {}, "Open Review");
      openBtn.addEventListener("click", () => openSolvedQuiz(item.id));
      actions.appendChild(openBtn);

      card.appendChild(meta);
      card.appendChild(actions);
      quizSavedList.appendChild(card);
    });
  }

  function renderSupportDocumentOptions(activeDocumentId) {
    if (!quizSupportDocs) return;
    const supportDocs = indexedDocuments.filter((doc) => doc.id !== activeDocumentId);
    const activeDoc = indexedDocuments.find((doc) => doc.id === activeDocumentId);
    const existingSelection = getSelectedSupportIds().filter((id) => supportDocs.some((doc) => doc.id === id));
    const selectedValues = existingSelection.length
      ? existingSelection
      : (activeDoc?.questionSource ? supportDocs.map((doc) => doc.id) : []);

    renderMultiSelect(
      quizSupportDocs,
      supportDocs.map((doc) => ({ value: doc.id, label: getDocumentLabel(doc), typeLabel: getSupportTypeLabel(doc) })),
      selectedValues
    );
  }

  function renderQuizSourceHint(activeDoc) {
    if (!quizSourceHint) return;
    if (activeDoc?.questionSource) {
      const typeNote = Array.isArray(activeDoc.questionSummary?.types) && activeDoc.questionSummary.types.length
        ? `Tespit edilen soru tipleri: ${activeDoc.questionSummary.types.join(", ")}.`
        : "Soru tipleri tespit edildi.";
      quizSourceHint.textContent = `${t("quiz.teacherMode", {}, "Teacher question mode is active.")} ${typeNote} ${t("quiz.teacherModeHint", {}, "If you select support sources, the system will also use them to explain the logic.")}`;
      return;
    }

    quizSourceHint.textContent = t(
      "quiz.sourceHint",
      {},
      "The quiz will follow the topic order of the selected document. If you choose a teacher question pack, the system will separate the questions and use support sources to explain the logic."
    );
  }

  function renderQuizSourcePreview() {
    if (!quizSourceMeta || !quizSourcePreview || !quizSourceChips) return;
    const activeDoc = indexedDocuments.find((doc) => doc.id === (quizDocumentSelect?.value || "")) || null;
    const supportDocs = getSelectedSupportIds()
      .map((id) => indexedDocuments.find((doc) => doc.id === id))
      .filter(Boolean);
    const topic = (quizTopicInput?.value || quizTopicSelect?.value || "").trim();
    const difficulty = document.getElementById("quizDifficulty")?.value || "medium";
    const type = document.getElementById("quizType")?.value || "multiple";
    const count = document.getElementById("quizCount")?.value || "5";
    const language = window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR";

    quizSourceChips.innerHTML = "";

    if (!activeDoc) {
      quizSourceMeta.textContent = t("quiz.previewMetaEmpty", {}, "No source selected");
      quizSourcePreview.textContent = t(
        "quiz.previewEmpty",
        {},
        "Choose the main source first. Then add optional support notes and generate a quiz that matches the selected content."
      );
      if (quizStatusLine) quizStatusLine.textContent = "";
      return;
    }

    quizSourceMeta.textContent = activeDoc.questionSource
      ? t("quiz.previewMetaTeacher", {}, "Teacher question pack")
      : t("quiz.previewMetaStudy", {}, "Study source");
    quizSourcePreview.textContent = activeDoc.questionSource
      ? t(
          "quiz.previewTeacher",
          { count, difficulty, language },
          `This quiz will reuse the teacher questions in this pack, then strengthen them with the selected support sources. Count: ${count}, difficulty: ${difficulty}, language: ${language}.`
        )
      : t(
          "quiz.previewStudy",
          { topic: topic || t("quiz.allTopics", {}, "Automatic / all topics"), count, difficulty, language },
          `Quiz source: ${activeDoc.name}. Topic: ${topic || "automatic / all topics"}. Count: ${count}, difficulty: ${difficulty}, language: ${language}.`
        );

    const mainChip = document.createElement("span");
    mainChip.className = "source-chip";
    mainChip.textContent = `${activeDoc.questionSource ? "[Q]" : "[" + getSupportTypeLabel(activeDoc) + "]"} ${activeDoc.name}`;
    quizSourceChips.appendChild(mainChip);

    if (topic) {
      const topicChip = document.createElement("span");
      topicChip.className = "source-chip";
      topicChip.textContent = topic;
      quizSourceChips.appendChild(topicChip);
    }

    const settingsChip = document.createElement("span");
    settingsChip.className = "source-chip muted";
    settingsChip.textContent = `${count} • ${difficulty} • ${type}`;
    quizSourceChips.appendChild(settingsChip);

    supportDocs.forEach((doc) => {
      const chip = document.createElement("span");
      chip.className = "source-chip muted";
      chip.textContent = `${getSupportTypeLabel(doc)} ${doc.name}`;
      quizSourceChips.appendChild(chip);
    });
  }

  async function loadQuizTopics(documentId = "") {
    const sessionId = window.currentSessionId;
    if (!quizTopicSelect) return;

    if (!sessionId) {
      fillSelectOptions(quizTopicSelect, [], t("quiz.sessionPreparing", {}, "Session preparing..."));
      return;
    }

    fillSelectOptions(quizTopicSelect, [], t("quiz.topicsLoading", {}, "Topics are loading..."));

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
        quizTopicSelect,
        topics.map((topic) => ({ value: topic, label: topic })),
        topics.length ? t("quiz.allTopics", {}, "Automatic / all topics") : t("quiz.noTopic", {}, "No topics found")
      );
    } catch (error) {
      fillSelectOptions(quizTopicSelect, [], t("quiz.topicsFailed", {}, "Topic list could not be loaded"));
      if (window.showToast) window.showToast(t("quiz.topicsFailedToast", {}, "Quiz topic list could not be loaded") + ": " + error.message, "error");
    }
  }

  async function loadQuizSources(preferredDocumentId = "") {
    if (!quizDocumentSelect) return;

    try {
      const snapshot = await fetchSessionSnapshot();
      indexedDocuments = (snapshot.documents || []).filter((doc) => doc.indexed);
      savedQuizzes = Array.isArray(snapshot.generated?.solvedQuizzes) ? snapshot.generated.solvedQuizzes : [];
      renderSavedQuizList(savedQuizzes);

      fillSelectOptions(
        quizDocumentSelect,
        indexedDocuments.map((doc) => ({ value: doc.id, label: getDocumentLabel(doc) })),
        indexedDocuments.length ? t("quiz.allDocuments", {}, "All indexed documents") : t("quiz.noIndexed", {}, "No indexed documents")
      );

      if (!indexedDocuments.length) {
        fillSelectOptions(quizTopicSelect, [], t("quiz.uploadFirst", {}, "Upload a document first"));
      renderMultiSelect(quizSupportDocs, [], []);
      renderQuizSourceHint(null);
      renderQuizSourcePreview();
      return;
      }

      const nextValue = indexedDocuments.some((doc) => doc.id === preferredDocumentId)
        ? preferredDocumentId
        : "";
      quizDocumentSelect.value = nextValue;
      renderSupportDocumentOptions(nextValue);
      renderQuizSourceHint(indexedDocuments.find((doc) => doc.id === nextValue) || null);
      renderQuizSourcePreview();
      await loadQuizTopics(nextValue);
    } catch (error) {
      fillSelectOptions(quizDocumentSelect, [], t("quiz.documentsFailed", {}, "Documents could not be loaded"));
      fillSelectOptions(quizTopicSelect, [], t("quiz.topicsFailed", {}, "Topic list could not be loaded"));
      renderMultiSelect(quizSupportDocs, [], []);
      renderQuizSourcePreview();
    }
  }

  function showSection(name) {
    [quizSetup, quizPlay, quizDone].forEach((el) => {
      if (el) el.style.display = "none";
    });
    const target = { setup: quizSetup, play: quizPlay, done: quizDone }[name];
    if (target) target.style.display = "block";
  }

  async function generateQuiz() {
    if (!genBtn) return;

    const type = document.getElementById("quizType").value;
    const count = parseInt(document.getElementById("quizCount").value || "5", 10);
    const difficulty = document.getElementById("quizDifficulty").value;
    const topic = (quizTopicInput?.value || "").trim();
    const documentId = quizDocumentSelect ? quizDocumentSelect.value : "";
    const supportDocumentIds = getSelectedSupportIds();
    const activeDoc = indexedDocuments.find((doc) => doc.id === documentId) || null;
    const sessionId = window.currentSessionId;
    const language = window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR";
    const preset = window.getCurrentPromptPreset ? window.getCurrentPromptPreset() : "auto";

    genBtn.disabled = true;
    genBtn.textContent = t("quiz.generating", {}, "Generating...");
    if (quizStatusLine) {
      quizStatusLine.textContent = t("quiz.statusBuilding", {}, "Reading source, preparing context, and generating questions...");
    }

    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          type,
          count,
          difficulty,
          topic,
          documentId,
          supportDocumentIds,
          language,
          preset,
          citationMode: "inline",
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);
      if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error(t("quiz.noQuestions", {}, "No questions were generated"));

      questions = data.questions;
      currentQ = 0;
      score = 0;
      answers = [];
      currentQuizContext = {
        documentId,
        documentName: activeDoc?.name || "",
        topic,
        difficulty,
        type: data.questionSource ? "mixed" : type,
        language,
        supportDocumentIds,
        questionSource: !!data.questionSource,
      };
      renderQuestion();
      showSection("play");
      if (quizStatusLine) {
        quizStatusLine.textContent = t("quiz.statusReady", {}, "Quiz is ready.");
      }
    } catch (e) {
      if (quizStatusLine) {
        quizStatusLine.textContent = t("quiz.statusFailed", {}, "Quiz generation failed. Try a smaller scope, a clearer source, or a more reliable model.");
      }
      if (window.showToast) window.showToast(t("quiz.failed", {}, "Quiz could not be generated") + ": " + e.message, "error");
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = t("quiz.generate", {}, "Generate Quiz");
    }
  }

  function renderQuestion() {
    const q = questions[currentQ];
    if (!q) return;

    clearInterval(timerInterval);

    const qNum = document.getElementById("qNumber");
    const qTotal = document.getElementById("qTotal");
    const qText = document.getElementById("qText");
    const opts = document.getElementById("qOptions");
    const timerEl = document.getElementById("qTimer");
    const classicInput = document.getElementById("classicAnswer");
    const progressBar = document.getElementById("quizProgress");

    if (qNum) qNum.textContent = currentQ + 1;
    if (qTotal) qTotal.textContent = questions.length;
    if (qText) qText.textContent = q.question || "";
    if (progressBar) progressBar.style.width = `${(currentQ / Math.max(questions.length, 1)) * 100}%`;

    if (opts) opts.innerHTML = "";
    if (classicInput) classicInput.style.display = "none";

    if (q.type === "multiple" || q.type === "truefalse") {
      if (classicInput) classicInput.style.display = "none";
      if (opts) opts.style.display = "grid";

      const options = Array.isArray(q.options) ? q.options : [];
      options.forEach((opt, i) => {
        const btn = document.createElement("button");
        btn.className = "quiz-opt";
        btn.textContent = opt;
        btn.setAttribute("data-idx", i);
        btn.addEventListener("click", () => selectAnswer((opt || "").replace(/^[A-D]\)\s*/, ""), btn));
        if (opts) opts.appendChild(btn);
      });
    } else {
      if (opts) opts.style.display = "none";
      if (classicInput) {
        classicInput.style.display = "block";
        classicInput.value = "";
        classicInput.placeholder = t("quiz.answerPlaceholder", {}, "Write your answer here...");
        const submitBtn = document.getElementById("classicSubmit");
        if (submitBtn) {
          submitBtn.onclick = () => {
            const val = classicInput.value.trim();
            if (val) selectAnswer(val, null);
          };
        }
      }
    }

    secondsLeft = 60;
    if (timerEl) timerEl.textContent = secondsLeft;
    timerInterval = setInterval(() => {
      secondsLeft -= 1;
      if (timerEl) timerEl.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(timerInterval);
        selectAnswer("__TIMEOUT__", null);
      }
    }, 1000);
  }

  function selectAnswer(userAnswer, clickedBtn) {
    clearInterval(timerInterval);

    const q = questions[currentQ];
    const qAnswer = (q.answer || "").toString();
    const normalizedUser = (userAnswer || "").replace(/^[A-D]\)\s*/, "").toLowerCase().trim();
    const normalizedAnswer = qAnswer.replace(/^[A-D]\)\s*/, "").toLowerCase().trim();

    const isCorrect = userAnswer !== "__TIMEOUT__" && normalizedUser === normalizedAnswer;

    answers.push({
      question: q.question || "",
      userAnswer,
      correctAnswer: qAnswer,
      isCorrect,
      explanation: q.explanation || "",
      citation: q.citation || "",
      category: q.category || "",
    });

    if (isCorrect) score += 1;

    const opts = document.getElementById("qOptions");
    if (opts) {
      Array.from(opts.children).forEach((btn) => {
        const bText = (btn.textContent || "").replace(/^[A-D]\)\s*/, "").toLowerCase().trim();
        if (bText === normalizedAnswer) {
          btn.style.background = "rgba(0,184,148,0.2)";
          btn.style.borderColor = "var(--green)";
        } else if (btn === clickedBtn) {
          btn.style.background = "rgba(231,76,60,0.2)";
          btn.style.borderColor = "var(--red)";
        }
        btn.disabled = true;
      });
    }

    const expEl = document.getElementById("qExplanation");
    if (expEl && q.explanation) {
      expEl.style.display = "block";
      expEl.textContent = (isCorrect ? "? Doğru! " : "? Yanlış. ") + q.explanation;
      expEl.style.color = isCorrect ? "var(--green)" : "var(--red)";
    }

    const nextBtn = document.getElementById("qNext");
    if (nextBtn) {
      nextBtn.style.display = "block";
      nextBtn.onclick = () => {
        if (expEl) expEl.style.display = "none";
        nextBtn.style.display = "none";
        currentQ += 1;
        if (currentQ < questions.length) renderQuestion();
        else finishQuiz();
      };
    }
  }

  function renderAnswerReview(items) {
    const reviewEl = document.getElementById("answerReview");
    if (!reviewEl) return;

    reviewEl.innerHTML = "";
    items.forEach((a, i) => {
      const item = document.createElement("div");
      item.className = `review-item ${a.isCorrect ? "correct" : "wrong"}`;

      const qDiv = document.createElement("div");
      qDiv.className = "review-q";
      qDiv.textContent = `${i + 1}. ${a.question}`;

      const aDiv = document.createElement("div");
      aDiv.className = "review-a";

      const userTag = document.createElement("span");
      userTag.className = a.isCorrect ? "correct-tag" : "wrong-tag";
      userTag.textContent = `${a.isCorrect ? "?" : "?"} Sizin: ${a.userAnswer === "__TIMEOUT__" ? "Süre doldu" : a.userAnswer}`;
      aDiv.appendChild(userTag);

      if (!a.isCorrect) {
        const correctTag = document.createElement("span");
        correctTag.className = "correct-tag";
        correctTag.textContent = `? Doğru: ${a.correctAnswer}`;
        aDiv.appendChild(correctTag);
      }

      item.appendChild(qDiv);
      item.appendChild(aDiv);

      if (a.explanation) {
        const expDiv = document.createElement("div");
        expDiv.className = "review-exp";
        expDiv.textContent = `${a.explanation}${a.citation ? ` (${a.citation})` : ""}`;
        item.appendChild(expDiv);
      }

      reviewEl.appendChild(item);
    });
  }

  async function persistSolvedQuiz(payload) {
    const sessionId = window.currentSessionId;
    if (!sessionId) return;

    try {
      const res = await fetch("/api/quiz/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, quiz: payload }),
      });
      const data = await res.json();
      if (data.error || !data.quiz) throw new Error(data.error || "Quiz sonucu kaydedilemedi");
      savedQuizzes = [data.quiz, ...savedQuizzes.filter((item) => item.id !== data.quiz.id)];
      renderSavedQuizList(savedQuizzes);
    } catch (error) {
      if (window.showToast) window.showToast(error.message || "Quiz sonucu kaydedilemedi", "error");
    }
  }

  function openSolvedQuiz(quizId) {
    const solved = savedQuizzes.find((item) => item.id === quizId);
    if (!solved) return;

    questions = Array.isArray(solved.questions) ? solved.questions : [];
    answers = Array.isArray(solved.answers) ? solved.answers : [];
    score = solved.score || 0;
    currentQuizContext = {
      documentId: solved.documentId || "",
      documentName: solved.documentName || "",
      topic: solved.topic || "",
      difficulty: solved.difficulty || "medium",
      type: solved.type || "multiple",
      language: solved.language || "tr-TR",
    };

    const scoreEl = document.getElementById("finalScore");
    const pctEl = document.getElementById("finalPct");
    const emojiEl = document.getElementById("finalEmoji");
    const barEl = document.getElementById("scoreBar");
    const pct = solved.pct || Math.round(((solved.score || 0) / Math.max(solved.total || 0, 1)) * 100);

    if (scoreEl) scoreEl.textContent = `${solved.score || 0} / ${solved.total || 0}`;
    if (pctEl) pctEl.textContent = `%${pct}`;
    if (barEl) barEl.style.width = `${pct}%`;
    if (emojiEl) emojiEl.textContent = pct >= 80 ? "??" : pct >= 60 ? "??" : pct >= 40 ? "??" : "??";

    renderAnswerReview(answers);
    showSection("done");
  }


  function loadGeneratedQuiz(payload = {}) {
    const generatedQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    if (!generatedQuestions.length) {
      if (window.showToast) window.showToast("Yuklenecek quiz sorusu bulunamadi.", "error");
      return;
    }

    questions = generatedQuestions;
    currentQ = 0;
    score = 0;
    answers = [];
    currentQuizContext = {
      documentId: payload.documentId || "",
      documentName: payload.documentName || payload.title || "",
      topic: payload.topic || payload.title || "",
      difficulty: payload.difficulty || "medium",
      type: payload.type || "mixed",
      language: payload.language || (window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR"),
      supportDocumentIds: Array.isArray(payload.supportDocumentIds) ? payload.supportDocumentIds : [],
      questionSource: payload.questionSource === true,
    };

    renderQuestion();
    showSection("play");
  }
  function finishQuiz() {
    const pct = Math.round((score / Math.max(questions.length, 1)) * 100);
    const scoreEl = document.getElementById("finalScore");
    const pctEl = document.getElementById("finalPct");
    const emojiEl = document.getElementById("finalEmoji");
    const barEl = document.getElementById("scoreBar");

    if (scoreEl) scoreEl.textContent = `${score} / ${questions.length}`;
    if (pctEl) pctEl.textContent = `%${pct}`;
    if (barEl) barEl.style.width = `${pct}%`;
    if (emojiEl) emojiEl.textContent = pct >= 80 ? "??" : pct >= 60 ? "??" : pct >= 40 ? "??" : "??";

    renderAnswerReview(answers);

    const history = JSON.parse(localStorage.getItem("ot_quiz_history") || "[]");
    history.unshift({ date: new Date().toISOString(), score, total: questions.length, pct });
    localStorage.setItem("ot_quiz_history", JSON.stringify(history.slice(0, 50)));

    const sessionId = window.currentSessionId;
    const documentId = currentQuizContext.documentId || (quizDocumentSelect ? quizDocumentSelect.value : "");
    const documentName = currentQuizContext.documentName || (indexedDocuments.find((doc) => doc.id === documentId)?.name || "");
    const topic = currentQuizContext.topic || (quizTopicInput?.value || "").trim();
    const difficulty = currentQuizContext.difficulty || document.getElementById("quizDifficulty").value;
    const type = currentQuizContext.type || document.getElementById("quizType").value;
    const language = currentQuizContext.language || (window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR");

    fetch("/api/progress/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        type: "quiz",
        payload: {
          score,
          total: questions.length,
          pct,
          difficulty,
          type,
          documentId,
          topic,
          language,
          wrongAnswers: answers
            .filter((item) => !item.isCorrect)
            .map((item) => ({
              question: item.question,
              category: item.category || topic || "general",
            })),
        },
      }),
    }).catch(() => {});

    const solvedPayload = {
      title: topic || documentName || "Solved Quiz",
      documentId,
      documentName,
      topic,
      difficulty,
      type,
      language,
      score,
      total: questions.length,
      pct,
      questions,
      answers,
    };
    persistSolvedQuiz(solvedPayload);

    showSection("done");
    if (window.progressModule) window.progressModule.refresh();
  }

  const restartBtn = document.getElementById("quizRestart");
  if (restartBtn) restartBtn.addEventListener("click", () => showSection("setup"));
  if (genBtn) genBtn.addEventListener("click", generateQuiz);
  if (quizDocumentSelect) {
    quizDocumentSelect.addEventListener("change", async () => {
      const nextDocId = quizDocumentSelect.value;
      renderSupportDocumentOptions(nextDocId);
      renderQuizSourceHint(indexedDocuments.find((doc) => doc.id === nextDocId) || null);
      renderQuizSourcePreview();
      await loadQuizTopics(nextDocId);
    });
  }
  if (quizTopicSelect) {
    quizTopicSelect.addEventListener("change", () => {
      if (quizTopicInput && quizTopicSelect.value) {
        quizTopicInput.value = quizTopicSelect.value;
      }
      renderQuizSourcePreview();
    });
  }
  quizTopicInput?.addEventListener("input", renderQuizSourcePreview);
  quizSupportDocs?.addEventListener("change", renderQuizSourcePreview);
  document.getElementById("quizDifficulty")?.addEventListener("change", renderQuizSourcePreview);
  document.getElementById("quizType")?.addEventListener("change", renderQuizSourcePreview);
  document.getElementById("quizCount")?.addEventListener("change", renderQuizSourcePreview);

  window.addEventListener("documents:updated", (event) => {
    const preferredDocumentId = event?.detail?.indexed ? event.detail.documentId : "";
    loadQuizSources(preferredDocumentId);
  });

  document.addEventListener("uiLocaleChange", () => {
    renderSavedQuizList(savedQuizzes);
    renderQuizSourceHint(indexedDocuments.find((doc) => doc.id === (quizDocumentSelect?.value || "")) || null);
    renderQuizSourcePreview();
    if (genBtn) genBtn.textContent = t("quiz.generate", {}, genBtn.textContent);
    if (restartBtn) restartBtn.textContent = t("quiz.restart", {}, restartBtn.textContent);
  });

  showSection("setup");
  loadQuizSources();
  renderQuizSourcePreview();
  window.quizModule = { generateQuiz, showSection, loadQuizSources, openSolvedQuiz, loadGeneratedQuiz };
})();

