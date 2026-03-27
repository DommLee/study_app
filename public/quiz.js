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

  const genBtn = document.getElementById("genQuizBtn");
  const quizSetup = document.getElementById("quizSetup");
  const quizPlay = document.getElementById("quizPlay");
  const quizDone = document.getElementById("quizDone");
  const quizDocumentSelect = document.getElementById("quizDocumentSelect");
  const quizTopicSelect = document.getElementById("quizTopicSelect");
  const quizTopicInput = document.getElementById("quizTopic");

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

  async function loadQuizTopics(documentId = "") {
    const sessionId = window.currentSessionId;
    if (!quizTopicSelect) return;

    fillSelectOptions(quizTopicSelect, [], "Konular yukleniyor...");

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
        topics.length ? "Otomatik / tum konular" : "Konu bulunamadi"
      );
    } catch (error) {
      fillSelectOptions(quizTopicSelect, [], "Konu listesi alinamadi");
      if (window.showToast) window.showToast("Quiz konu listesi alinamadi: " + error.message, "error");
    }
  }

  async function loadQuizSources(preferredDocumentId = "") {
    if (!quizDocumentSelect) return;

    try {
      const docs = await fetchIndexedDocuments();
      fillSelectOptions(
        quizDocumentSelect,
        docs.map((doc) => ({ value: doc.id, label: doc.name })),
        docs.length ? "Tum indexed belgeler" : "Indexed dokuman yok"
      );

      const nextValue = docs.some((doc) => doc.id === preferredDocumentId)
        ? preferredDocumentId
        : "";
      quizDocumentSelect.value = nextValue;
      await loadQuizTopics(nextValue);
    } catch (error) {
      fillSelectOptions(quizDocumentSelect, [], "Belgeler alinamadi");
      fillSelectOptions(quizTopicSelect, [], "Konu listesi alinamadi");
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
    const sessionId = window.currentSessionId;
    const language = window.getCurrentResponseLanguage ? window.getCurrentResponseLanguage() : "tr-TR";

    genBtn.disabled = true;
    genBtn.textContent = "Oluşturuluyor...";

    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, type, count, difficulty, topic, documentId, language }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.hint ? `${data.error} (${data.hint})` : data.error);
      if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error("Soru üretilemedi");

      questions = data.questions;
      currentQ = 0;
      score = 0;
      answers = [];
      renderQuestion();
      showSection("play");
    } catch (e) {
      if (window.showToast) window.showToast("Quiz üretilemedi: " + e.message, "error");
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = "🧠 Quiz Oluştur";
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
        classicInput.placeholder = "Cevabınızı buraya yazın...";
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
      expEl.textContent = (isCorrect ? "✅ Doğru! " : "❌ Yanlış. ") + q.explanation;
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

  function finishQuiz() {
    const pct = Math.round((score / Math.max(questions.length, 1)) * 100);
    const scoreEl = document.getElementById("finalScore");
    const pctEl = document.getElementById("finalPct");
    const emojiEl = document.getElementById("finalEmoji");
    const reviewEl = document.getElementById("answerReview");
    const barEl = document.getElementById("scoreBar");

    if (scoreEl) scoreEl.textContent = `${score} / ${questions.length}`;
    if (pctEl) pctEl.textContent = `%${pct}`;
    if (barEl) barEl.style.width = `${pct}%`;
    if (emojiEl) emojiEl.textContent = pct >= 80 ? "🏆" : pct >= 60 ? "👍" : pct >= 40 ? "📚" : "💪";

    if (reviewEl) {
      reviewEl.innerHTML = "";
      answers.forEach((a, i) => {
        const item = document.createElement("div");
        item.className = `review-item ${a.isCorrect ? "correct" : "wrong"}`;

        const qDiv = document.createElement("div");
        qDiv.className = "review-q";
        qDiv.textContent = `${i + 1}. ${a.question}`;

        const aDiv = document.createElement("div");
        aDiv.className = "review-a";

        const userTag = document.createElement("span");
        userTag.className = a.isCorrect ? "correct-tag" : "wrong-tag";
        userTag.textContent = `${a.isCorrect ? "✅" : "❌"} Sizin: ${a.userAnswer === "__TIMEOUT__" ? "Süre doldu" : a.userAnswer}`;
        aDiv.appendChild(userTag);

        if (!a.isCorrect) {
          const correctTag = document.createElement("span");
          correctTag.className = "correct-tag";
          correctTag.textContent = `✔ Doğru: ${a.correctAnswer}`;
          aDiv.appendChild(correctTag);
        }

        item.appendChild(qDiv);
        item.appendChild(aDiv);

        if (a.explanation) {
          const expDiv = document.createElement("div");
          expDiv.className = "review-exp";
          expDiv.textContent = a.explanation;
          item.appendChild(expDiv);
        }

        reviewEl.appendChild(item);
      });
    }

    const history = JSON.parse(localStorage.getItem("ot_quiz_history") || "[]");
    history.unshift({ date: new Date().toLocaleString("tr-TR"), score, total: questions.length, pct });
    localStorage.setItem("ot_quiz_history", JSON.stringify(history.slice(0, 50)));

    showSection("done");
    if (window.progressModule) window.progressModule.refresh();
  }

  const restartBtn = document.getElementById("quizRestart");
  if (restartBtn) restartBtn.addEventListener("click", () => showSection("setup"));
  if (genBtn) genBtn.addEventListener("click", generateQuiz);
  if (quizDocumentSelect) {
    quizDocumentSelect.addEventListener("change", () => loadQuizTopics(quizDocumentSelect.value));
  }
  if (quizTopicSelect) {
    quizTopicSelect.addEventListener("change", () => {
      if (quizTopicInput && quizTopicSelect.value) {
        quizTopicInput.value = quizTopicSelect.value;
      }
    });
  }

  window.addEventListener("documents:updated", (event) => {
    const preferredDocumentId = event?.detail?.indexed ? event.detail.documentId : "";
    loadQuizSources(preferredDocumentId);
  });

  showSection("setup");
  loadQuizSources();
  window.quizModule = { generateQuiz, showSection, loadQuizSources };
})();
