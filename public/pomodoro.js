(function () {
  let workDuration = 25 * 60;
  let breakDuration = 5 * 60;
  let timerId = null;
  let secondsLeft = workDuration;
  let running = false;
  let sessionCountValue = 0;
  let onBreak = false;

  const displays = [
    document.getElementById("pomoDisplay"),
    document.getElementById("pomoWidgetDisplay"),
  ].filter(Boolean);

  const labels = [
    document.getElementById("pomoLabel"),
    document.getElementById("pomoWidgetLabel"),
  ].filter(Boolean);

  const startButtons = [
    document.getElementById("pomoStart"),
    document.getElementById("pomoWidgetStart"),
  ].filter(Boolean);

  const resetButtons = [
    document.getElementById("pomoReset"),
    document.getElementById("pomoWidgetReset"),
  ].filter(Boolean);

  const sessionCounters = [
    document.getElementById("pomoSessions"),
    document.getElementById("pomoWidgetSessions"),
  ].filter(Boolean);

  const rings = [
    document.getElementById("pomoRing"),
    document.getElementById("pomoWidgetRing"),
  ].filter(Boolean);

  const workInput = document.getElementById("pomoDurationWork");
  const breakInput = document.getElementById("pomoDurationBreak");
  const widget = document.getElementById("pomoWidget");
  const widgetHandle = document.getElementById("pomoWidgetHandle");
  const widgetDockBtn = document.getElementById("pomoWidgetDock");
  const WIDGET_POS_KEY = "omnitutor-pomo-widget-pos";

  function clampWidgetPosition(left, top) {
    if (!widget) return { left, top };
    const margin = 12;
    const rect = widget.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, left)),
      top: Math.min(maxTop, Math.max(margin, top)),
    };
  }

  function saveWidgetPosition(left, top) {
    try {
      localStorage.setItem(WIDGET_POS_KEY, JSON.stringify({ left, top }));
    } catch {
      // Ignore storage failures.
    }
  }

  function resetWidgetPosition() {
    if (!widget) return;
    widget.style.left = "";
    widget.style.top = "";
    widget.style.right = "24px";
    widget.style.bottom = "24px";
    try {
      localStorage.removeItem(WIDGET_POS_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  function applySavedWidgetPosition() {
    if (!widget) return;
    try {
      const parsed = JSON.parse(localStorage.getItem(WIDGET_POS_KEY) || "null");
      if (!parsed || typeof parsed.left !== "number" || typeof parsed.top !== "number") {
        return;
      }
      const next = clampWidgetPosition(parsed.left, parsed.top);
      widget.style.left = `${next.left}px`;
      widget.style.top = `${next.top}px`;
      widget.style.right = "auto";
      widget.style.bottom = "auto";
    } catch {
      // Ignore malformed positions.
    }
  }

  function bindWidgetDragging() {
    if (!widget || !widgetHandle) return;

    let dragging = false;
    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;

    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      widget.classList.remove("dragging");
      try {
        widgetHandle.releasePointerCapture(pointerId);
      } catch {}
      pointerId = null;
      const rect = widget.getBoundingClientRect();
      saveWidgetPosition(rect.left, rect.top);
    };

    widgetHandle.addEventListener("pointerdown", (event) => {
      if (event.target === widgetDockBtn) return;
      dragging = true;
      pointerId = event.pointerId;
      const rect = widget.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      widget.style.left = `${rect.left}px`;
      widget.style.top = `${rect.top}px`;
      widget.style.right = "auto";
      widget.style.bottom = "auto";
      widget.classList.add("dragging");
      widgetHandle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    widgetHandle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const next = clampWidgetPosition(event.clientX - offsetX, event.clientY - offsetY);
      widget.style.left = `${next.left}px`;
      widget.style.top = `${next.top}px`;
    });

    widgetHandle.addEventListener("pointerup", stopDrag);
    widgetHandle.addEventListener("pointercancel", stopDrag);
    widgetHandle.addEventListener("dblclick", resetWidgetPosition);
    widgetDockBtn?.addEventListener("click", resetWidgetPosition);

    window.addEventListener("resize", () => {
      if (!widget.style.left || !widget.style.top) return;
      const current = clampWidgetPosition(
        Number.parseFloat(widget.style.left || "0"),
        Number.parseFloat(widget.style.top || "0")
      );
      widget.style.left = `${current.left}px`;
      widget.style.top = `${current.top}px`;
      saveWidgetPosition(current.left, current.top);
    });
  }

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function setStartButtonState() {
    const text = running ? "Pause" : "Start";
    const background = running
      ? "linear-gradient(135deg, var(--orange), #e67e22)"
      : "linear-gradient(135deg, var(--accent), #5a4bd1)";

    startButtons.forEach((button) => {
      button.textContent = text;
      button.style.background = background;
    });
  }

  function updateRing() {
    const total = onBreak ? breakDuration : workDuration;
    const safeTotal = total > 0 ? total : 1;
    const progress = secondsLeft / safeTotal;
    const circumference = 2 * Math.PI * 45;
    const dashOffset = circumference * (1 - progress);

    rings.forEach((ring) => {
      ring.style.strokeDasharray = String(circumference);
      ring.style.strokeDashoffset = String(dashOffset);
    });
  }

  function render() {
    const label = onBreak ? "Break" : "Focus";
    const timeText = formatTime(secondsLeft);

    displays.forEach((display) => {
      display.textContent = timeText;
    });

    labels.forEach((labelEl) => {
      labelEl.textContent = label;
    });

    sessionCounters.forEach((counter) => {
      counter.textContent = String(sessionCountValue);
    });

    setStartButtonState();
    updateRing();
  }

  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = onBreak ? 440 : 880;
      oscillator.type = "sine";
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.6);
    } catch {
      // Ignore audio failures.
    }
  }

  function stopTimer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    running = false;
    render();
  }

  function tick() {
    if (secondsLeft <= 0) {
      playBeep();
      if (onBreak) {
        onBreak = false;
        secondsLeft = workDuration;
        if (window.showToast) window.showToast("Back to focus.", "success");
      } else {
        sessionCountValue += 1;
        onBreak = true;
        secondsLeft = breakDuration;
        if (window.showToast) window.showToast("Break time.", "success");
      }
      render();
      return;
    }

    secondsLeft -= 1;
    if (!onBreak) {
      const previous = Number.parseInt(localStorage.getItem("pomoStudySeconds") || "0", 10) || 0;
      localStorage.setItem("pomoStudySeconds", String(previous + 1));
    }
    render();
  }

  function startStop() {
    if (running) {
      stopTimer();
      return;
    }

    timerId = window.setInterval(tick, 1000);
    running = true;
    render();
  }

  function reset() {
    stopTimer();
    onBreak = false;
    secondsLeft = workDuration;
    render();
  }

  startButtons.forEach((button) => {
    button.addEventListener("click", startStop);
  });

  resetButtons.forEach((button) => {
    button.addEventListener("click", reset);
  });

  if (workInput) {
    workInput.addEventListener("change", () => {
      const nextMinutes = Number.parseInt(workInput.value || "25", 10) || 25;
      workDuration = Math.max(1, nextMinutes) * 60;
      if (!running && !onBreak) {
        secondsLeft = workDuration;
        render();
      }
    });
  }

  if (breakInput) {
    breakInput.addEventListener("change", () => {
      const nextMinutes = Number.parseInt(breakInput.value || "5", 10) || 5;
      breakDuration = Math.max(1, nextMinutes) * 60;
      if (!running && onBreak) {
        secondsLeft = breakDuration;
        render();
      }
    });
  }

  render();
  applySavedWidgetPosition();
  bindWidgetDragging();
  window.pomoModule = { reset, startStop };
})();
