const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const PROJECT_ROOT = path.join(__dirname, "..");
const LOCAL_RECORDS_FILE = path.join(PROJECT_ROOT, "recommendations.json");
const TMP_RECORDS_FILE = path.join(os.tmpdir(), "botmaster-recommendations.json");
const MAX_BODY_BYTES = 64 * 1024;
const SUMMARY_DAYS = 7;
const DISCLAIMER =
  "هذه ليست توصية للشراء أو البيع، وإنما نظرة فنية، والشراء والبيع مسؤوليتك الشخصية.";

const fieldLabels = {
  companyName: "اسم الشركة",
  contractType: "نوع العقد",
  strike: "الاسترايك",
  contractDate: "تاريخ العقد",
  entryPrice: "سعر الدخول",
  target1: "الهدف الأول",
  target2: "الهدف الثاني",
  target3: "الهدف الثالث",
  stopLoss: "وقف الخسارة"
};

async function handleStatus(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "طريقة الطلب غير مدعومة." });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    envReady: Boolean(process.env.BOTMASTER_BOT_TOKEN && process.env.BOTMASTER_CHAT_ID),
    hasEnvToken: Boolean(process.env.BOTMASTER_BOT_TOKEN),
    hasEnvChat: Boolean(process.env.BOTMASTER_CHAT_ID)
  });
}

async function handleRecommendations(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "طريقة الطلب غير مدعومة." });
    return;
  }

  const records = readRecords().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
  sendJson(res, 200, {
    ok: true,
    records,
    summary: buildWeeklySummaryData(records)
  });
}

async function handleRecommendationRecord(req, res) {
  if (req.method !== "PATCH") {
    sendJson(res, 405, { ok: false, message: "طريقة الطلب غير مدعومة." });
    return;
  }

  try {
    const id = getRecordId(req);
    const body = await readJson(req);
    sendJson(res, 200, updateRecommendationRecord(id, body));
  } catch (error) {
    sendError(res, error);
  }
}

async function handleSendRecommendation(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "طريقة الطلب غير مدعومة." });
    return;
  }

  try {
    const body = await readJson(req);
    const result = await sendRecommendation(body);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error);
  }
}

async function handleSendWeeklySummary(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "طريقة الطلب غير مدعومة." });
    return;
  }

  try {
    const body = await readJson(req);
    const result = await sendWeeklySummary(body);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error);
  }
}

