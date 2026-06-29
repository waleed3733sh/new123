const fieldIds = [
  "companyName",
  "contractType",
  "strike",
  "contractDate",
  "entryPrice",
  "target1",
  "target2",
  "target3",
  "stopLoss"
];

const form = document.querySelector("#recommendationForm");
const sendButton = document.querySelector("#sendButton");
const toast = document.querySelector("#toast");
const connectionStatus = document.querySelector("#connectionStatus");
const saveSettingsButton = document.querySelector("#saveSettings");
const clearSettingsButton = document.querySelector("#clearSettings");
const botTokenInput = document.querySelector("#botToken");
const chatIdInput = document.querySelector("#chatId");
const historyList = document.querySelector("#historyList");
const refreshHistoryButton = document.querySelector("#refreshHistory");
const sendWeeklySummaryButton = document.querySelector("#sendWeeklySummary");
const weeklyTotal = document.querySelector("#weeklyTotal");
const weeklyCompleted = document.querySelector("#weeklyCompleted");
const weeklyPending = document.querySelector("#weeklyPending");

const storageKeys = {
  token: "botmaster.session.botToken",
  chatId: "botmaster.session.chatId"
};

let envReady = false;
let toastTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  restoreSessionSettings();
  bindPreviewUpdates();
  refreshStatus();
  loadHistory();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!form.reportValidity()) {
    showToast("أكمل الحقول المطلوبة قبل الإرسال.", "error");
    return;
  }

  const telegram = getTelegramSettingsFromInputs();
  if (!envReady && (!telegram.botToken || !telegram.chatId)) {
    showToast("أضف Bot Token و Chat ID أو جهّزهما في الخادم.", "error");
    return;
  }

  const payload = {
    recommendation: getRecommendationData()
  };

  if (telegram.botToken || telegram.chatId) {
    payload.telegram = telegram;
  }

  setSending(true);

  try {
    const result = await requestJson("/api/send-recommendation", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    showToast(result.message, "success");
    loadHistory();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setSending(false);
  }
});

form.addEventListener("reset", () => {
  window.setTimeout(updatePreview, 0);
});

saveSettingsButton.addEventListener("click", () => {
  const token = botTokenInput.value.trim();
  const chatId = chatIdInput.value.trim();

  if (!token || !chatId) {
    showToast("أدخل Bot Token و Chat ID أولًا.", "error");
    return;
  }

  sessionStorage.setItem(storageKeys.token, token);
  sessionStorage.setItem(storageKeys.chatId, chatId);
  showToast("تم حفظ بيانات الربط لهذه الجلسة.", "success");
  setConnectionStatus("جاهز عبر إعدادات الجلسة", "ready");
});

clearSettingsButton.addEventListener("click", () => {
  botTokenInput.value = "";
  chatIdInput.value = "";
  sessionStorage.removeItem(storageKeys.token);
  sessionStorage.removeItem(storageKeys.chatId);
  showToast("تم مسح بيانات الجلسة.", "success");
  refreshStatus();
});

refreshHistoryButton.addEventListener("click", () => {
  loadHistory();
});

