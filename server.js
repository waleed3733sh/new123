const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const RECORDS_FILE = path.join(DATA_DIR, "recommendations.json");
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 64 * 1024;
const SUMMARY_DAYS = 7;
const DISCLAIMER =
  "هذه ليست توصية للشراء أو البيع، وإنما نظرة فنية، والشراء والبيع مسؤوليتك الشخصية.";

loadEnvFile(path.join(ROOT_DIR, ".env"));

const PORT = Number(process.env.PORT || DEFAULT_PORT);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, getStatus());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/recommendations") {
      sendJson(res, 200, getRecommendationHistory());
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/recommendations/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/recommendations/", ""));
      const body = await readJson(req);
      sendJson(res, 200, updateRecommendationRecord(id, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-recommendation") {
      const body = await readJson(req);
      const result = await sendRecommendation(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-weekly-summary") {
      const body = await readJson(req);
      const result = await sendWeeklySummary(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET") {
      serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { ok: false, message: "طريقة الطلب غير مدعومة." });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      ok: false,
      message: error.publicMessage || "تعذر تنفيذ الطلب.",
      detail: status >= 500 ? undefined : error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`BotMaster is running on http://localhost:${PORT}`);
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts
      .join("=")
      .trim()
      .replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key.trim()] = value;
    }
  }
}

function getStatus() {
  const hasEnvToken = Boolean(process.env.BOTMASTER_BOT_TOKEN);
  const hasEnvChat = Boolean(process.env.BOTMASTER_CHAT_ID);

  return {
    ok: true,
    envReady: hasEnvToken && hasEnvChat,
    hasEnvToken,
    hasEnvChat
  };
}

function getRecommendationHistory() {
  const records = readRecords().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

  return {
    ok: true,
    records,
    summary: buildWeeklySummaryData(records)
  };
}

function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const decodedPath = decodeURIComponent(cleanPath).replace(/^\/+/, "");
  const absolutePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (!isPathInside(PUBLIC_DIR, absolutePath)) {
    sendJson(res, 403, { ok: false, message: "المسار غير مسموح." });
    return;
  }

  fs.stat(absolutePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { ok: false, message: "الملف غير موجود." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(absolutePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(absolutePath).pipe(res);
  });
}

function isPathInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
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

async function sendRecommendation(body) {
  const data = normalizeRecommendation(body.recommendation || body);
  const { botToken, chatId } = getTelegramSettings(body);

  validateRecommendation(data);
  validateTelegramSettings(botToken, chatId);

  const message = buildTelegramMessage(data);
  const telegramResponse = await postTelegramMessage(botToken, {
    chat_id: chatId,
    text: message,
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

function cleanText(value) {
  return String(value || "").trim();
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
    error.publicMessage = "أدخل Bot Token و Chat ID أو أضفهما في ملف .env.";
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
  const cleanId = cleanText(id);
  const exitPrice = cleanText(body.exitPrice);
  const records = readRecords();
  const index = records.findIndex((record) => record.id === cleanId);

  if (index === -1) {
    const error = new Error("العقد غير موجود في السجل.");
    error.statusCode = 404;
    error.publicMessage = "لم يتم العثور على العقد المطلوب.";
    throw error;
  }

  records[index] = {
    ...records[index],
    exitPrice,
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

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(RECORDS_FILE)) {
    fs.writeFileSync(RECORDS_FILE, "[]\n", "utf8");
  }
}

function readRecords() {
  ensureDataStore();

  try {
    const records = JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8"));
    return Array.isArray(records) ? records : [];
  } catch (error) {
    return [];
  }
}

function writeRecords(records) {
  ensureDataStore();
  fs.writeFileSync(RECORDS_FILE, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
