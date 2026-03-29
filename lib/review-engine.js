const { fsrs, generatorParameters, createEmptyCard, Rating } = require("ts-fsrs");

const scheduler = fsrs(generatorParameters({
  request_retention: 0.9,
  maximum_interval: 365,
  enable_fuzz: false,
}));

function ensureSessionReviewState(session) {
  if (!session.review || typeof session.review !== "object") session.review = {};
  if (!session.review.decks || typeof session.review.decks !== "object") session.review.decks = {};
  if (!Array.isArray(session.review.logs)) session.review.logs = [];
  if (!session.review.weakAreas || typeof session.review.weakAreas !== "object") session.review.weakAreas = {};

  if (!session.progress || typeof session.progress !== "object") session.progress = {};
  if (!Array.isArray(session.progress.quizAttempts)) session.progress.quizAttempts = [];
  if (!Array.isArray(session.progress.studyEvents)) session.progress.studyEvents = [];
  if (!Array.isArray(session.progress.badges)) session.progress.badges = [];
  if (!session.progress.streak) session.progress.streak = { current: 0, best: 0, lastDayKey: "" };
  return session;
}

function normalizeFsrsCard(card) {
  return {
    due: new Date(card.due).toISOString(),
    stability: Number(card.stability || 0),
    difficulty: Number(card.difficulty || 0),
    elapsed_days: Number(card.elapsed_days || 0),
    scheduled_days: Number(card.scheduled_days || 0),
    reps: Number(card.reps || 0),
    lapses: Number(card.lapses || 0),
    learning_steps: Number(card.learning_steps || 0),
    state: Number(card.state || 0),
    last_review: card.last_review ? new Date(card.last_review).toISOString() : null,
  };
}

function reviveFsrsCard(rawCard = {}) {
  return {
    ...rawCard,
    due: rawCard?.due ? new Date(rawCard.due) : new Date(),
    last_review: rawCard?.last_review ? new Date(rawCard.last_review) : undefined,
  };
}

function createReviewCard(card, deckId, deckName) {
  const fsrsCard = createEmptyCard(new Date(), (value) => value);
  return {
    id: card.id || `${deckId}:${Math.random().toString(36).slice(2, 10)}`,
    front: card.front || "",
    back: card.back || "",
    category: card.category || "",
    citation: card.citation || "",
    sourceDocumentId: card.sourceDocumentId || "",
    fsrs: normalizeFsrsCard(fsrsCard),
    grades: [],
    createdAt: Date.now(),
    deckId,
    deckName,
  };
}

function ensureDeck(session, { deckId, deckName, sourceDocumentId = "", topic = "", language = "tr-TR", preset = "auto" }) {
  ensureSessionReviewState(session);
  if (!session.review.decks[deckId]) {
    session.review.decks[deckId] = {
      id: deckId,
      name: deckName,
      sourceDocumentId,
      topic,
      language,
      preset,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cards: [],
    };
  }
  return session.review.decks[deckId];
}

function storeGeneratedDeck(session, payload) {
  const { deckId, deckName, sourceDocumentId = "", topic = "", language = "tr-TR", preset = "auto", cards = [] } = payload;
  const deck = ensureDeck(session, { deckId, deckName, sourceDocumentId, topic, language, preset });
  deck.cards = cards.map((card) => createReviewCard({ ...card, sourceDocumentId }, deckId, deckName));
  deck.updatedAt = Date.now();
  return deck;
}

function mapGradeToRating(grade = "good") {
  switch (grade) {
    case "again": return Rating.Again;
    case "hard": return Rating.Hard;
    case "easy": return Rating.Easy;
    case "good":
    default: return Rating.Good;
  }
}

function updateWeakArea(session, { category = "", question = "", wasCorrect = true, weight = 1 }) {
  ensureSessionReviewState(session);
  const key = String(category || question || "general").trim().slice(0, 120) || "general";
  if (!session.review.weakAreas[key]) {
    session.review.weakAreas[key] = { label: key, misses: 0, hits: 0, lastSeenAt: Date.now() };
  }
  const area = session.review.weakAreas[key];
  if (wasCorrect) area.hits += weight;
  else area.misses += weight;
  area.lastSeenAt = Date.now();
}

