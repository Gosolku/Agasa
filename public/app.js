/* Agasa — front end. Talks to /api/chat and /api/usage (worker.js). */
(() => {
  "use strict";

  /* ---------- ambient: lamp follows the cursor ---------- */
  window.addEventListener("pointermove", (e) => {
    document.documentElement.style.setProperty("--mx", (e.clientX / window.innerWidth) * 100 + "%");
    document.documentElement.style.setProperty("--my", (e.clientY / window.innerHeight) * 100 + "%");
  }, { passive: true });

  /* ---------- ambient: tint + status line shift with time of day ---------- */
  function timeOfDay(h) {
    if (h >= 21 || h < 5) return { tint: "radial-gradient(1200px 820px at 78% 4%, rgba(215,160,95,.05), transparent 60%)", label: "late night" };
    if (h < 8)  return { tint: "radial-gradient(1200px 820px at 22% 6%, rgba(150,180,225,.04), transparent 60%)", label: "early morning" };
    if (h < 17) return { tint: "linear-gradient(180deg, rgba(255,255,255,.005), transparent 40%)", label: "daytime" };
    return { tint: "radial-gradient(1200px 840px at 80% 4%, rgba(226,121,74,.05), transparent 60%)", label: "evening" };
  }
  function paintTimeOfDay() {
    document.getElementById("tod").style.background = timeOfDay(new Date().getHours()).tint;
  }
  paintTimeOfDay();
  setInterval(paintTimeOfDay, 5 * 60 * 1000);

  /* ---------- minimal, safe markdown-lite ---------- */
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function renderMarkdownLite(raw) {
    let s = escapeHtml(raw);
    s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  /* ---------- elements ---------- */
  const log = document.getElementById("log");
  const empty = document.getElementById("empty");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const jumpBtn = document.getElementById("jump");
  const statusDot = document.querySelector("#status .dot");
  const usageFill = document.getElementById("usage-fill");
  const usageText = document.getElementById("usage-text");

  const history = [];
  let atBottom = true;

  /* ---------- composer: auto-grow + enter-to-send ---------- */
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  /* ---------- scroll tracking ---------- */
  log.addEventListener("scroll", () => {
    atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    jumpBtn.classList.toggle("show", !atBottom);
  });
  jumpBtn.addEventListener("click", () => scrollToEnd(true));
  function scrollToEnd(force) {
    if (force || atBottom) log.scrollTop = log.scrollHeight;
  }

  /* ---------- suggestion chips ---------- */
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      input.value = chip.dataset.prompt;
      form.requestSubmit();
    });
  });

  /* ---------- message rendering ---------- */
  function addMessage({ role, text, isError = false, pending = false }) {
    if (empty.parentElement) empty.remove();

    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "bot") + (isError ? " error" : "");

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (pending) {
      bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    } else {
      bubble.innerHTML = role === "user" ? escapeHtml(text) : renderMarkdownLite(text);
    }
    wrap.appendChild(bubble);

    const time = document.createElement("div");
    time.className = "timestamp";
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    wrap.appendChild(time);

    log.appendChild(wrap);
    scrollToEnd(true);
    atBottom = true;
    return { wrap, bubble, time };
  }

  /* ---------- usage ---------- */
  function paintUsage(usage) {
    if (!usage) { usageText.textContent = "usage unavailable"; return; }
    const pct = Math.min(100, (usage.used / usage.limit) * 100);
    usageFill.style.width = pct + "%";
    usageText.textContent = usage.used >= usage.limit
      ? `${usage.used} / ${usage.limit} — out for today`
      : `${usage.used} / ${usage.limit} today`;
    setComposerDisabled(usage.used >= usage.limit);
  }
  function setComposerDisabled(disabled) {
    input.disabled = disabled;
    sendBtn.disabled = disabled;
    if (disabled) input.placeholder = "Daily limit reached — resets at midnight Pacific.";
  }

  fetch("/api/usage").then((r) => r.json()).then(paintUsage).catch(() => {
    usageText.textContent = "usage unavailable";
  });

  /* ---------- send ---------- */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;

    input.value = "";
    input.style.height = "auto";
    addMessage({ role: "user", text });

    const turnHistory = history.slice();
    history.push({ role: "user", text });

    const pending = addMessage({ role: "bot", pending: true });
    statusDot.classList.remove("off");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, history: turnHistory }),
      });
      const data = await res.json();

      if (data.reply) {
        pending.bubble.innerHTML = renderMarkdownLite(data.reply);
        history.push({ role: "assistant", text: data.reply });
      } else {
        pending.wrap.classList.add("error");
        pending.bubble.textContent = data.error || "The assistant didn't return a reply. Try again.";
      }
      if (data.usage) paintUsage(data.usage);
    } catch {
      statusDot.classList.add("off");
      pending.wrap.classList.add("error");
      pending.bubble.textContent = "Couldn't reach the server. Check your connection and try again.";
    }
    scrollToEnd(true);
  });
})();
