// ============================================================
// OmniTutor v3 — Progress & Analytics Module
// ============================================================
(function () {
  function getStudyMinutes() {
    const secs = parseInt(localStorage.getItem("pomoStudySeconds") || "0", 10);
    return Math.round(secs / 60);
  }

  function getQuizHistory() {
    return JSON.parse(localStorage.getItem("ot_quiz_history") || "[]");
  }

  function getStreak() {
    const history = getQuizHistory();
    if (!history.length) return 0;

    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const dates = history.map((h) => new Date(h.date).toDateString());

    if (!dates.includes(today)) return 0;

    let streak = 1;
    let checkDate = yesterday;
    for (let i = 0; i < 30; i++) {
      if (dates.includes(checkDate)) {
        streak += 1;
        checkDate = new Date(new Date(checkDate).getTime() - 86400000).toDateString();
      } else {
        break;
      }
    }
    return streak;
  }

  function getFlashcardCount() {
    const decks = JSON.parse(localStorage.getItem("ot_decks") || "{}");
    return Object.values(decks).reduce((sum, d) => sum + (d.cards || []).length, 0);
  }

  function scoreColor(pct) {
    if (pct >= 70) return "var(--green)";
    if (pct >= 50) return "var(--orange)";
    return "var(--red)";
  }

  function refresh() {
    const history = getQuizHistory();
    const mins = getStudyMinutes();
    const streak = getStreak();
    const fcCount = getFlashcardCount();
    const avgScore = history.length ? Math.round(history.reduce((s, h) => s + (Number(h.pct) || 0), 0) / history.length) : 0;

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setEl("statStudyTime", mins < 60 ? `${mins}d` : `${Math.floor(mins / 60)}s ${mins % 60}d`);
    setEl("statQuizCount", history.length);
    setEl("statAvgScore", `%${avgScore}`);
    setEl("statStreak", `${streak} 🔥`);
    setEl("statFlashcards", fcCount);

    const tableBody = document.getElementById("progressHistory");
    if (tableBody) {
      tableBody.innerHTML = "";
      if (!history.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.style.cssText = "text-align:center;color:var(--text-muted);padding:16px";
        td.textContent = "Henüz quiz tamamlanmadı";
        tr.appendChild(td);
        tableBody.appendChild(tr);
      } else {
        history.slice(0, 10).forEach((h) => {
          const pctNum = Math.max(0, Math.min(100, Number(h.pct) || 0));
          const tr = document.createElement("tr");

          const tdDate = document.createElement("td");
          tdDate.textContent = h.date || "-";

          const tdScore = document.createElement("td");
          tdScore.textContent = `${h.score || 0} / ${h.total || 0}`;

          const tdPct = document.createElement("td");
          tdPct.style.color = scoreColor(pctNum);
          tdPct.textContent = `${pctNum}%`;

          const tdBadge = document.createElement("td");
          tdBadge.textContent = pctNum >= 80 ? "🏆" : pctNum >= 60 ? "👍" : "📚";

          tr.appendChild(tdDate);
          tr.appendChild(tdScore);
          tr.appendChild(tdPct);
          tr.appendChild(tdBadge);
          tableBody.appendChild(tr);
        });
      }
    }

    const chartEl = document.getElementById("progressChart");
    if (chartEl) {
      chartEl.innerHTML = "";
      if (history.length) {
        const recent = history.slice(0, 7).reverse();
        recent.forEach((h) => {
          const pctNum = Math.max(0, Math.min(100, Number(h.pct) || 0));
          const wrap = document.createElement("div");
          wrap.className = "chart-bar-wrap";
          wrap.title = `${h.date || "-"}: %${pctNum}`;

          const bar = document.createElement("div");
          bar.className = "chart-bar";
          bar.style.height = `${pctNum}%`;
          bar.style.background = scoreColor(pctNum);

          const label = document.createElement("div");
          label.className = "chart-label";
          label.textContent = `${pctNum}%`;

          wrap.appendChild(bar);
          wrap.appendChild(label);
          chartEl.appendChild(wrap);
        });
      }
    }
  }

  const clearBtn = document.getElementById("clearProgress");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm("Tüm ilerleme verisi silinsin mi?")) return;
      localStorage.removeItem("ot_quiz_history");
      localStorage.removeItem("pomoStudySeconds");
      refresh();
      if (window.showToast) window.showToast("İlerleme sıfırlandı", "success");
    });
  }

  document.addEventListener("tabChange", (e) => {
    if (e.detail === "progress") refresh();
  });

  refresh();
  window.progressModule = { refresh };
})();