function updateStreak(session, timestamp = Date.now()) {
  ensureSessionReviewState(session);
  const dayKey = new Date(timestamp).toISOString().slice(0, 10);
  const streak = session.progress.streak;
  if (streak.lastDayKey === dayKey) return streak;
  if (!streak.lastDayKey) {
    streak.current = 1;
    streak.best = 1;
    streak.lastDayKey = dayKey;
    return streak;
  }

  const previous = new Date(streak.lastDayKey);
  const current = new Date(dayKey);
  const diffDays = Math.round((current.getTime() - previous.getTime()) / 86400000);
  if (diffDays === 1) streak.current += 1;
  else if (diffDays > 1) streak.current = 1;
  streak.best = Math.max(streak.best || 0, streak.current || 0);
  streak.lastDayKey = dayKey;
  return streak;
}

function recordQuizAttempt(session, payload) {
  ensureSessionReviewState(session);
  const now = Date.now();
  const attempt = {
    id: payload.id || `quiz-${now}`,
    date: new Date(now).toISOString(),
    score: Number(payload.score || 0),
    total: Number(payload.total || 0),
    pct: Number(payload.pct || 0),
    difficulty: payload.difficulty || "medium",
    type: payload.type || "multiple",
    documentId: payload.documentId || "",
    topic: payload.topic || "",
    language: payload.language || "tr-TR",
    wrongAnswers: Array.isArray(payload.wrongAnswers) ? payload.wrongAnswers : [],
  };
  session.progress.quizAttempts.unshift(attempt);
  session.progress.quizAttempts = session.progress.quizAttempts.slice(0, 100);
  attempt.wrongAnswers.forEach((item) => {
    updateWeakArea(session, {
      category: item.category || item.topic || item.question || "general",
      question: item.question || "",
      wasCorrect: false,
    });
  });
  updateStreak(session, now);
  return attempt;
}

function reviewDeckCard(session, { deckId, cardId, grade = "good" }) {
  ensureSessionReviewState(session);
  const deck = session.review.decks[deckId];
  if (!deck) throw new Error("Deck not found");
  const card = deck.cards.find((item) => item.id === cardId);
  if (!card) throw new Error("Card not found");

  const now = new Date();
  const result = scheduler.next(reviveFsrsCard(card.fsrs), now, mapGradeToRating(grade));
  card.fsrs = normalizeFsrsCard(result.card);
  card.grades.push({ grade, at: now.toISOString() });
  deck.updatedAt = Date.now();

  updateWeakArea(session, {
    category: card.category || card.front,
    question: card.front,
    wasCorrect: grade === "good" || grade === "easy",
  });

  session.review.logs.unshift({ type: "flashcard-review", deckId, cardId, grade, at: now.toISOString() });
  session.review.logs = session.review.logs.slice(0, 500);
  updateStreak(session, now.getTime());
  return { deck, card };
}

function buildReviewQueue(session, { limit = 20 } = {}) {
  ensureSessionReviewState(session);
  const now = Date.now();
  const items = [];
  Object.values(session.review.decks).forEach((deck) => {
    (deck.cards || []).forEach((card) => {
      const dueTime = card?.fsrs?.due ? new Date(card.fsrs.due).getTime() : now;
      if (dueTime <= now) {
        items.push({
          deckId: deck.id,
          deckName: deck.name,
          cardId: card.id,
          front: card.front,
          back: card.back,
          category: card.category || "",
          citation: card.citation || "",
          due: card.fsrs?.due || new Date(now).toISOString(),
          stability: card.fsrs?.stability || 0,
          difficulty: card.fsrs?.difficulty || 0,
          reps: card.fsrs?.reps || 0,
        });
      }
    });
  });

  return items
    .sort((left, right) => new Date(left.due).getTime() - new Date(right.due).getTime())
    .slice(0, limit);
}