async function sendRecommendation(body) {
  const data = normalizeRecommendation(body.recommendation || body);
  const { botToken, chatId } = getTelegramSettings(body);

  validateRecommendation(data);
  validateTelegramSettings(botToken, chatId);

  const telegramResponse = await postTelegramMessage(botToken, {
    chat_id: chatId,
    text: buildTelegramMessage(data),
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  if (!telegramResponse.body.ok) {
    const error = new Error(telegramResponse.body.description || "رفض تيليجرام الطلب.");
    error.statusCode = 502;
    error.publicMessage = "تعذر إرسال التوصية إلى تيليجرام.";
    throw error;
  }

  const record = saveSentRecommendation(data, telegramResponse.body.result || {});

  return {
    ok: true,
    message: "تم إرسال التوصية إلى تيليجرام وحفظها في السجل بنجاح.",
    telegramMessageId: record.telegramMessageId,
    record
  };
}

async function sendWeeklySummary(body) {
  const { botToken, chatId } = getTelegramSettings(body);
  validateTelegramSettings(botToken, chatId);

  const summary = buildWeeklySummaryData(readRecords());
  if (!summary.rows.length) {
    const error = new Error("لا توجد عقود مكتملة بسعر خروج ضمن فترة الملخص.");
    error.statusCode = 400;
    error.publicMessage = "أضف سعر الخروج أو أعلى تحقيق للعقود المرسلة قبل إرسال الملخص.";
    throw error;
  }

  const telegramResponse = await postTelegramMessage(botToken, {
    chat_id: chatId,
    text: buildWeeklySummaryMessage(summary),
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  if (!telegramResponse.body.ok) {
    const error = new Error(telegramResponse.body.description || "رفض تيليجرام الطلب.");
    error.statusCode = 502;
    error.publicMessage = "تعذر إرسال الملخص الأسبوعي إلى تيليجرام.";
    throw error;
  }

  return {
    ok: true,
    message: "تم إرسال الملخص الأسبوعي إلى تيليجرام بنجاح.",
    summary,
    telegramMessageId: telegramResponse.body.result && telegramResponse.body.result.message_id
  };
}

function getTelegramSettings(body) {
  const settings = body.telegram || {};

  return {
    botToken: cleanText(process.env.BOTMASTER_BOT_TOKEN || settings.botToken),
    chatId: cleanText(process.env.BOTMASTER_CHAT_ID || settings.chatId)
  };
}

function normalizeRecommendation(data) {
  return Object.keys(fieldLabels).reduce((result, key) => {
    result[key] = cleanText(data[key]);
    return result;
  }, {});
}

function validateRecommendation(data) {
  const missing = Object.entries(fieldLabels)
    .filter(([key]) => !data[key])
    .map(([, label]) => label);

  if (missing.length) {
    const error = new Error(`حقول مطلوبة: ${missing.join("، ")}`);
    error.statusCode = 400;
    error.publicMessage = "أكمل بيانات التوصية قبل الإرسال.";
    throw error;
  }
}

function validateTelegramSettings(botToken, chatId) {
  if (!botToken || !chatId) {
    const error = new Error("بيانات تيليجرام غير مكتملة.");
    error.statusCode = 400;
    error.publicMessage = "أدخل Bot Token و Chat ID أو أضفهما في Vercel Environment Variables.";
    throw error;
  }

  if (!/^\d{6,14}:[A-Za-z0-9_-]{25,}$/.test(botToken)) {
    const error = new Error("صيغة Bot Token غير صحيحة.");
    error.statusCode = 400;
    error.publicMessage = "تحقق من صيغة Bot Token.";
    throw error;
  }
}

function buildTelegramMessage(data) {
  return [
    "<b>BotMaster | توصية فنية</b>",
    "━━━━━━━━━━━━━━",
    `<b>اسم الشركة:</b> ${escapeHtml(data.companyName)}`,
    `<b>نوع العقد:</b> ${escapeHtml(data.contractType)}`,
    `<b>الاسترايك:</b> ${escapeHtml(data.strike)}`,
    `<b>تاريخ العقد:</b> ${escapeHtml(data.contractDate)}`,
    `<b>سعر الدخول:</b> ${escapeHtml(data.entryPrice)}`,
    "",
    "<b>الأهداف:</b>",
    `1) ${escapeHtml(data.target1)}`,
    `2) ${escapeHtml(data.target2)}`,
    `3) ${escapeHtml(data.target3)}`,
    "",
    `<b>وقف الخسارة:</b> ${escapeHtml(data.stopLoss)}`,
    "━━━━━━━━━━━━━━",
    `<i>${DISCLAIMER}</i>`
  ].join("\n");
}

function buildWeeklySummaryMessage(summary) {
  const lines = [
    "<b>BotMaster | ملخص الأسبوع</b>",
    `الفترة: ${escapeHtml(summary.periodStart)} إلى ${escapeHtml(summary.periodEnd)}`,
    "━━━━━━━━━━━━━━"
  ];

  summary.rows.forEach((row, index) => {
    lines.push(
      `<b>${index + 1}) ${escapeHtml(row.companyName)}</b>`,
      `سعر الدخول: ${escapeHtml(row.entryPrice)}`,
      `سعر الخروج: ${escapeHtml(row.exitPrice)}`,
      `نسبة الربح: ${escapeHtml(row.profitText)}`,
      ""
    );
  });

  lines.push(`العقود المكتملة: ${summary.completedCount}`);
  if (summary.pendingCount) {
    lines.push(`بانتظار سعر خروج: ${summary.pendingCount}`);
  }

  return lines.join("\n").trim();
}

function saveSentRecommendation(data, telegramResult) {
  const records = readRecords();
  const record = {
    id: randomUUID(),
    ...data,
    exitPrice: "",
    sentAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    telegramMessageId: telegramResult.message_id || null
  };

  records.push(record);
  writeRecords(records);
  return record;
}

function updateRecommendationRecord(id, body) {
  const records = readRecords();
  const index = records.findIndex((record) => record.id === cleanText(id));

  if (index === -1) {
    const error = new Error("العقد غير موجود في السجل.");
    error.statusCode = 404;
    error.publicMessage = "لم يتم العثور على العقد المطلوب.";
    throw error;
  }

  records[index] = {
    ...records[index],
    exitPrice: cleanText(body.exitPrice),
    updatedAt: new Date().toISOString()
  };

  writeRecords(records);

  return {
    ok: true,
    message: "تم حفظ سعر الخروج للعقد.",
    record: records[index],
    summary: buildWeeklySummaryData(records)
  };
}

function buildWeeklySummaryData(records) {
  const { start, end } = getSummaryWindow();
  const weeklyRecords = records.filter((record) => {
    const sentAt = new Date(record.sentAt);
    return sentAt >= start && sentAt <= end;
  });

  const rows = weeklyRecords
    .map((record) => {
      const entry = parsePrice(record.entryPrice);
      const exit = parsePrice(record.exitPrice);
      const hasProfit = Number.isFinite(entry) && entry > 0 && Number.isFinite(exit);
      const profit = hasProfit ? ((exit - entry) / entry) * 100 : null;

      return {
        id: record.id,
        companyName: record.companyName,
        entryPrice: record.entryPrice,
        exitPrice: record.exitPrice,
        profit,
        profitText: hasProfit ? formatPercent(profit) : ""
      };
    })
    .filter((row) => row.profitText);

  return {
    periodStart: formatDateOnly(start),
    periodEnd: formatDateOnly(end),
    totalCount: weeklyRecords.length,
    completedCount: rows.length,
    pendingCount: weeklyRecords.length - rows.length,
    rows
  };
}

function getSummaryWindow() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(end.getDate() - (SUMMARY_DAYS - 1));
  start.setHours(0, 0, 0, 0);

  return { start, end };
}

function readRecords() {
  const preferredFile = fs.existsSync(TMP_RECORDS_FILE) ? TMP_RECORDS_FILE : LOCAL_RECORDS_FILE;

  try {
    const records = JSON.parse(fs.readFileSync(preferredFile, "utf8"));
    return Array.isArray(records) ? records : [];
  } catch (error) {
    return [];
  }
}

function writeRecords(records) {
  const payload = `${JSON.stringify(records, null, 2)}\n`;

  try {
    fs.writeFileSync(LOCAL_RECORDS_FILE, payload, "utf8");
  } catch (error) {
    fs.writeFileSync(TMP_RECORDS_FILE, payload, "utf8");
  }
}

function getRecordId(req) {
  if (req.query && req.query.id) {
    return Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  }

  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || "");
}

function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }

  if (typeof req.body === "string") {
    return Promise.resolve(req.body ? JSON.parse(req.body) : {});
  }

  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        const error = new Error("حجم الطلب أكبر من المسموح.");
        error.statusCode = 413;
        error.publicMessage = "حجم الطلب أكبر من المسموح.";
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        error.statusCode = 400;
        error.publicMessage = "صيغة البيانات غير صحيحة.";
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function postTelegramMessage(botToken, payload) {
  const requestBody = JSON.stringify(payload);
  const url = new URL(`/bot${botToken}/sendMessage`, "https://api.telegram.org");

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(requestBody)
        },
        timeout: 15000
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let parsedBody = {};
          try {
            parsedBody = body ? JSON.parse(body) : {};
          } catch (error) {
            parsedBody = { ok: false, description: "رد تيليجرام غير مفهوم." };
          }

          resolve({
            statusCode: response.statusCode,
            body: parsedBody
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("انتهت مهلة الاتصال بتيليجرام."));
    });
    request.on("error", (error) => {
      error.statusCode = 502;
      error.publicMessage = "تعذر الاتصال بخدمة تيليجرام.";
      reject(error);
    });

    request.write(requestBody);
    request.end();
  });
}

function parsePrice(value) {
  const normalized = toEnglishDigits(cleanText(value))
    .replace(/[,$%]/g, "")
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function toEnglishDigits(value) {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";

  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = arabicDigits.indexOf(digit);
    if (arabicIndex >= 0) return String(arabicIndex);
    return String(persianDigits.indexOf(digit));
  });
}

function formatPercent(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function cleanText(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, {
    ok: false,
    message: error.publicMessage || "تعذر تنفيذ الطلب.",
    detail: statusCode >= 500 ? undefined : error.message
  });
}

module.exports = {
  handleStatus,
  handleRecommendations,
  handleRecommendationRecord,
  handleSendRecommendation,
  handleSendWeeklySummary
};
