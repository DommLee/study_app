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
  window.pomoModule = { reset, startStop };
})();
