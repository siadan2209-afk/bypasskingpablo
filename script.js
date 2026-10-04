(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var welcome = $("welcome");
  var app = $("app");
  var form = $("form-view");
  var input = $("url-input");
  var submitBtn = $("submit-btn");
  var processView = $("process-view");
  var spinner = $("spinner");
  var ringBar = $("ring-bar");
  var pctEl = $("pct");
  var statusEl = $("status");
  var result = $("result");
  var destUrl = $("dest-url");
  var openBtn = $("open-btn");
  var againBtn = $("again-btn");
  var toast = $("toast");
  var toastText = $("toast-text");

  var CIRC = 326.73; // keliling lingkaran r=52
  var resultUrl = "";
  var rafId = 0;
  var toastTimer = 0;
  var busy = false;

  /* ---------- Opening screen ---------- */
  setTimeout(function () {
    welcome.classList.add("hide");
    app.classList.add("ready");
    app.removeAttribute("aria-hidden");
    setTimeout(function () { welcome.hidden = true; }, 900);
  }, 2600);

  /* ---------- Toast error ---------- */
  function showError(message) {
    clearTimeout(toastTimer);
    toastText.textContent = message;
    toast.hidden = false;
    toast.classList.remove("show", "out");
    void toast.offsetWidth; // restart animasi
    toast.classList.add("show");
    toastTimer = setTimeout(function () {
      toast.classList.remove("show");
      toast.classList.add("out");
      toastTimer = setTimeout(function () { toast.hidden = true; }, 400);
    }, 3600);
  }

  function shakeInput() {
    input.classList.remove("shake");
    void input.offsetWidth;
    input.classList.add("shake");
  }

  /* ---------- Validasi URL ---------- */
  function isValidUrl(value) {
    if (!/^https?:\/\//i.test(value)) return false;
    try {
      var u = new URL(value);
      return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
    } catch (e) {
      return false;
    }
  }

  /* ---------- Progress ---------- */
  function statusFor(p) {
    if (p >= 100) return "Complete!";
    if (p >= 85) return "Finalizing...";
    if (p >= 60) return "Processing...";
    if (p >= 35) return "Validating link...";
    if (p >= 10) return "Checking URL...";
    return "Initializing...";
  }

  function render(value) {
    var p = Math.min(100, Math.floor(value));
    pctEl.textContent = p + "%";
    spinner.setAttribute("aria-valuenow", String(p));
    ringBar.style.strokeDashoffset = String(CIRC * (1 - value / 100));
    var s = statusFor(p);
    if (statusEl.textContent !== s) statusEl.textContent = s;
  }

  // Berjalan natural: melambat mendekati 90% sambil menunggu API,
  // lalu menyelesaikan sampai 100% setelah respons backend diterima.
  function runProgress(state) {
    return new Promise(function (resolve) {
      var value = 0;
      var last = performance.now();

      function frame(now) {
        var dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        if (state.error) { resolve(false); return; }

        var ready = state.done;
        var cap = ready ? 100 : 90;
        var speed = ready ? 34 : Math.max(5, 26 * ((90 - value) / 90) + 6);
        value = Math.min(cap, value + speed * dt);
        render(value);

        if (value >= 100) { resolve(true); return; }
        rafId = requestAnimationFrame(frame);
      }
      rafId = requestAnimationFrame(frame);
    });
  }

  /* ---------- Request ke backend ---------- */
  function callApi(url) {
    return fetch("/api/bypass", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || !data.success || !data.url) {
          throw new Error((data && data.message) || "URL tidak dapat diproses");
        }
        return data;
      });
    });
  }

  /* ---------- View helpers ---------- */
  function resetProcessUI() {
    cancelAnimationFrame(rafId);
    spinner.classList.remove("done");
    result.hidden = true;
    destUrl.textContent = "";
    statusEl.hidden = false;
    render(0);
  }

  function showForm() {
    processView.hidden = true;
    form.hidden = false;
    submitBtn.disabled = false;
    busy = false;
  }

  /* ---------- Submit ---------- */
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) return;

    var value = input.value.trim();
    if (!isValidUrl(value)) {
      shakeInput();
      showError("URL tidak valid. Silakan masukkan URL yang benar.");
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    resetProcessUI();
    form.hidden = true;
    processView.hidden = false;

    var state = { done: false, error: false, data: null };

    callApi(value).then(function (data) {
      state.data = data;
      state.done = true;
    }).catch(function (err) {
      state.error = true;
      state.message = err && err.message ? err.message : "URL tidak dapat diproses";
    });

    runProgress(state).then(function (ok) {
      if (!ok) {
        resetProcessUI();
        showForm();
        showError(state.message || "URL tidak dapat diproses");
        return;
      }
      // 100%: spinner berhenti -> scale -> centang -> glow
      resultUrl = state.data.url;
      spinner.classList.add("done");
      statusEl.textContent = "Complete!";
      setTimeout(function () {
        destUrl.textContent = resultUrl;
        result.hidden = false;
        statusEl.hidden = true;
        openBtn.focus();
      }, 900);
    });
  });

  /* ---------- Tombol hasil ---------- */
  openBtn.addEventListener("click", function () {
    if (!isValidUrl(resultUrl)) { showError("URL tidak valid. Silakan masukkan URL yang benar."); return; }
    window.open(resultUrl, "_blank", "noopener,noreferrer");
  });

  againBtn.addEventListener("click", function () {
    resetProcessUI();
    resultUrl = "";
    input.value = "";
    clearTimeout(toastTimer);
    toast.hidden = true;
    showForm();
    input.focus();
  });
})();
