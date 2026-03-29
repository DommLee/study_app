// ============================================================
// OmniTutor v3 - Progress Dashboard 2.0
// ============================================================
(function () {
  function t(key, params = {}, fallback = "") {
    return window.i18n?.t(key, params, fallback) || fallback || key;
  }

  function getUiLocale() {
    return typeof window.getCurrentUiLocale === "function" ? window.getCurrentUiLocale() : "en-US";
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function scoreColor(percent) {
    if (percent >= 80) return "var(--green)";
    if (percent >= 60) return "var(--orange)";
    return "var(--red)";
  }

  function formatMinutes(totalMinutes) {
    const safeMinutes = Math.max(0, Number(totalMinutes) || 0);
    if (safeMinutes < 60) return `${safeMinutes}m`;
    const hours = Math.floor(safeMinutes / 60);
    const minutes = safeMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  function formatMetaLine(parts = []) {
    return parts.filter(Boolean).join(" | ");
  }

  function createEmptyState(title, message) {
    const wrap = document.createElement("div");
    wrap.className = "progress-list-item";

    const strong = document.createElement("strong");
    strong.textContent = title;

    const small = document.createElement("small");
    small.textContent = message;

    wrap.appendChild(strong);
    wrap.appendChild(small);
    return wrap;
  }

  function renderList(container, items, emptyTitle, emptyMessage, renderItem) {
    if (!container) return;
    container.innerHTML = "";

    if (!Array.isArray(items) || !items.length) {
      container.appendChild(createEmptyState(emptyTitle, emptyMessage));
      return;
    }

    items.forEach((item) => container.appendChild(renderItem(item)));
  }

  function activateTab(name) {
    if (typeof window.switchTab === "function") {
      window.switchTab(name);
    }
  }

  function renderActionButtons(container, actions = []) {
    if (!container) return;
    container.innerHTML = "";
    actions.forEach((action, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `progress-action-btn${index === 0 ? " primary" : ""}`;
      button.textContent = action.label;
      button.addEventListener("click", action.onClick);
      container.appendChild(button);
    });
  }

  function renderTodayFocus(summary) {
    const statusEl = document.getElementById("progressTodayStatus");
    const summaryEl = document.getElementById("progressTodaySummary");
    const actionsEl = document.getElementById("progressTodayActions");
    if (!statusEl || !summaryEl || !actionsEl) return;

    const dueCount = Array.isArray(summary?.dueToday) ? summary.dueToday.length : 0;
    const weakCount = Array.isArray(summary?.weakAreas) ? summary.weakAreas.length : 0;
    const learningItem = Array.isArray(summary?.learningPath) ? summary.learningPath[0] : null;

    if (dueCount > 0) {
      statusEl.textContent = t("progress.todayStatusDue", {}, "Review due");
      summaryEl.textContent = t(
        "progress.todaySummaryDue",
        { count: dueCount },
        `${dueCount} card(s) are due now. Review them first to keep your memory curve stable, then return to new study.`
      );
      renderActionButtons(actionsEl, [
        { label: t("progress.actionReviewNow", {}, "Review due cards"), onClick: () => activateTab("flashcard") },
        { label: t("progress.actionOpenWeakAreas", {}, "Open weak areas"), onClick: () => activateTab("progress") },
      ]);
      return;
    }

    if (weakCount > 0) {
      const weakest = summary.weakAreas[0]?.label || t("progress.unnamedTopic", {}, "Unnamed topic");
      statusEl.textContent = t("progress.todayStatusWeak", {}, "Weak area");
      summaryEl.textContent = t(
        "progress.todaySummaryWeak",
        { label: weakest },
        `Your due queue is clear. The next best move is to revisit your weakest area: ${weakest}.`
      );
      renderActionButtons(actionsEl, [
        { label: t("progress.actionRecover", {}, "Run recovery practice"), onClick: () => activateTab("teacher") },
        { label: t("progress.actionOpenQuiz", {}, "Open quiz builder"), onClick: () => activateTab("quiz") },
      ]);
      return;
    }

    if (learningItem) {
      statusEl.textContent = t("progress.todayStatusLearn", {}, "Learn next");
      summaryEl.textContent = t(
        "progress.todaySummaryLearn",
        { topic: learningItem.topic },
        `No urgent review is waiting. Continue your learning path with ${learningItem.topic}.`
      );
      renderActionButtons(actionsEl, [
        { label: t("progress.actionContinueStudy", {}, "Continue studying"), onClick: () => activateTab("study") },
        { label: t("progress.actionOpenChat", {}, "Open chat"), onClick: () => activateTab("chat") },
      ]);
      return;
    }

    statusEl.textContent = t("progress.todayStatusReady", {}, "Ready");
    summaryEl.textContent = t(
      "progress.todaySummaryEmpty",
      {},
      "You do not have urgent review yet. Upload a source, study one topic, then generate a quiz or flashcards to start a complete learning loop."
    );
    renderActionButtons(actionsEl, [
      { label: t("progress.actionStartStudy", {}, "Start studying"), onClick: () => activateTab("study") },
      { label: t("progress.actionOpenTeacher", {}, "Open Teacher Q"), onClick: () => activateTab("teacher") },
    ]);
  }

  function renderContinueFocus(summary) {
    const statusEl = document.getElementById("progressContinueStatus");
    const summaryEl = document.getElementById("progressContinueSummary");
    const actionsEl = document.getElementById("progressContinueActions");
    if (!statusEl || !summaryEl || !actionsEl) return;

    const lastStudy = summary?.lastStudyEvent || null;
    const lastQuiz = summary?.lastQuizAttempt || null;
    const recentDeck = Array.isArray(summary?.decks) && summary.decks.length ? summary.decks[0] : null;

    if (lastStudy?.topic) {
      statusEl.textContent = t("progress.continueStatusStudy", {}, "Recent study");
      summaryEl.textContent = t(
        "progress.continueSummaryStudy",
        { topic: lastStudy.topic },
        `You recently studied ${lastStudy.topic}. Reopen Study and keep building from the same topic while the context is still fresh.`
      );
      renderActionButtons(actionsEl, [
        { label: t("progress.actionResumeStudy", {}, "Resume Study"), onClick: () => activateTab("study") },
        { label: t("progress.actionOpenTeacher", {}, "Open Teacher Q"), onClick: () => activateTab("teacher") },
      ]);
      return;
    }

    if (lastQuiz?.topic || lastQuiz?.documentId) {
      statusEl.textContent = t("progress.continueStatusQuiz", {}, "Recent quiz");
      summaryEl.textContent = t(
        "progress.continueSummaryQuiz",
        { topic: lastQuiz.topic || t("progress.generalTopic", {}, "general source") },
        `Your last assessment was on ${lastQuiz.topic || t("progress.generalTopic", {}, "the selected source")}. Review the result or generate a follow-up quiz with tighter scope.`
      );
      renderActionButtons(actionsEl, [
        { label: t("progress.actionOpenQuiz", {}, "Open quiz builder"), onClick: () => activateTab("quiz") },
        { label: t("progress.actionReviewProgress", {}, "Review progress"), onClick: () => activateTab("progress") },
      ]);
      return;
    }

    if (recentDeck) {
      statusEl.textContent = t("progress.continueStatusDeck", {}, "Recent deck");
      summaryEl.textContent = t(
        "progress.continueSummaryDeck",
        { name: recentDeck.name },
        `You already have a flashcard deck ready: ${recentDeck.name}. Use it to keep the loop active, even if you do not want a full study session right now.`
      );
      renderActionButtons(actionsEl, [
        { label: t("progress.actionOpenFlashcards", {}, "Open flashcards"), onClick: () => activateTab("flashcard") },
        { label: t("progress.actionOpenStudy", {}, "Open study"), onClick: () => activateTab("study") },
      ]);
      return;
    }

    statusEl.textContent = t("progress.continueStatusWaiting", {}, "Waiting");
    summaryEl.textContent = t(
      "progress.continueSummaryEmpty",
      {},
      "After your first study, quiz, or flashcard session, OmniTutor will suggest the fastest next step here."
    );
    renderActionButtons(actionsEl, [
      { label: t("progress.actionStartStudy", {}, "Start studying"), onClick: () => activateTab("study") },
      { label: t("progress.actionOpenChat", {}, "Open chat"), onClick: () => activateTab("chat") },
    ]);
  }

  async function fetchSummary() {
    const sessionId = window.currentSessionId;
    if (!sessionId) return null;

    const res = await fetch(`/api/progress/summary?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    const apiError = typeof window.getApiError === "function" ? window.getApiError(data) : null;
    if (!res.ok || apiError) {
      throw new Error(apiError?.message || t("progress.loadFailed", {}, "Progress could not be loaded"));
    }
    return data.summary || null;
  }

  function renderHeatmap(days) {
    const heatmap = document.getElementById("progressHeatmap");
    if (!heatmap) return;
    heatmap.innerHTML = "";

    (days || []).forEach((day) => {
      const cell = document.createElement("div");
      cell.className = "progress-heat-cell";
      const intensity = Math.max(0, Math.min(4, Number(day.intensity || 0)));
      const alpha = intensity === 0 ? 0.06 : 0.16 + intensity * 0.14;
      cell.style.background = `rgba(79,124,255,${alpha})`;
      cell.title = `${day.dayKey}: intensity ${intensity}`;
      cell.textContent = String(day.dayKey || "").slice(8, 10);
      heatmap.appendChild(cell);
    });
  }

  function renderQuizHistory(history) {
    const chartEl = document.getElementById("progressChart");
    const tableBody = document.getElementById("progressHistory");
    if (chartEl) chartEl.innerHTML = "";
    if (tableBody) tableBody.innerHTML = "";

    if (!Array.isArray(history) || !history.length) {
      if (tableBody) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.style.cssText = "text-align:center;color:var(--text-muted);padding:18px";
        td.textContent = t("progress.noQuizHistory", {}, "No completed quiz yet. Once you finish a quiz, it will appear here.");
        tr.appendChild(td);
        tableBody.appendChild(tr);
      }
      return;
    }

    history.forEach((entry) => {
      const pct = Math.max(0, Math.min(100, Number(entry.pct) || 0));

      if (chartEl) {
        const wrap = document.createElement("div");
        wrap.className = "chart-bar-wrap";
        wrap.title = `${entry.date || "-"}: %${pct}`;

        const bar = document.createElement("div");
        bar.className = "chart-bar";
        bar.style.height = `${pct}%`;
        bar.style.background = scoreColor(pct);

        const label = document.createElement("div");
        label.className = "chart-label";
        label.textContent = `${pct}%`;

        wrap.appendChild(bar);
        wrap.appendChild(label);
        chartEl.appendChild(wrap);
      }

      if (tableBody) {
        const tr = document.createElement("tr");

        const dateTd = document.createElement("td");
        dateTd.textContent = entry.date ? new Date(entry.date).toLocaleString(getUiLocale()) : "-";

        const scoreTd = document.createElement("td");
        scoreTd.textContent = `${entry.score || 0} / ${entry.total || 0}`;

        const pctTd = document.createElement("td");
        pctTd.textContent = `${pct}%`;
        pctTd.style.color = scoreColor(pct);

        const badgeTd = document.createElement("td");
        badgeTd.textContent = pct >= 80
          ? t("progress.strong", {}, "Strong")
          : pct >= 60
            ? t("progress.solid", {}, "Solid")
            : t("progress.needsWork", {}, "Needs work");

        tr.appendChild(dateTd);
        tr.appendChild(scoreTd);
        tr.appendChild(pctTd);
        tr.appendChild(badgeTd);
        tableBody.appendChild(tr);
      }
    });
  }

  async function refresh() {
    try {
      const summary = await fetchSummary();
      if (!summary) return;

      setText("statStudyTime", formatMinutes(summary.studyMinutes || 0));
      setText("statQuizCount", summary.quizCount || 0);
      setText("statAvgScore", `%${summary.avgScore || 0}`);
      setText("statStreak", `${summary.streak?.current || 0} ${t("progress.daySuffix", {}, "day")}`);
      setText("statFlashcards", summary.flashcardCount || 0);
      setText("statDueToday", (summary.dueToday || []).length);
      setText("statCoverage", `${summary.coverage?.percent || 0}%`);
      setText("coverageMeta", `${summary.coverage?.masteredTopics || 0} / ${summary.coverage?.totalTopics || 0} ${t("progress.topicsCovered", {}, "topics covered")}`);

      const coverageBar = document.getElementById("coverageBar");
      if (coverageBar) coverageBar.style.width = `${summary.coverage?.percent || 0}%`;

      renderTodayFocus(summary);
      renderContinueFocus(summary);
      renderHeatmap(summary.activityDays || []);
      renderQuizHistory(summary.recentQuiz || []);

      renderList(
        document.getElementById("progressDueToday"),
        summary.dueToday || [],
        t("progress.noDueToday", {}, "No due cards today"),
        t("progress.noDueTodayHint", {}, "When you generate flashcards and review them, today's due cards will appear here."),
        (item) => {
          const el = document.createElement("div");
          el.className = "progress-list-item";
          const title = document.createElement("strong");
          title.textContent = item.front || t("progress.unnamedCard", {}, "Unnamed card");
          const meta = document.createElement("small");
          meta.textContent = formatMetaLine([
            item.deckName || t("progress.unknownDeck", {}, "Unknown deck"),
            `${t("progress.metaDue", {}, "Due")}: ${item.due ? new Date(item.due).toLocaleString(getUiLocale()) : "-"}`,
          ]);
          el.appendChild(title);
          el.appendChild(meta);
          return el;
        }
      );

      renderList(
        document.getElementById("progressWeakAreas"),
        summary.weakAreas || [],
        t("progress.noWeakAreas", {}, "No weak areas"),
        t("progress.noWeakAreasHint", {}, "As you solve quizzes and make mistakes, weak areas will collect here."),
        (item) => {
          const el = document.createElement("div");
          el.className = "progress-list-item";
          const title = document.createElement("strong");
          title.textContent = item.label || t("progress.unnamedTopic", {}, "Unnamed topic");
          const meta = document.createElement("small");
          meta.textContent = formatMetaLine([
            `${t("progress.metaMisses", {}, "Misses")}: ${item.misses || 0}`,
            `${t("progress.metaHits", {}, "Hits")}: ${item.hits || 0}`,
          ]);
          el.appendChild(title);
          el.appendChild(meta);
          return el;
        }
      );

      renderList(
        document.getElementById("progressLearningPath"),
        summary.learningPath || [],
        t("progress.noLearningPath", {}, "Learning path not ready"),
        t("progress.noLearningPathHint", {}, "When you upload more documents, OmniTutor will suggest a topic order here."),
        (item) => {
          const el = document.createElement("div");
          el.className = "progress-list-item";
          const title = document.createElement("strong");
          title.textContent = item.topic || t("progress.unnamedTopic", {}, "Unnamed topic");
          const meta = document.createElement("small");
          meta.textContent = formatMetaLine([
            item.documentName || t("progress.unknownSource", {}, "Unknown source"),
            `${t("progress.metaStep", {}, "Step")}: ${item.order || "-"}`,
          ]);
          el.appendChild(title);
          el.appendChild(meta);
          return el;
        }
      );
    } catch (error) {
      if (window.showToast) {
        window.showToast(`${t("progress.loadFailed", {}, "Progress could not be loaded")}: ${error.message}`, "error");
      }
    }
  }

  const clearBtn = document.getElementById("clearProgress");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      const sessionId = window.currentSessionId;
      if (!sessionId) return;
      if (!confirm(t("progress.clearConfirm", {}, "Delete all progress and review data?"))) return;

      try {
        const res = await fetch(`/api/progress?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        const data = await res.json();
        const apiError = typeof window.getApiError === "function" ? window.getApiError(data) : null;
        if (!res.ok || apiError) {
          throw new Error(apiError?.message || t("progress.clearFailed", {}, "Progress could not be reset."));
        }
        refresh();
        if (window.showToast) window.showToast(t("progress.cleared", {}, "Progress reset."), "success");
      } catch (error) {
        if (window.showToast) window.showToast(error.message, "error");
      }
    });
  }

  document.addEventListener("tabChange", (event) => {
    if (event.detail === "progress") refresh();
  });

  document.addEventListener("uiLocaleChange", () => refresh());
  window.addEventListener("documents:updated", () => refresh());
  window.progressModule = { refresh };
})();