function recordStudyEvent(session, payload = {}) {
  ensureSessionReviewState(session);
  session.progress.studyEvents.unshift({
    at: new Date().toISOString(),
    type: payload.type || "study",
    seconds: Number(payload.seconds || 0),
    documentId: payload.documentId || "",
    topic: payload.topic || "",
  });
  session.progress.studyEvents = session.progress.studyEvents.slice(0, 200);
  if (payload.seconds) updateStreak(session, Date.now());
}

function buildProgressSummary(session) {
  ensureSessionReviewState(session);
  const quizAttempts = session.progress.quizAttempts || [];
  const reviewQueue = buildReviewQueue(session, { limit: 50 });
  const studyEvents = session.progress.studyEvents || [];
  const studySeconds = (session.progress.studyEvents || []).reduce((sum, event) => sum + (Number(event.seconds) || 0), 0);
  const avgScore = quizAttempts.length
    ? Math.round(quizAttempts.reduce((sum, item) => sum + (Number(item.pct) || 0), 0) / quizAttempts.length)
    : 0;

  const weakAreas = Object.values(session.review.weakAreas || {})
    .map((area) => ({
      label: area.label,
      misses: area.misses || 0,
      hits: area.hits || 0,
      score: (area.misses || 0) - (area.hits || 0),
      lastSeenAt: area.lastSeenAt || 0,
    }))
    .sort((left, right) => right.score - left.score || right.lastSeenAt - left.lastSeenAt)
    .slice(0, 8);

  const topicPool = new Set();
  (session.documents || []).forEach((doc) => (doc.topics || []).forEach((topic) => topicPool.add(topic)));
  const mastered = new Set();
  Object.values(session.review.decks || {}).forEach((deck) => {
    (deck.cards || []).forEach((card) => {
      if ((card.fsrs?.reps || 0) >= 2 && (card.fsrs?.difficulty || 0) <= 6) {
        const label = card.category || deck.topic;
        if (label) mastered.add(label);
      }
    });
  });

  return {
    activityDays: Array.from({ length: 21 }, (_, index) => {
      const date = new Date(Date.now() - (20 - index) * 86400000);
      const dayKey = date.toISOString().slice(0, 10);
      const studyCount = studyEvents.filter((event) => String(event.at || "").startsWith(dayKey)).length;
      const quizCountForDay = quizAttempts.filter((attempt) => String(attempt.date || "").startsWith(dayKey)).length;
      const intensity = Math.min(4, studyCount + quizCountForDay);
      return { dayKey, intensity };
    }),
    studyMinutes: Math.round(studySeconds / 60),
    quizCount: quizAttempts.length,
    avgScore,
    streak: session.progress.streak || { current: 0, best: 0, lastDayKey: "" },
    flashcardCount: Object.values(session.review.decks || {}).reduce((sum, deck) => sum + ((deck.cards || []).length), 0),
    dueToday: reviewQueue,
    weakAreas,
    lastStudyEvent: studyEvents[0] || null,
    lastQuizAttempt: quizAttempts[0] || null,
    recentQuiz: quizAttempts.slice(0, 7).reverse(),
    coverage: {
      totalTopics: topicPool.size,
      masteredTopics: mastered.size,
      percent: topicPool.size ? Math.round((mastered.size / topicPool.size) * 100) : 0,
    },
    learningPath: (session.documents || [])
      .sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0))
      .flatMap((doc) => (doc.topics || []).map((topic, index) => ({
        documentId: doc.id,
        documentName: doc.name,
        topic,
        order: index + 1,
      })))
      .slice(0, 24),
    decks: Object.values(session.review.decks || {}).map((deck) => ({
      id: deck.id,
      name: deck.name,
      count: (deck.cards || []).length,
      dueCount: (deck.cards || []).filter((card) => new Date(card.fsrs?.due || 0).getTime() <= Date.now()).length,
      language: deck.language || "tr-TR",
      topic: deck.topic || "",
      sourceDocumentId: deck.sourceDocumentId || "",
    })),
  };
}

module.exports = {
  ensureSessionReviewState,
  storeGeneratedDeck,
  reviewDeckCard,
  buildReviewQueue,
  buildProgressSummary,
  recordQuizAttempt,
  recordStudyEvent,
};