sendWeeklySummaryButton.addEventListener("click", async () => {
  const telegram = getTelegramSettingsFromInputs();
  if (!envReady && (!telegram.botToken || !telegram.chatId)) {
    showToast("أضف بيانات تيليجرام قبل إرسال الملخص.", "error");
    return;
  }

  const payload = {};
  if (telegram.botToken || telegram.chatId) {
    payload.telegram = telegram;
  }

  setSummarySending(true);

  try {
    const result = await requestJson("/api/send-weekly-summary", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    showToast(result.message, "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setSummarySending(false);
  }
});

historyList.addEventListener("click", async (event) => {
  const saveButton = event.target.closest("[data-save-exit]");
  if (!saveButton) return;

  const card = saveButton.closest(".history-item");
  const input = card.querySelector("[data-exit-input]");
  const id = saveButton.dataset.saveExit;

  saveButton.disabled = true;
  saveButton.textContent = "جار الحفظ...";

  try {
    const result = await requestJson(`/api/recommendations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ exitPrice: input.value.trim() })
    });
    showToast(result.message, "success");
    await loadHistory();
  } catch (error) {
    showToast(error.message, "error");
    saveButton.disabled = false;
    saveButton.textContent = "حفظ";
  }
});

function bindPreviewUpdates() {
  fieldIds.forEach((id) => {
    const field = document.querySelector(`#${id}`);
    field.addEventListener("input", updatePreview);
    field.addEventListener("change", updatePreview);
  });
  updatePreview();
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    envReady = Boolean(status.envReady);

    if (envReady) {
      setConnectionStatus("ربط الخادم جاهز", "ready");
      return;
    }

    if (botTokenInput.value.trim() && chatIdInput.value.trim()) {
      setConnectionStatus("جاهز عبر إعدادات الجلسة", "ready");
      return;
    }

    setConnectionStatus("بانتظار بيانات تيليجرام", "warn");
  } catch (error) {
    setConnectionStatus("تعذر فحص الربط", "error");
  }
}

async function loadHistory() {
  try {
    const result = await requestJson("/api/recommendations");
    renderSummaryStats(result.summary);
    renderHistory(result.records);
  } catch (error) {
    renderHistory([]);
    showToast("تعذر تحميل سجل العقود.", "error");
  }
}

function renderSummaryStats(summary) {
  weeklyTotal.textContent = summary ? summary.totalCount : "0";
  weeklyCompleted.textContent = summary ? summary.completedCount : "0";
  weeklyPending.textContent = summary ? summary.pendingCount : "0";
}

function renderHistory(records) {
  historyList.textContent = "";

  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "لا توجد عقود مرسلة محفوظة بعد.";
    historyList.append(empty);
    return;
  }

  records.forEach((record) => {
    historyList.append(createHistoryItem(record));
  });
}

function createHistoryItem(record) {
  const card = document.createElement("article");
  card.className = "history-item";

  const header = document.createElement("div");
  header.className = "history-item-header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = record.companyName || "—";
  const meta = document.createElement("span");
  meta.textContent = `${record.contractType || "—"} · ${formatDateTime(record.sentAt)}`;
  titleWrap.append(title, meta);

  const badge = document.createElement("span");
  badge.className = record.exitPrice ? "record-badge done" : "record-badge";
  badge.textContent = record.exitPrice ? "مكتمل" : "بانتظار الخروج";

  header.append(titleWrap, badge);

  const metrics = document.createElement("div");
  metrics.className = "history-metrics";
  metrics.append(
    createMetric("سعر الدخول", record.entryPrice || "—"),
    createMetric("الهدف الأول", record.target1 || "—"),
    createMetric("وقف الخسارة", record.stopLoss || "—")
  );

  const exitRow = document.createElement("div");
  exitRow.className = "exit-row";

  const exitField = document.createElement("label");
  exitField.className = "field exit-field";
  const exitLabel = document.createElement("span");
  exitLabel.textContent = "سعر الخروج / أعلى تحقيق";
  const exitInput = document.createElement("input");
  exitInput.type = "text";
  exitInput.placeholder = "مثال: 2.45";
  exitInput.value = record.exitPrice || "";
  exitInput.setAttribute("data-exit-input", record.id);
  exitField.append(exitLabel, exitInput);

  const profitMetric = createMetric("نسبة الربح", getProfitText(record));
  profitMetric.classList.add(getProfitTone(record));

  const saveButton = document.createElement("button");
  saveButton.className = "small-button";
  saveButton.type = "button";
  saveButton.textContent = "حفظ";
  saveButton.dataset.saveExit = record.id;

  exitRow.append(exitField, profitMetric, saveButton);
  card.append(header, metrics, exitRow);
  return card;
}

function createMetric(label, value) {
  const metric = document.createElement("div");
  metric.className = "metric";
  const labelElement = document.createElement("span");
  labelElement.textContent = label;
  const valueElement = document.createElement("strong");
  valueElement.textContent = value;
  metric.append(labelElement, valueElement);
  return metric;
}

function getProfitText(record) {
  const entry = parsePrice(record.entryPrice);
  const exit = parsePrice(record.exitPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return "—";

  const profit = ((exit - entry) / entry) * 100;
  return `${profit > 0 ? "+" : ""}${profit.toFixed(2)}%`;
}

function getProfitTone(record) {
  const entry = parsePrice(record.entryPrice);
  const exit = parsePrice(record.exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return "";
  return exit >= entry ? "profit-positive" : "profit-negative";
}

function parsePrice(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[٠-٩]/g, (digit) => "٠١٢٣٤٥٦٧٨٩".indexOf(digit))
    .replace(/[۰-۹]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit))
    .replace(/[,$%]/g, "")
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function restoreSessionSettings() {
  botTokenInput.value = sessionStorage.getItem(storageKeys.token) || "";
  chatIdInput.value = sessionStorage.getItem(storageKeys.chatId) || "";
}

function getRecommendationData() {
  return fieldIds.reduce((data, id) => {
    data[id] = document.querySelector(`#${id}`).value.trim();
    return data;
  }, {});
}

function getTelegramSettingsFromInputs() {
  return {
    botToken: botTokenInput.value.trim(),
    chatId: chatIdInput.value.trim()
  };
}

function updatePreview() {
  const data = getRecommendationData();

  fieldIds.forEach((id) => {
    const element = document.querySelector(`[data-preview="${id}"]`);
    if (!element) return;

    const value = id === "contractDate" ? formatDate(data[id]) : data[id];
    element.textContent = value || "—";
  });
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("ar-SA", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("ar-SA", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function setSending(isSending) {
  sendButton.disabled = isSending;
  sendButton.textContent = isSending ? "جار الإرسال..." : "إرسال إلى تيليجرام";
}

function setSummarySending(isSending) {
  sendWeeklySummaryButton.disabled = isSending;
  sendWeeklySummaryButton.textContent = isSending ? "جار إرسال الملخص..." : "إرسال ملخص الأسبوع";
}

function setConnectionStatus(text, tone) {
  connectionStatus.textContent = text;
  connectionStatus.className = `status-pill ${tone || ""}`.trim();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const result = await response.json();

  if (!response.ok || result.ok === false) {
    throw new Error(result.message || "تعذر تنفيذ الطلب.");
  }

  return result;
}

function showToast(message, tone) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${tone || ""}`.trim();

  toastTimer = window.setTimeout(() => {
    toast.className = "toast";
  }, 3600);
}
