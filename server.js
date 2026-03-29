require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");
const AdmZip = require("adm-zip");
const Tesseract = require("tesseract.js");
const { adaptPrompt, normalizeLanguage: normalizePromptLanguage, resolvePreset } = require("./lib/prompt-engine");
const { buildContextPack, suggestRelatedPages, formatPageList } = require("./lib/context-builder");
const {
  ensureSessionReviewState,
  storeGeneratedDeck,
  reviewDeckCard,
  buildReviewQueue,
  buildProgressSummary,
  recordQuizAttempt,
  recordStudyEvent,
} = require("./lib/review-engine");

const app = express();
const PORT = process.env.PORT || 3030;
const HOST = process.env.HOST || (isRunningInDocker() ? "0.0.0.0" : "127.0.0.1");

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const PREVIEWS_DIR = path.join(DATA_DIR, "previews");
const UPLOADS_DIR = path.join(__dirname, "uploads");

[DATA_DIR, SESSIONS_DIR, PREVIEWS_DIR, UPLOADS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PPT_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);
const DOCX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const PROVIDER_PRESETS = {
  gemini: {
    name: "Google Gemini",
    baseUrl: "",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash-preview-05-20", "gemini-2.5-pro-preview-05-06"],
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openai: {
    name: "OpenAI (ChatGPT)",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano", "o4-mini"],
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  ollama: {
    name: "Ollama (Yerel)",
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    defaultModel: "llama3",
    models: ["llama3", "llama3.1", "mistral", "codellama", "gemma2", "phi3", "qwen2"],
    needsKey: false,
    keyUrl: "",
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    needsKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  custom: {
    name: "Ozel (OpenAI Uyumlu)",
    baseUrl: "",
    defaultModel: "",
    models: [],
    needsKey: true,
    keyUrl: "",
  },
};

const RESPONSE_LANGUAGE_LABELS = {
  "tr-TR": "Turkish",
  "en-US": "English",
  "ru-RU": "Russian",
  "ko-KR": "Korean",
  "de-DE": "German",
  "fr-FR": "French",
  "ar-SA": "Arabic",
  "es-ES": "Spanish",
};

const UI_LOCALES = ["tr-TR", "en-US", "ru-RU", "ko-KR"];

function sendError(res, status, code, message, hint = "", extra = {}) {
  return res.status(status).json({ success: false, code, message, hint, error: message, ...extra });
}

function isValidSessionId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function isRunningInDocker() {
  return fs.existsSync("/.dockerenv") || process.env.DOCKER_CONTAINER === "true";
}

function normalizeOllamaBaseUrl(baseUrl) {
  const fallback = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const raw = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : fallback;

  try {
    const url = new URL(raw);
    const runningInDocker = isRunningInDocker();

    if (runningInDocker && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      url.hostname = "host.docker.internal";
    }

    if (!runningInDocker && url.hostname === "host.docker.internal") {
      url.hostname = "localhost";
    }

    const cleanPath = (url.pathname || "").replace(/\/+$/, "");
    if (!cleanPath || cleanPath === "/api") {
      url.pathname = "/v1";
    } else if (!cleanPath.endsWith("/v1")) {
      url.pathname = `${cleanPath}/v1`;
    } else {
      url.pathname = cleanPath;
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function maskKey(value) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 10) return `${value.slice(0, 3)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function hasConfiguredKey(profile) {
  return !!profile?.apiKey && profile.apiKey !== "your_api_key_here";
}

function providerNeedsKey(providerOrConfig) {
  const provider = typeof providerOrConfig === "string"
    ? providerOrConfig
    : providerOrConfig?.provider;
  return PROVIDER_PRESETS[provider]?.needsKey !== false;
}

function getProviderEnvDefaults(provider) {
  const preset = PROVIDER_PRESETS[provider] || {};
  switch (provider) {
    case "gemini":
      return {
        apiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || "",
        model: process.env.GEMINI_MODEL || process.env.AI_MODEL || preset.defaultModel || "",
        baseUrl: "",
      };
    case "openai":
      return {
        apiKey: process.env.OPENAI_API_KEY || "",
        model: process.env.OPENAI_MODEL || preset.defaultModel || "",
        baseUrl: process.env.OPENAI_BASE_URL || preset.baseUrl || "",
      };
    case "groq":
      return {
        apiKey: process.env.GROQ_API_KEY || "",
        model: process.env.GROQ_MODEL || preset.defaultModel || "",
        baseUrl: process.env.GROQ_BASE_URL || preset.baseUrl || "",
      };
    case "deepseek":
      return {
        apiKey: process.env.DEEPSEEK_API_KEY || "",
        model: process.env.DEEPSEEK_MODEL || preset.defaultModel || "",
        baseUrl: process.env.DEEPSEEK_BASE_URL || preset.baseUrl || "",
      };
    case "ollama":
      return {
        apiKey: "",
        model: process.env.OLLAMA_MODEL || preset.defaultModel || "",
        baseUrl: process.env.OLLAMA_BASE_URL || preset.baseUrl || "",
      };
    case "custom":
      return {
        apiKey: process.env.CUSTOM_API_KEY || process.env.API_KEY || "",
        model: process.env.CUSTOM_MODEL || process.env.AI_MODEL || "",
        baseUrl: process.env.CUSTOM_BASE_URL || process.env.API_BASE_URL || "",
      };
    default:
      return {
        apiKey: "",
        model: preset.defaultModel || "",
        baseUrl: preset.baseUrl || "",
      };
  }
}

function guessProviderFromApiKey(apiKey) {
  if (typeof apiKey !== "string") return "custom";
  const trimmed = apiKey.trim();
  if (/^AIza/i.test(trimmed)) return "gemini";
  if (/^gsk_/i.test(trimmed)) return "groq";
  if (/^sk-/i.test(trimmed)) return "openai";
  return "custom";
}

function normalizeLastTest(rawLastTest) {
  if (!rawLastTest || typeof rawLastTest !== "object") return null;
  return {
    status: rawLastTest.status === "ok" ? "ok" : "error",
    testedAt: Number.isFinite(rawLastTest.testedAt) ? rawLastTest.testedAt : Date.now(),
    latencyMs: Number.isFinite(rawLastTest.latencyMs) ? rawLastTest.latencyMs : null,
    message: typeof rawLastTest.message === "string" ? rawLastTest.message : "",
    hint: typeof rawLastTest.hint === "string" ? rawLastTest.hint : "",
    code: typeof rawLastTest.code === "string" ? rawLastTest.code : "",
    baseUrl: typeof rawLastTest.baseUrl === "string" ? rawLastTest.baseUrl : "",
    sample: typeof rawLastTest.sample === "string" ? rawLastTest.sample : "",
    modelOrigin: typeof rawLastTest.modelOrigin === "string" ? rawLastTest.modelOrigin : "",
    availableModels: Array.isArray(rawLastTest.availableModels)
      ? rawLastTest.availableModels.filter((item) => typeof item === "string")
      : [],
  };
}

function buildLastTestRecord(status, payload = {}) {
  return normalizeLastTest({
    status,
    testedAt: Date.now(),
    latencyMs: payload.latencyMs ?? null,
    message: payload.message || "",
    hint: payload.hint || "",
    code: payload.code || "",
    baseUrl: payload.baseUrl || "",
    sample: payload.sample || "",
    modelOrigin: payload.modelOrigin || "",
    availableModels: payload.availableModels || [],
  });
}

function normalizeProviderProfile(provider, rawProfile = {}) {
  const preset = PROVIDER_PRESETS[provider] || {};
  const envDefaults = getProviderEnvDefaults(provider);
  const needsKey = providerNeedsKey(provider);

  let apiKey = typeof rawProfile?.apiKey === "string"
    ? rawProfile.apiKey.trim()
    : envDefaults.apiKey;
  let model = typeof rawProfile?.model === "string" && rawProfile.model.trim()
    ? rawProfile.model.trim()
    : (envDefaults.model || preset.defaultModel || "");
  let baseUrl = typeof rawProfile?.baseUrl === "string"
    ? rawProfile.baseUrl.trim()
    : (envDefaults.baseUrl || preset.baseUrl || "");

  if (provider === "ollama") {
    apiKey = "";
    baseUrl = normalizeOllamaBaseUrl(baseUrl || preset.baseUrl || envDefaults.baseUrl || "");
  } else if (provider !== "custom" && !baseUrl) {
    baseUrl = preset.baseUrl || "";
  }

  if (!needsKey) apiKey = "";

  return {
    apiKey,
    model: model || preset.defaultModel || "",
    baseUrl,
    lastTest: normalizeLastTest(rawProfile?.lastTest),
  };
}

function normalizeAppConfig(rawConfig) {
  const fallbackProvider = rawConfig?.activeProvider && PROVIDER_PRESETS[rawConfig.activeProvider]
    ? rawConfig.activeProvider
    : rawConfig?.provider && PROVIDER_PRESETS[rawConfig.provider]
      ? rawConfig.provider
      : process.env.AI_PROVIDER || "gemini";

  const legacyProfiles = {};
  if (!rawConfig?.profiles && typeof rawConfig?.apiKey === "string" && rawConfig.apiKey.trim()) {
    const legacyKeyProvider = providerNeedsKey(fallbackProvider)
      ? fallbackProvider
      : guessProviderFromApiKey(rawConfig.apiKey);

    legacyProfiles[legacyKeyProvider] = {
      apiKey: rawConfig.apiKey,
      model: rawConfig.model,
      baseUrl: rawConfig.baseUrl,
      lastTest: rawConfig.lastTest,
    };
  }

  const profiles = {};
  for (const provider of Object.keys(PROVIDER_PRESETS)) {
    const rawProfile = rawConfig?.profiles && typeof rawConfig.profiles[provider] === "object"
      ? rawConfig.profiles[provider]
      : legacyProfiles[provider]
        ? legacyProfiles[provider]
      : (provider === fallbackProvider && !rawConfig?.profiles
        ? {
            model: rawConfig?.model,
            baseUrl: rawConfig?.baseUrl,
            lastTest: rawConfig?.lastTest,
          }
        : {});
    profiles[provider] = normalizeProviderProfile(provider, rawProfile);
  }

  return {
    activeProvider: fallbackProvider,
    profiles,
  };
}

function getProfileConfig(configState, provider) {
  return normalizeProviderProfile(provider, configState?.profiles?.[provider] || {});
}

function getActiveRuntimeConfig(configState = appConfig) {
  const activeProvider = configState?.activeProvider && PROVIDER_PRESETS[configState.activeProvider]
    ? configState.activeProvider
    : process.env.AI_PROVIDER || "gemini";
  return {
    provider: activeProvider,
    ...getProfileConfig(configState, activeProvider),
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return normalizeAppConfig(parsed);
    }
  } catch (e) {
    console.error("Config load error:", e.message);
  }
  return normalizeAppConfig({});
}

function saveConfig(configState) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalizeAppConfig(configState), null, 2), "utf-8");
  } catch (e) {
    console.error("Config save error:", e.message);
  }
}

let appConfig = loadConfig();
saveConfig(appConfig);

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system-prompt.md"), "utf-8");
const CHAT_SYSTEM_PROMPT = [
  "You are OmniTutor in document-grounded tutor mode.",
  "Use the uploaded documents as the primary source and the recent session as supporting context.",
  "You may explain concepts in your own words, connect related ideas, expand shallow headings, and teach step by step as long as the explanation stays anchored to the uploaded document topics.",
  "Do not introduce unrelated outside facts, names, dates, claims, or examples that the documents do not support.",
  "Use clean, minimal markdown only when it improves readability. Avoid decorative heading spam, excessive ** markers, or broken pseudo-tables.",
  "If you use a table, output a valid markdown table with a separator row.",
  "If the user asks to learn 'this topic', 'from scratch', says 'continue', or asks for a teaching style such as Feynman, infer the most relevant document topic and continue from the document flow.",
  "Treat small typos as likely references to nearby document concepts or requested teaching styles when the intent is clear.",
  "Reply exactly with [[OUT_OF_SCOPE_QUERY]] Belgede bulunamadi. only when the request is genuinely unrelated to the uploaded document topics.",
  "Default style: detailed, structured, exam-oriented, and concept-first.",
].join("\n");
const CHAT_HISTORY_WINDOW = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1800;
const CHAT_MAX_OUTPUT_TOKENS = 1600;
const GENERIC_MAX_OUTPUT_TOKENS = 2200;
const EXPLAIN_MAX_OUTPUT_TOKENS = 2000;
const MAX_DOC_CONTEXT_CHARS_PER_DOC = 5000;
const MAX_DOC_CONTEXT_TOTAL_CHARS = 14000;

function getResponseLanguageLabel(languageCode) {
  return RESPONSE_LANGUAGE_LABELS[languageCode] || RESPONSE_LANGUAGE_LABELS["tr-TR"];
}

function normalizeResponseLanguage(languageCode = "tr-TR") {
  return RESPONSE_LANGUAGE_LABELS[languageCode] ? languageCode : "tr-TR";
}

function normalizeUiLocale(localeCode = "en-US") {
  return UI_LOCALES.includes(localeCode) ? localeCode : "en-US";
}

function normalizeFontScale(fontScale = "normal") {
  return ["small", "normal", "large", "xlarge"].includes(fontScale) ? fontScale : "normal";
}

function buildTeacherStylePrompt(languageCode = "tr-TR") {
  const safeLanguage = normalizeResponseLanguage(languageCode);
  const targetLanguage = getResponseLanguageLabel(safeLanguage);
  const termRule = safeLanguage === "tr-TR"
    ? "For key academic terms, add short English equivalents in parentheses."
    : `Respond primarily in ${targetLanguage}. Keep key source terms in their original form where useful.`;

  return [
    "You are OmniTutor, a rigorous private tutor for classic written exams.",
    `Primary language must be ${targetLanguage}.`,
    termRule,
    "Follow the order of the provided source. Do not reorganize the topic randomly.",
    "Explain thoroughly but without filler.",
    "If a detail is missing from the source, say so clearly instead of inventing it.",
    "Prefer headings, numbered steps, and compact bullet lists.",
  ].join("\n");
}

function buildGenerationLanguageRules(languageCode = "tr-TR") {
  const safeLanguage = normalizeResponseLanguage(languageCode);
  const targetLanguage = getResponseLanguageLabel(safeLanguage);

  if (safeLanguage === "tr-TR") {
    return [
      "Tum kullaniciya gorunen icerigi Turkish yaz.",
      "Ana akademik terimlerde kisa English equivalent parantez icinde ver.",
      "Sadece kaynak dil English diye cevap dilini English yapma; temel yanit dili Turkish kalacak.",
    ].join("\n");
  }

  return [
    `Tum kullaniciya gorunen icerigi ${targetLanguage} yaz.`,
    "Turkish kullanma ve karisik dil kullanma.",
    "Kaynak terimleri gerekli oldugunda aynen koruyabilirsin, ancak aciklamayi hedef dilde yaz.",
  ].join("\n");
}

function buildChatModePrompt(mode = "deep") {
  const prompts = {
    deep: [
      "Current teaching mode: Deep Learn.",
      "Teach like a disciplined private tutor.",
      "Default format: 1) concept map, 2) detailed explanation, 3) why it matters, 4) common confusions, 5) short check question.",
      "When the user says continue, keep the same teaching depth and continue the same thread unless they explicitly change topic.",
    ],
    rapid: [
      "Current teaching mode: Rapid Review.",
      "Be compressed but not shallow.",
      "Default format: short overview, core bullets, exam-critical reminders, one mini recap question.",
    ],
    drill: [
      "Current teaching mode: Exam Drill.",
      "Act like an exam coach.",
      "Prefer classic written-exam style prompts, model answers, marking logic, and correction points.",
    ],
    viva: [
      "Current teaching mode: Oral Viva.",
      "Teach briefly, then challenge the user with follow-up viva-style questions and expected answer logic.",
    ],
    paper: [
      "Current teaching mode: Past Paper.",
      "Frame explanations around likely written exam questions, answer structure, and scoring criteria.",
    ],
  };

  return (prompts[mode] || prompts.deep).join("\n");
}

function getChatOutputTokens(mode = "deep") {
  switch (mode) {
    case "rapid":
      return 1000;
    case "drill":
    case "viva":
    case "paper":
      return 1400;
    case "deep":
    default:
      return 1800;
  }
}

function getQuizOutputTokens(count = 5, type = "multiple") {
  const safeCount = Math.max(1, Math.min(40, Number(count) || 5));
  const perQuestion = type === "classic" ? 240 : 180;
  return Math.min(9000, 1200 + safeCount * perQuestion);
}

function getFlashcardOutputTokens(count = 10) {
  const safeCount = Math.max(1, Math.min(60, Number(count) || 10));
  return Math.min(7000, 900 + safeCount * 130);
}

function getTeacherQuestionOutputTokens(preset = "auto", provider = "ollama", mode = "teach") {
  const safePreset = normalizePromptPreset(preset);
  const safeProvider = String(provider || "ollama").toLowerCase();
  const isCloud = safeProvider !== "ollama";

  if (mode === "check") {
    if (safePreset === "fast") return isCloud ? 360 : 460;
    if (safePreset === "balanced") return isCloud ? 480 : 620;
    if (safePreset === "deep") return isCloud ? 620 : 820;
    return isCloud ? 420 : 560;
  }

  if (safePreset === "fast") return isCloud ? 420 : 560;
  if (safePreset === "balanced") return isCloud ? 560 : 760;
  if (safePreset === "deep") return isCloud ? 780 : 1100;
  return isCloud ? 500 : 680;
}

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MAX_UPLOAD_FILE_SIZE_MB = 300;
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "text/plain",
      "text/markdown",
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowedExts = new Set([".pdf", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".ppt", ".pptx", ".docx"]);
    if (allowed.includes(file.mimetype) || allowedExts.has(ext)) cb(null, true);
    else cb(new Error("Desteklenmeyen dosya tipi. PDF, TXT, MD, DOCX, PNG, JPG, WEBP veya PPTX kullanin."));
  },
});

function handleUploadSingle(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return sendError(
          res,
          400,
          "FILE_TOO_LARGE",
          "Dosya boyutu limiti asildi.",
          `Maksimum yukleme boyutu ${MAX_UPLOAD_FILE_SIZE_MB}MB. Dosyayi kucultun veya parcalayin.`
        );
      }

      return sendError(res, 400, "UPLOAD_FAILED", "Dosya yukleme hatasi.", err.message || "Yukleme tekrar denenmeli.");
    }

    return sendError(
      res,
      400,
      "UNSUPPORTED_FILE_TYPE",
      "Desteklenmeyen dosya tipi.",
      err.message || "PDF, TXT, MD, DOCX, PNG, JPG, WEBP veya PPTX kullanin."
    );
  });
}

const sessions = new Map();

function normalizeSession(session, sessionId) {
  const safe = {
    id: session?.id || sessionId,
    name: session?.name || null,
    history: Array.isArray(session?.history) ? session.history : [],
    documents: Array.isArray(session?.documents) ? session.documents : [],
    preferences: session?.preferences && typeof session.preferences === "object" ? session.preferences : {},
    contextSelections: session?.contextSelections && typeof session.contextSelections === "object" ? session.contextSelections : {},
    review: session?.review && typeof session.review === "object" ? session.review : {},
    progress: session?.progress && typeof session.progress === "object" ? session.progress : {},
    generated: session?.generated && typeof session.generated === "object" ? session.generated : {},
    createdAt: session?.createdAt || Date.now(),
  };

  safe.documents = safe.documents.map((doc) => ({
    id: doc.id || uuidv4(),
    name: doc.name || "Dokuman",
    type: doc.type || "application/octet-stream",
    text: typeof doc.text === "string" ? doc.text : "",
    indexed: typeof doc.indexed === "boolean" ? doc.indexed : !!(doc.text && doc.text.trim()),
    reason: typeof doc.reason === "string" ? doc.reason : "",
    hint: typeof doc.hint === "string" ? doc.hint : "",
    uploadedAt: doc.uploadedAt || Date.now(),
    topics: Array.isArray(doc.topics)
      ? doc.topics.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 20)
      : [],
    preview: doc?.preview && typeof doc.preview === "object" && doc.preview.type === "pdf"
      ? {
          type: "pdf",
          source: typeof doc.preview.source === "string" ? doc.preview.source : "powerpoint-export",
          pageCount: Number.isFinite(doc.preview.pageCount) ? doc.preview.pageCount : null,
        }
      : null,
    ocrRegions: normalizeOcrRegions(doc?.ocrRegions),
    ocrQuality: ["low", "medium", "high"].includes(doc?.ocrQuality) ? doc.ocrQuality : "medium",
    detectedQuestionCount: Number.isFinite(doc?.detectedQuestionCount) ? doc.detectedQuestionCount : 0,
    questionSet: maybeRefreshQuestionSet(doc),
  }));

  safe.preferences = {
    promptPreset: ["auto", "deep", "balanced", "fast"].includes(safe.preferences?.promptPreset)
      ? safe.preferences.promptPreset
      : "auto",
    responseLanguage: normalizePromptLanguage(safe.preferences?.responseLanguage || "tr-TR"),
    uiLocale: normalizeUiLocale(safe.preferences?.uiLocale || "en-US"),
    theme: typeof safe.preferences?.theme === "string" ? safe.preferences.theme : "dark",
    simpleMode: typeof safe.preferences?.simpleMode === "boolean" ? safe.preferences.simpleMode : true,
    fontScale: normalizeFontScale(safe.preferences?.fontScale || "normal"),
  };

  safe.contextSelections = {
    study: safe.contextSelections?.study && typeof safe.contextSelections.study === "object"
      ? safe.contextSelections.study
      : {},
  };

  safe.generated = {
    audioHistory: Array.isArray(safe.generated?.audioHistory) ? safe.generated.audioHistory.slice(0, 20) : [],
    mindMaps: Array.isArray(safe.generated?.mindMaps) ? safe.generated.mindMaps.slice(0, 20) : [],
    solvedQuizzes: Array.isArray(safe.generated?.solvedQuizzes)
      ? safe.generated.solvedQuizzes.map((item) => normalizeSolvedQuizAttempt(item)).slice(0, 25)
      : [],
    mistakeBook: Array.isArray(safe.generated?.mistakeBook)
      ? safe.generated.mistakeBook.map((item) => normalizeMistakeBookEntry(item)).slice(0, 120)
      : [],
    teacherQuestionStates: normalizeTeacherQuestionStateMap(safe.generated?.teacherQuestionStates),
  };

  ensureSessionReviewState(safe);

  return safe;
}

function normalizeOcrRegions(rawRegions = []) {
  if (!Array.isArray(rawRegions)) return [];
  return rawRegions
    .map((region, index) => {
      const bbox = region?.bbox && typeof region.bbox === "object"
        ? {
            x0: Number.isFinite(region.bbox.x0) ? Number(region.bbox.x0) : 0,
            y0: Number.isFinite(region.bbox.y0) ? Number(region.bbox.y0) : 0,
            x1: Number.isFinite(region.bbox.x1) ? Number(region.bbox.x1) : 0,
            y1: Number.isFinite(region.bbox.y1) ? Number(region.bbox.y1) : 0,
          }
        : null;
      return {
        id: String(region?.id || `region-${index + 1}`),
        label: String(region?.label || `Question Region ${index + 1}`).trim(),
        text: String(region?.text || "").trim(),
        bbox,
      };
    })
    .filter((region) => region.text)
    .slice(0, 250);
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(sessionFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        const normalized = normalizeSession(saved, sessionId);
        sessions.set(sessionId, normalized);
        return normalized;
      } catch (e) {
        console.error("Session load error:", e.message);
      }
    }
    sessions.set(sessionId, normalizeSession({ id: sessionId }, sessionId));
  }
  return sessions.get(sessionId);
}

function saveSession(session) {
  try {
    const sessionFile = path.join(SESSIONS_DIR, `${session.id}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), "utf-8");
  } catch (e) {
    console.error("Session save error:", e.message);
  }
}

function getIndexedDocuments(session) {
  return session.documents
    .filter((doc) => doc.indexed && typeof doc.text === "string" && doc.text.trim())
    .sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
}

function getSelectedIndexedDocuments(session, documentId = "") {
  const indexedDocs = getIndexedDocuments(session);
  if (!documentId) return indexedDocs;
  return indexedDocs.filter((doc) => doc.id === documentId);
}

function normalizePromptPreset(value = "auto") {
  return ["auto", "deep", "balanced", "fast"].includes(value) ? value : "auto";
}

function normalizeCitationMode(value = "inline") {
  return ["inline", "minimal", "none"].includes(value) ? value : "inline";
}

function normalizePageMap(rawMap = {}) {
  if (!rawMap || typeof rawMap !== "object") return {};
  return Object.fromEntries(
    Object.entries(rawMap).map(([documentId, values]) => [
      documentId,
      Array.isArray(values)
        ? [...new Set(values.map((value) => Number(value)).filter(Number.isFinite))].sort((a, b) => a - b)
        : [],
    ])
  );
}

function normalizeContextPackPayload(rawContextPack = {}) {
  if (!rawContextPack || typeof rawContextPack !== "object") {
    return {
      documentIds: [],
      selectedPagesByDocument: {},
      relatedPageIdsByDocument: {},
      citationsRequired: true,
      scopeLabel: "",
      scopeText: "",
    };
  }

  const documentIds = Array.isArray(rawContextPack.documentIds)
    ? rawContextPack.documentIds.filter((value) => typeof value === "string" && value.trim())
    : [];

  return {
    documentIds,
    selectedPagesByDocument: normalizePageMap(rawContextPack.selectedPagesByDocument),
    relatedPageIdsByDocument: normalizePageMap(rawContextPack.relatedPageIdsByDocument),
    citationsRequired: rawContextPack.citationsRequired !== false,
    scopeLabel: typeof rawContextPack.scopeLabel === "string" ? rawContextPack.scopeLabel.trim() : "",
    scopeText: typeof rawContextPack.scopeText === "string" ? rawContextPack.scopeText.trim() : "",
  };
}

function resolveRouteContextPack(session, payload = {}, options = {}) {
  const normalizedPayload = normalizeContextPackPayload(payload.contextPack);
  const documentIds = normalizedPayload.documentIds.length
    ? normalizedPayload.documentIds
    : (payload.documentId ? [payload.documentId] : Array.isArray(payload.documentIds) ? payload.documentIds : []);

  return buildContextPack({
    session,
    documentIds,
    documentId: payload.documentId || "",
    selectedPagesByDocument: normalizedPayload.selectedPagesByDocument,
    relatedPageIdsByDocument: normalizedPayload.relatedPageIdsByDocument,
    citationsRequired: normalizedPayload.citationsRequired,
    scopeLabel: normalizedPayload.scopeLabel || options.scopeLabel || "",
    scopeText: normalizedPayload.scopeText || options.scopeText || "",
    maxChars: options.maxChars,
  });
}

function buildCitationInstruction(citationMode = "inline") {
  switch (citationMode) {
    case "none":
      return "Citations are optional. Use them only when they materially help clarity.";
    case "minimal":
      return "Use minimal citations only for the most important claims.";
    case "inline":
    default:
      return "Use inline citations for important claims and references, such as [Page 4] or [Slide 7].";
  }
}

const CHAT_TERM_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "that", "this", "from", "into", "about", "could", "would",
  "explain", "please", "more", "very", "much", "what", "when", "where", "which", "neden", "niye", "icin",
  "bana", "gibi", "kanka", "konu", "topic", "detay", "detail", "deep", "deeper", "teach", "learn", "tell",
  "show", "continue", "devam", "basla", "start", "scratch", "fundamentals", "basics", "anlat", "acikla",
  "simplify", "summary", "summarize", "feynman", "technique", "tekni", "teknik", "it",
]);

function extractSearchTerms(text, limit = 12) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !CHAT_TERM_STOPWORDS.has(token))
    .slice(0, limit);
}

function buildTopicCatalog(indexedDocs, limit = 12) {
  const topicPool = [];

  for (const doc of indexedDocs) {
    if (Array.isArray(doc.topics) && doc.topics.length) {
      topicPool.push(...doc.topics);
      continue;
    }
    topicPool.push(...fallbackTopicsFromText(doc.text || "", 4));
  }

  return sanitizeTopicList(topicPool, limit);
}

function buildTutorUserMessage(message, indexedDocs) {
  const raw = String(message || "").trim();
  if (!raw) return "";

  const normalized = raw.toLowerCase();
  const topicCatalog = buildTopicCatalog(indexedDocs, 12);
  const searchTerms = extractSearchTerms(raw, 10);
  const hints = [];

  if (/(feyn|feym|feynman|feynmen|ferman|tatich|tatic|tekni)/i.test(normalized)) {
    hints.push("The user likely wants a Feynman-style explanation or is referring to the Feynman section with a typo. Re-explain the most relevant document topic with simple analogies first, then restate it academically.");
  }

  if (/(explain|teach|learn|detail|deep|scratch|continue|devam|anlat|acikla|could you explain|what is|nedir|overview|fundamentals|basics)/i.test(normalized)) {
    hints.push("Do not merely repeat the headings. Turn the document material into a proper lesson: define the terms, connect the listed items, explain the logic, and show why each part matters.");
  }

  if (topicCatalog.length) {
    hints.push(`Closest document topics: ${topicCatalog.join(" | ")}`);
  }

  if (searchTerms.length) {
    hints.push(`Important user keywords: ${searchTerms.join(", ")}`);
  }

  if (!hints.length) return raw;

  return `${raw}\n\n[Tutor interpretation hints:\n- ${hints.join("\n- ")}\n]`;
}

function sanitizeTopicList(topics, limit = 12) {
  const seen = new Set();
  return (Array.isArray(topics) ? topics : [])
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 3 && item.length <= 90)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function fallbackTopicsFromText(text, limit = 12) {
  const lineCandidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 90)
    .filter((line) => !/[.!?]$/.test(line) || line.split(/\s+/).length <= 8)
    .filter((line) => /[A-Za-z0-9]/.test(line));

  if (lineCandidates.length) return sanitizeTopicList(lineCandidates, limit);

  const sentenceCandidates = text
    .split(/[.!?]\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12)
    .map((sentence) => sentence.split(/\s+/).slice(0, 8).join(" "))
    .map((sentence) => sentence.replace(/[,:;]+$/g, "").trim());

  return sanitizeTopicList(sentenceCandidates, limit);
}

function sanitizeDocumentTextForAI(text, maxChars = 0) {
  if (typeof text !== "string") return "";

  let cleaned = decodeXmlEntities(text)
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\{[0-9A-F-]{8,}\}/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (maxChars > 0 && cleaned.length > maxChars) {
    cleaned = `${cleaned.slice(0, maxChars)}\n...[kisaltildi]...`;
  }

  return cleaned;
}

async function extractTopicsForDocuments(docs, runtimeConfig) {
  const fallback = fallbackTopicsFromText(
    docs.map((doc) => sanitizeDocumentTextForAI(doc.text || "", 4000)).join("\n"),
    12
  );

  try {
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return fallback;
    }

    let contentContext = "";
    for (const doc of docs) {
      contentContext += `\n[${doc.name}]\n${sanitizeDocumentTextForAI(doc.text || "", 5000)}\n`;
    }

    const prompt = `Sadece verilen belge iceriginden calis.\nBelge sirasini koruyarak quiz veya flashcard secimi icin 8 ile 12 arasinda konu basligi cikar.\nKurallar:\n- Dis bilgi kullanma.\n- Konular kisa olsun.\n- Konular belge akisini bozmasin.\n- Ayni konuyu farkli bicimde tekrar etme.\n- Cikti sadece <json>...</json> blogu icinde gecerli JSON olsun.\n\n<json>\n{\n  "topics": ["Konu 1", "Konu 2"]\n}\n</json>\n\nBelge icerigi:\n${contentContext}`;

    const raw = await callAI(prompt, runtimeConfig, { maxOutputTokens: 800, temperature: 0.1 });
    const parsed = extractJsonObject(raw);
    const aiTopics = sanitizeTopicList(parsed?.topics, 12);
    return aiTopics.length ? aiTopics : fallback;
  } catch {
    return fallback;
  }
}
async function extractText(filePath, mimetype) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (mimetype === "application/pdf") {
    const pdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return (data.text || "").trim();
  }
  if (DOCX_MIMES.has(mimetype) || ext === ".docx") {
    return extractDocxText(filePath);
  }
  if (mimetype.startsWith("text/") || ext === ".txt" || ext === ".md") {
    return fs.readFileSync(filePath, "utf-8").trim();
  }
  return "";
}

function decodeXmlEntities(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r");
}

async function extractPptText(filePath) {
  const zip = new AdmZip(filePath);
  const slideEntries = zip.getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
    .sort((a, b) => {
      const aNum = Number((a.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bNum = Number((b.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return aNum - bNum;
    });

  const slideTexts = slideEntries.map((entry, index) => {
    const xml = entry.getData().toString("utf8");
    const matches = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXmlEntities(match[1] || "").trim())
      .filter(Boolean);

    if (!matches.length) return "";
    return `Slide ${index + 1}\n${matches.join(" ")}`;
  }).filter(Boolean);

  return slideTexts.join("\n\n").trim();
}

async function extractDocxText(filePath) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry("word/document.xml");
  if (!entry) return "";

  const xml = entry.getData().toString("utf8");
  const paragraphChunks = xml
    .split(/<\/w:p>/i)
    .map((chunk) => {
      const withBreaks = chunk
        .replace(/<w:br\s*\/?>/gi, "\n")
        .replace(/<w:tab\s*\/?>/gi, " ");
      return [...withBreaks.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)]
        .map((match) => decodeXmlEntities(match[1] || ""))
        .join("");
    })
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphChunks.join("\n").trim();
}

function getDocumentPreviewPdfPath(sessionId, documentId) {
  return path.join(PREVIEWS_DIR, `${sessionId}-${documentId}.pdf`);
}

function getDocumentPreviewUrl(sessionId, documentId) {
  return `/api/session/${sessionId}/document/${documentId}/preview`;
}

function cleanupDocumentPreview(sessionId, documentId) {
  if (!sessionId || !documentId) return;
  const previewPath = getDocumentPreviewPdfPath(sessionId, documentId);
  if (!fs.existsSync(previewPath)) return;
  try {
    fs.unlinkSync(previewPath);
  } catch (error) {
    console.error("Preview cleanup error:", error.message);
  }
}

function getDocumentPreviewState(sessionId, document) {
  if (!document?.preview || document.preview.type !== "pdf") return null;
  const previewPath = getDocumentPreviewPdfPath(sessionId, document.id);
  const available = fs.existsSync(previewPath);
  return {
    type: "pdf",
    source: document.preview.source || "powerpoint-export",
    available,
    pageCount: Number.isFinite(document.preview.pageCount) ? document.preview.pageCount : null,
    url: available ? getDocumentPreviewUrl(sessionId, document.id) : "",
  };
}

const QUESTION_START_RE = /^(?:(?:question|q|soru)\s*[ivxlcdm0-9]+[\)\.\:\-]?\s+|^\d+[\)\.\-:]\s+|^[ivxlcdm]+\.\s+)/i;
const QUESTION_OPTION_RE = /^[A-E][\)\.\-:]\s+|^[A-E]\s*-\s+/i;
const QUESTION_HINT_RE = /\b(question|questions|soru|sorular|exam|quiz|midterm|final|test|cevaplayiniz|answer the following|true\/false|multiple choice)\b/i;
const INLINE_QUESTION_START_RE = /(?:question|q|soru)\s*[ivxlcdm0-9]+[\)\.\:\-]?\s+|\d+[\)\.\-:]\s+|(?:^|\s)[ivxlcdm]+\.\s+/gi;
const INLINE_OPTION_CAPTURE_RE = /(?:^|\n)\s*([A-E][)\.\-:])\s*([\s\S]*?)(?=(?:\n\s*[A-E][)\.\-:]\s*)|(?:\s+Correct\s+Answer\s*:)|(?:\s+Dogru\s+Cevap\s*:)|$)/g;

function stripQuestionPrefix(value) {
  return String(value || "")
    .replace(/^(?:question|q|soru)\s*\d+[\)\.\:\-]?\s*/i, "")
    .replace(/^\d+[\)\.\-:]\s*/, "")
    .trim();
}

function normalizeQuestionOption(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([A-E])[)\.\-:]\s*(.+)$/i);
  if (match) {
    return `${match[1].toUpperCase()}) ${match[2].trim()}`;
  }
  return raw;
}

function classifyQuestionType(prompt, options = []) {
  const combined = `${prompt}\n${options.join("\n")}`.toLowerCase();
  if (/\b(true|false|dogru|yanlis|doğru|yanlış)\b/.test(combined)) return "truefalse";
  if (options.length >= 2) return "multiple";
  return "classic";
}

function normalizeQuestionExtractionText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\s+(?=(?:(?:question|q|soru)\s*[ivxlcdm0-9]+[\)\.\:\-]?\s+|\d+[\)\.\-:]\s+|[ivxlcdm]+\.\s+))/gi, "\n")
    .replace(/\s+(?=[A-H][)\.\-:]\s+)/g, "\n")
    .replace(/([\p{L}\p{N}\)])(?=[A-H][)\.\-:]\s+)/gu, "$1\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function estimateOcrQuality(lines = [], regions = [], text = "") {
  const lineCount = Array.isArray(lines) ? lines.length : 0;
  const regionCount = Array.isArray(regions) ? regions.length : 0;
  const charCount = String(text || "").trim().length;

  if (regionCount >= 3 && lineCount >= 8 && charCount >= 200) return "high";
  if (regionCount >= 1 && lineCount >= 4 && charCount >= 80) return "medium";
  return "low";
}

function findInlineQuestionStartIndices(text) {
  const normalized = normalizeQuestionExtractionText(text);
  const positions = [];
  let match;
  INLINE_QUESTION_START_RE.lastIndex = 0;

  while ((match = INLINE_QUESTION_START_RE.exec(normalized))) {
    const index = match.index;
    const before = index > 0 ? normalized[index - 1] : "";
    const snippet = normalized.slice(index, Math.min(index + 320, normalized.length));

    if (before && /[\p{L}\p{N}]/u.test(before)) continue;
    if (!QUESTION_HINT_RE.test(snippet) && !QUESTION_OPTION_RE.test(snippet) && !/[?؟]/.test(snippet)) {
      continue;
    }

    positions.push(index);
  }

  return [...new Set(positions)].sort((a, b) => a - b);
}

function splitInlineQuestionBlocks(text) {
  const normalized = normalizeQuestionExtractionText(text);
  const starts = findInlineQuestionStartIndices(normalized);
  if (!starts.length) return [];

  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : normalized.length;
    return normalized.slice(start, end).trim();
  }).filter(Boolean);
}

function expandQuestionBlockRecursively(rawBlock) {
  const normalized = normalizeQuestionExtractionText(rawBlock);
  if (!normalized) return [];

  const directBlocks = splitInlineQuestionBlocks(normalized);
  if (directBlocks.length > 1) {
    return directBlocks.flatMap((item) => expandQuestionBlockRecursively(item));
  }

  const nestedNumericStarts = [...normalized.matchAll(/\b\d+\.\s+[A-Z(]/g)];
  if (nestedNumericStarts.length > 1) {
    const splitIndex = nestedNumericStarts[1].index;
    if (Number.isFinite(splitIndex) && splitIndex > 80) {
      return [
        ...expandQuestionBlockRecursively(normalized.slice(0, splitIndex)),
        ...expandQuestionBlockRecursively(normalized.slice(splitIndex)),
      ];
    }
  }

  return [normalized];
}

function parseQuestionBlock(blockText, index) {
  const rawText = normalizeQuestionExtractionText(blockText);
  if (!rawText) return null;

  const withoutAnswerKey = rawText
    .replace(/\s+(?:Correct\s+Answer|Dogru\s+Cevap)\s*:\s*[A-H]\b[\s\S]*$/i, "")
    .trim();
  const stripped = stripQuestionPrefix(withoutAnswerKey);
  const optionMatches = [...stripped.matchAll(INLINE_OPTION_CAPTURE_RE)];

  let prompt = stripped;
  let options = [];

  if (optionMatches.length) {
    const firstOption = optionMatches[0];
    prompt = stripped.slice(0, firstOption.index).replace(/\s+/g, " ").trim();
    options = optionMatches
      .map((match) => normalizeQuestionOption(`${match[1]} ${String(match[2] || "").replace(/\s+/g, " ").trim()}`))
      .filter(Boolean);
  }

  const type = classifyQuestionType(prompt, options);
  if (!prompt) return null;

  return {
    id: index + 1,
    prompt,
    options,
    type,
    raw: rawText,
  };
}

function extractQuestionBlocksFromText(text) {
  const normalizedText = normalizeQuestionExtractionText(text);
  const lines = normalizedText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) return [];

  const blocks = [];
  let current = null;

  const pushCurrent = () => {
    if (!current || !current.lines.length) return;
    blocks.push(current.lines.slice());
    current = null;
  };

  for (const line of lines) {
    if (QUESTION_START_RE.test(line)) {
      pushCurrent();
      current = { lines: [line] };
      continue;
    }

    if (!current) {
      continue;
    }

    current.lines.push(line);
  }

  pushCurrent();

  if (blocks.length < 2 && QUESTION_HINT_RE.test(normalizedText)) {
    const inlineBlocks = splitInlineQuestionBlocks(normalizedText);
    if (inlineBlocks.length >= 2) {
      return inlineBlocks.map((block, index) => parseQuestionBlock(block, index)).filter(Boolean);
    }
  }

  if (!blocks.length && QUESTION_HINT_RE.test(normalizedText)) {
    const chunks = normalizedText
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    chunks.forEach((chunk) => {
      if (QUESTION_START_RE.test(chunk) || /\?$/.test(chunk)) {
        blocks.push(chunk.split("\n").map((line) => line.trim()).filter(Boolean));
      }
    });
  }

  const expandedBlocks = blocks.flatMap((lines) => {
    const rawBlock = lines.join("\n");
    return expandQuestionBlockRecursively(rawBlock);
  });

  return expandedBlocks
    .map((block, index) => parseQuestionBlock(block, index))
    .filter(Boolean);
}

function buildQuestionSetFromText(text, originalName = "") {
  const extracted = extractQuestionBlocksFromText(text).slice(0, 250);
  const lowerName = String(originalName || "").toLowerCase();
  const signalCount = extracted.length;
  const questionWordSignals = (String(text || "").match(/\b(question|questions|soru|sorular|answer the following|cevaplayiniz|çözünüz)\b/gi) || []).length;
  const optionSignals = (String(text || "").match(/\b[A-D][)\.\-:]\s+/g) || []).length;
  const questionMarkSignals = (String(text || "").match(/\?/g) || []).length;
  const nameSignal = /(question|quiz|exam|midterm|final|soru|sinav|test)/i.test(lowerName) ? 1 : 0;
  const detected = (
    signalCount >= 2 && (questionWordSignals > 0 || optionSignals >= 2 || questionMarkSignals > 0 || nameSignal)
  ) || (
    signalCount >= 1 && (questionWordSignals >= 2 || optionSignals >= 3 || nameSignal)
  );
  const typeCounts = extracted.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});

  const tags = [...new Set(extracted
    .map((item) => item.prompt.split(/[,:-]/)[0]?.trim())
    .filter(Boolean)
    .slice(0, 12))];

  return {
    detected,
    count: extracted.length,
    types: Object.keys(typeCounts),
    tags,
    questions: detected ? extracted : [],
  };
}

function normalizeQuestionSet(rawQuestionSet = {}) {
  if (!rawQuestionSet || typeof rawQuestionSet !== "object") {
    return { detected: false, count: 0, types: [], tags: [], questions: [] };
  }

  const questions = Array.isArray(rawQuestionSet.questions)
    ? rawQuestionSet.questions.map((item, index) => ({
        id: Number.isFinite(item?.id) ? item.id : index + 1,
        prompt: String(item?.prompt || "").trim(),
        options: Array.isArray(item?.options) ? item.options.map((opt) => String(opt || "").trim()).filter(Boolean).slice(0, 8) : [],
        type: ["multiple", "classic", "truefalse"].includes(item?.type) ? item.type : classifyQuestionType(item?.prompt || "", item?.options || []),
        raw: String(item?.raw || "").trim(),
      })).filter((item) => item.prompt)
    : [];

  return {
    detected: rawQuestionSet.detected === true && questions.length > 0,
    count: Number.isFinite(rawQuestionSet.count) ? rawQuestionSet.count : questions.length,
    types: Array.isArray(rawQuestionSet.types)
      ? rawQuestionSet.types.filter((value) => ["multiple", "classic", "truefalse"].includes(value))
      : [...new Set(questions.map((item) => item.type))],
    tags: Array.isArray(rawQuestionSet.tags)
      ? rawQuestionSet.tags.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 12)
      : [],
    questions,
  };
}

function maybeRefreshQuestionSet(doc = {}) {
  const current = normalizeQuestionSet(doc?.questionSet);
  const sourceText = typeof doc?.text === "string" ? doc.text : "";
  if (!sourceText.trim()) return current;

  const optionSignals = (sourceText.match(/\b[A-D][)\.\-:]\s*/g) || []).length;
  const suspiciousAllClassic = current.detected
    && current.questions.length >= 4
    && current.types.length === 1
    && current.types[0] === "classic"
    && optionSignals >= Math.max(4, Math.floor(current.questions.length / 2));

  if (!suspiciousAllClassic) return current;

  const rebuilt = normalizeQuestionSet(buildQuestionSetFromText(sourceText, doc?.name || ""));
  const rebuiltLooksBetter = rebuilt.detected
    && rebuilt.questions.length > 0
    && rebuilt.questions.some((item) => (item.options || []).length >= 2);

  return rebuiltLooksBetter ? rebuilt : current;
}

function normalizeSolvedQuizAttempt(rawAttempt = {}) {
  const answers = Array.isArray(rawAttempt.answers) ? rawAttempt.answers : [];
  const questions = Array.isArray(rawAttempt.questions) ? rawAttempt.questions : [];
  return {
    id: typeof rawAttempt.id === "string" && rawAttempt.id ? rawAttempt.id : uuidv4(),
    createdAt: Number.isFinite(rawAttempt.createdAt) ? rawAttempt.createdAt : Date.now(),
    title: String(rawAttempt.title || "").trim(),
    documentId: String(rawAttempt.documentId || "").trim(),
    documentName: String(rawAttempt.documentName || "").trim(),
    topic: String(rawAttempt.topic || "").trim(),
    difficulty: ["easy", "medium", "hard"].includes(rawAttempt.difficulty) ? rawAttempt.difficulty : "medium",
    type: ["multiple", "classic", "truefalse", "mixed"].includes(rawAttempt.type) ? rawAttempt.type : "multiple",
    language: normalizePromptLanguage(rawAttempt.language || "tr-TR"),
    score: Number.isFinite(rawAttempt.score) ? rawAttempt.score : 0,
    total: Number.isFinite(rawAttempt.total) ? rawAttempt.total : answers.length,
    pct: Number.isFinite(rawAttempt.pct) ? rawAttempt.pct : 0,
    answers: answers.map((item) => ({
      question: String(item?.question || "").trim(),
      userAnswer: String(item?.userAnswer || "").trim(),
      correctAnswer: String(item?.correctAnswer || "").trim(),
      isCorrect: item?.isCorrect === true,
      explanation: String(item?.explanation || "").trim(),
      citation: String(item?.citation || "").trim(),
      category: String(item?.category || "").trim(),
    })).filter((item) => item.question),
    questions: questions.map((item) => ({
      id: Number.isFinite(item?.id) ? item.id : 0,
      question: String(item?.question || "").trim(),
      type: ["multiple", "classic", "truefalse"].includes(item?.type) ? item.type : "multiple",
      options: Array.isArray(item?.options) ? item.options.map((opt) => String(opt || "").trim()).filter(Boolean).slice(0, 8) : [],
      answer: String(item?.answer || "").trim(),
      explanation: String(item?.explanation || "").trim(),
      citation: String(item?.citation || "").trim(),
      category: String(item?.category || "").trim(),
    })).filter((item) => item.question),
  };
}

function storeSolvedQuizAttempt(session, attempt) {
  const normalized = normalizeSolvedQuizAttempt(attempt);
  session.generated.solvedQuizzes.unshift(normalized);
  session.generated.solvedQuizzes = session.generated.solvedQuizzes.slice(0, 25);
  return normalized;
}

function normalizeMistakeBookEntry(rawEntry = {}) {
  return {
    id: typeof rawEntry.id === "string" && rawEntry.id ? rawEntry.id : uuidv4(),
    createdAt: Number.isFinite(rawEntry.createdAt) ? rawEntry.createdAt : Date.now(),
    documentId: String(rawEntry.documentId || "").trim(),
    documentName: String(rawEntry.documentName || "").trim(),
    sourceType: String(rawEntry.sourceType || "teacher-question").trim(),
    questionId: Number.isFinite(rawEntry.questionId) ? rawEntry.questionId : 0,
    questionType: ["multiple", "classic", "truefalse"].includes(rawEntry.questionType) ? rawEntry.questionType : "multiple",
    question: String(rawEntry.question || "").trim(),
    userAnswer: String(rawEntry.userAnswer || "").trim(),
    correctAnswer: String(rawEntry.correctAnswer || "").trim(),
    explanation: String(rawEntry.explanation || "").trim(),
    citation: String(rawEntry.citation || "").trim(),
    category: String(rawEntry.category || "").trim(),
    language: normalizePromptLanguage(rawEntry.language || "tr-TR"),
  };
}

function normalizeTeacherQuestionState(rawState = {}, questionId = 0) {
  const status = ["new", "studying", "solved", "wrong"].includes(rawState?.status)
    ? rawState.status
    : "new";
  const typeOverride = ["multiple", "classic", "truefalse"].includes(rawState?.typeOverride)
    ? rawState.typeOverride
    : "";
  return {
    questionId: Number.isFinite(rawState?.questionId) ? Number(rawState.questionId) : Number(questionId) || 0,
    status,
    attempts: Number.isFinite(rawState?.attempts) ? Math.max(0, Number(rawState.attempts)) : 0,
    correctCount: Number.isFinite(rawState?.correctCount) ? Math.max(0, Number(rawState.correctCount)) : 0,
    wrongCount: Number.isFinite(rawState?.wrongCount) ? Math.max(0, Number(rawState.wrongCount)) : 0,
    lastActionAt: Number.isFinite(rawState?.lastActionAt) ? Number(rawState.lastActionAt) : 0,
    typeOverride,
  };
}

function normalizeTeacherQuestionStateMap(rawMap = {}) {
  if (!rawMap || typeof rawMap !== "object") return {};
  return Object.fromEntries(
    Object.entries(rawMap).map(([documentId, questionMap]) => {
      const normalizedQuestionMap = Object.fromEntries(
        Object.entries(questionMap && typeof questionMap === "object" ? questionMap : {}).map(([questionId, state]) => [
          String(questionId),
          normalizeTeacherQuestionState(state, questionId),
        ])
      );
      return [documentId, normalizedQuestionMap];
    })
  );
}

function storeMistakeBookEntries(session, entries = []) {
  const normalizedEntries = Array.isArray(entries)
    ? entries.map((item) => normalizeMistakeBookEntry(item)).filter((item) => item.question)
    : [];
  if (!normalizedEntries.length) return [];

  session.generated.mistakeBook = [...normalizedEntries, ...(session.generated.mistakeBook || [])]
    .slice(0, 120);
  return normalizedEntries;
}

function getTeacherQuestionState(session, documentId, questionId) {
  const stateMap = session?.generated?.teacherQuestionStates || {};
  const documentMap = stateMap?.[documentId] || {};
  return normalizeTeacherQuestionState(documentMap?.[String(questionId)] || {}, questionId);
}

function upsertTeacherQuestionState(session, documentId, questionId, patch = {}) {
  if (!session.generated.teacherQuestionStates || typeof session.generated.teacherQuestionStates !== "object") {
    session.generated.teacherQuestionStates = {};
  }
  if (!session.generated.teacherQuestionStates[documentId] || typeof session.generated.teacherQuestionStates[documentId] !== "object") {
    session.generated.teacherQuestionStates[documentId] = {};
  }

  const previous = getTeacherQuestionState(session, documentId, questionId);
  const next = normalizeTeacherQuestionState({
    ...previous,
    ...patch,
    questionId,
    lastActionAt: Number.isFinite(patch?.lastActionAt) ? patch.lastActionAt : Date.now(),
  }, questionId);

  session.generated.teacherQuestionStates[documentId][String(questionId)] = next;
  return next;
}

function buildTeacherQuestionStatusCounts(session, document) {
  const counts = { new: 0, studying: 0, solved: 0, wrong: 0 };
  for (const question of document?.questionSet?.questions || []) {
    const state = getTeacherQuestionState(session, document.id, question.id);
    counts[state.status] = (counts[state.status] || 0) + 1;
  }
  return counts;
}

function toPowerShellLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exportPowerPointPreviewPdf(inputPath, outputPath) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "PowerPoint preview donusumu bu sunucuda sadece Windows ortaminda destekleniyor.",
    };
  }

  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$inputPath = ${toPowerShellLiteral(inputPath)}`,
    `$outputPath = ${toPowerShellLiteral(outputPath)}`,
    "$ppt = $null",
    "$presentation = $null",
    "try {",
    "  $ppt = New-Object -ComObject PowerPoint.Application",
    "  $ppt.DisplayAlerts = 1",
    "  $presentation = $ppt.Presentations.Open($inputPath, -1, 0, 0)",
    "  $presentation.SaveAs($outputPath, 32)",
    "} finally {",
    "  if ($presentation -ne $null) { try { $presentation.Close() | Out-Null } catch {} ; try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) } catch {} }",
    "  if ($ppt -ne $null) { try { $ppt.Quit() } catch {} ; try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($ppt) } catch {} }",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "}",
  ].join("; ");

  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], {
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      message: error.stderr || error.stdout || error.message || "PowerPoint PDF export basarisiz oldu.",
    };
  }

  if (!fs.existsSync(outputPath)) {
    return {
      ok: false,
      message: "PowerPoint preview PDF olusturulamadi.",
    };
  }

  return { ok: true, outputPath };
}

async function extractImageTextWithGemini(filePath, mimetype, runtimeConfig) {
  if (runtimeConfig.provider !== "gemini") {
    return {
      indexed: false,
      text: "",
      reason: "IMAGE_EXTRACTION_UNSUPPORTED_PROVIDER",
      hint: "Gorselden metin cikarmak icin Gemini kullanin veya dosyayi PDF/TXT olarak yukleyin.",
    };
  }

  if (!hasConfiguredKey(runtimeConfig)) {
    return {
      indexed: false,
      text: "",
      reason: "MISSING_API_KEY",
      hint: "Gorsel analizi icin once Gemini API key ayarlayin.",
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(runtimeConfig.apiKey);
    const model = genAI.getGenerativeModel({ model: runtimeConfig.model || "gemini-2.0-flash" });
    const buffer = fs.readFileSync(filePath);

    const result = await model.generateContent([
      { text: "Asagidaki gorselden metni cikart. Yalnizca metni dondur, yoksa bos dondur." },
      { inlineData: { data: buffer.toString("base64"), mimeType: mimetype } },
    ]);

    const text = (result.response.text() || "").trim();
    if (!text) {
      return {
        indexed: false,
        text: "",
        reason: "NO_TEXT_EXTRACTED",
        hint: "Gorselde secilebilir metin bulunamadi. PDF/TXT yukleyin veya daha net bir goruntu deneyin.",
      };
    }

    return { indexed: true, text, reason: "IMAGE_TEXT_EXTRACTED", hint: "" };
  } catch (e) {
    return {
      indexed: false,
      text: "",
      reason: "IMAGE_EXTRACTION_FAILED",
      hint: "Gorsel analizi basarisiz. Gemini vision uyumlu model secin veya dosyayi PDF/TXT formatina cevirin.",
      details: e.message,
    };
  }
}

function isOcrQuestionStart(lineText = "") {
  const line = String(lineText || "").trim();
  return QUESTION_START_RE.test(line)
    || /^(?:question|q|soru)\s*[ivxlcdm0-9]+[\)\.\:\-]?\s+/i.test(line)
    || /^\d+\s*[)\.\-:]\s+/.test(line)
    || /^[ivxlcdm]+\.\s+/i.test(line);
}

function buildQuestionRegionsFromOcrLines(lines = []) {
  const normalizedLines = lines
    .map((line, index) => ({
      id: index + 1,
      text: String(line?.text || "").replace(/[ \t]{2,}/g, " ").trim(),
      bbox: {
        x0: Number.isFinite(line?.bbox?.x0) ? Number(line.bbox.x0) : 0,
        y0: Number.isFinite(line?.bbox?.y0) ? Number(line.bbox.y0) : 0,
        x1: Number.isFinite(line?.bbox?.x1) ? Number(line.bbox.x1) : 0,
        y1: Number.isFinite(line?.bbox?.y1) ? Number(line.bbox.y1) : 0,
      },
    }))
    .filter((line) => line.text)
    .sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));

  if (!normalizedLines.length) return [];

  const avgHeight = normalizedLines.reduce((sum, line) => sum + Math.max(1, line.bbox.y1 - line.bbox.y0), 0) / normalizedLines.length;
  const gapThreshold = Math.max(18, avgHeight * 1.4);
  const regions = [];
  let current = null;

  const pushCurrent = () => {
    if (!current?.lines?.length) return;
    const text = current.lines.map((line) => line.text).join("\n").trim();
    if (!text) return;
    regions.push({
      id: `ocr-region-${regions.length + 1}`,
      label: `Question Region ${regions.length + 1}`,
      text,
      bbox: current.bbox,
    });
  };

  for (const line of normalizedLines) {
    const gap = current ? line.bbox.y0 - current.bbox.y1 : 0;
    const startsQuestion = isOcrQuestionStart(line.text);
    const shouldStartNew = !current
      || (startsQuestion && current.lines.length)
      || (gap > gapThreshold && current.lines.length && (startsQuestion || current.lines.length >= 2));

    if (shouldStartNew) {
      pushCurrent();
      current = {
        lines: [line],
        bbox: { ...line.bbox },
      };
      continue;
    }

    current.lines.push(line);
    current.bbox = {
      x0: Math.min(current.bbox.x0, line.bbox.x0),
      y0: Math.min(current.bbox.y0, line.bbox.y0),
      x1: Math.max(current.bbox.x1, line.bbox.x1),
      y1: Math.max(current.bbox.y1, line.bbox.y1),
    };
  }

  pushCurrent();
  return regions
    .map((region) => ({
      ...region,
      text: normalizeQuestionExtractionText(region.text),
    }))
    .filter((region) => region.text);
}

async function extractImageTextWithLocalOcr(filePath) {
  try {
    const result = await Tesseract.recognize(filePath, "eng+tur", {
      logger: () => {},
    });
    const ocrLines = Array.isArray(result?.data?.lines) ? result.data.lines : [];
    const ocrRegions = buildQuestionRegionsFromOcrLines(ocrLines);
    const text = (ocrRegions.length
      ? ocrRegions.map((region) => region.text).join("\n\n")
      : String(result?.data?.text || ""))
      .replace(/\r/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const ocrQuality = estimateOcrQuality(ocrLines, ocrRegions, text);
    const detectedQuestionCount = ocrRegions.filter((region) => isOcrQuestionStart(region.text)).length || ocrRegions.length;

    if (!text) {
      return {
        indexed: false,
        text: "",
        reason: "NO_TEXT_EXTRACTED",
        hint: "Gorselde okunabilir metin bulunamadi. Daha net bir goruntu veya PDF deneyin.",
      };
    }

    return {
      indexed: true,
      text,
      ocrRegions: ocrRegions.length ? ocrRegions : [{
        id: "ocr-region-1",
        label: "OCR Region 1",
        text,
        bbox: null,
      }],
      ocrQuality,
      detectedQuestionCount,
      reason: "IMAGE_TEXT_EXTRACTED_LOCAL_OCR",
      hint: "",
    };
  } catch (error) {
    return {
      indexed: false,
      text: "",
      reason: "LOCAL_OCR_FAILED",
      hint: "Yerel OCR ile metin cikarma basarisiz oldu. Daha net bir goruntu deneyin veya PDF/DOCX yukleyin.",
      details: error.message,
    };
  }
}

async function extractImageTextWithFallback(filePath, mimetype, runtimeConfig) {
  const geminiResult = await extractImageTextWithGemini(filePath, mimetype, runtimeConfig);
  if (geminiResult.indexed) return geminiResult;

  const shouldFallbackToLocal =
    geminiResult.reason === "IMAGE_EXTRACTION_UNSUPPORTED_PROVIDER"
    || geminiResult.reason === "MISSING_API_KEY"
    || geminiResult.reason === "IMAGE_EXTRACTION_FAILED"
    || geminiResult.reason === "NO_TEXT_EXTRACTED";

  if (!shouldFallbackToLocal) return geminiResult;

  const localResult = await extractImageTextWithLocalOcr(filePath);
  if (localResult.indexed) {
    localResult.hint = geminiResult.reason === "IMAGE_EXTRACTION_UNSUPPORTED_PROVIDER"
      ? "Yerel OCR fallback kullanildi."
      : "";
    return localResult;
  }

  return {
    indexed: false,
    text: "",
    reason: geminiResult.reason === "IMAGE_EXTRACTION_UNSUPPORTED_PROVIDER" ? localResult.reason : geminiResult.reason,
    hint: geminiResult.hint || localResult.hint,
    details: geminiResult.details || localResult.details,
  };
}

async function analyzeUploadedFile(filePath, mimetype, runtimeConfig, originalName = "", options = {}) {
  const ext = path.extname(originalName || filePath || "").toLowerCase();
  const isPdf = mimetype === "application/pdf" || ext === ".pdf";
  const isText = mimetype.startsWith("text/") || ext === ".txt" || ext === ".md";
  const isDocx = DOCX_MIMES.has(mimetype) || ext === ".docx";
  const isPpt = PPT_MIMES.has(mimetype) || ext === ".pptx" || ext === ".ppt";
  const isImage = IMAGE_MIMES.has(mimetype) || [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
  const normalizedMime = isPdf
    ? "application/pdf"
    : (isText ? "text/plain" : (isDocx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : mimetype));

  if (isPdf || isText || isDocx) {
    const text = await extractText(filePath, normalizedMime);
    if (!text) {
      return {
        indexed: false,
        text: "",
        reason: "NO_TEXT_EXTRACTED",
        hint: "Dosyadan metin cikarilamadi. Taranmis PDF ise metin iceren bir kopya yukleyin.",
      };
    }
    return { indexed: true, text, reason: isDocx ? "DOCX_TEXT_EXTRACTED" : "TEXT_EXTRACTED", hint: "" };
  }

  if (isImage) {
    const effectiveMime = IMAGE_MIMES.has(mimetype)
      ? mimetype
      : ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext] || "image/png");
    return extractImageTextWithFallback(filePath, effectiveMime, runtimeConfig);
  }

  if (isPpt) {
    const previewPath = options.sessionId && options.documentId
      ? getDocumentPreviewPdfPath(options.sessionId, options.documentId)
      : "";
    let preview = null;
    let previewHint = "";

    if (previewPath) {
      const previewResult = await exportPowerPointPreviewPdf(filePath, previewPath);
      if (previewResult.ok) {
        let pageCount = null;
        try {
          const pdfParse = require("pdf-parse");
          const previewBuffer = fs.readFileSync(previewPath);
          const previewData = await pdfParse(previewBuffer);
          pageCount = Number.isFinite(previewData?.numpages) ? previewData.numpages : null;
        } catch {}

        preview = {
          type: "pdf",
          source: "powerpoint-export",
          pageCount,
        };
      } else {
        previewHint = previewResult.message || "";
      }
    }

    let text = "";
    if (ext === ".pptx") {
      text = await extractPptText(filePath);
    }
    if (!text && previewPath && fs.existsSync(previewPath)) {
      text = await extractText(previewPath, "application/pdf");
    }

    if (!text) {
      return {
        indexed: false,
        text: "",
        reason: preview ? "PPT_PREVIEW_READY_NO_TEXT" : "PPT_NO_TEXT_EXTRACTED",
        hint: preview
          ? "PowerPoint slide preview hazir, ancak secilebilir kaynak metin cikarilamadi."
          : (previewHint || "PPT/PPTX yuklendi ama slide metni cikarilamadi. Metin iceren bir PPTX veya PDF deneyin."),
        preview,
      };
    }

    return {
      indexed: true,
      text,
      reason: preview ? "PPT_PREVIEW_AND_TEXT_READY" : "PPT_TEXT_EXTRACTED",
      hint: preview
        ? "PowerPoint slide preview ve kaynak metin hazir."
        : (previewHint || "PPT/PPTX metni kaynak olarak kullanima hazir. Gorsel slide goruntuleme su an yalnizca PDF icin destekleniyor."),
      preview,
    };
  }

  return {
    indexed: false,
    text: "",
    reason: "UNSUPPORTED_FILE_TYPE",
    hint: "Bu dosya turu kaynak olarak kullanilamiyor.",
  };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function mapProviderError(error) {
  const detail = error?.message || String(error || "");
  const lower = detail.toLowerCase();

  if (error?.code === "OLLAMA_MODEL_NOT_FOUND") {
    return {
      code: "MODEL_NOT_FOUND",
      status: 400,
      message: "Secilen Ollama modeli yuklu degil.",
      hint: Array.isArray(error.availableModels) && error.availableModels.length
        ? `Yuklu modeller: ${error.availableModels.join(", ")}`
        : "Ollama'da yuklu bir model secin veya `ollama pull <model>` calistirin.",
      availableModels: error.availableModels || [],
      modelOrigin: error.modelOrigin || "",
    };
  }

  if (lower.includes("401") || lower.includes("403") || lower.includes("api_key") || lower.includes("unauthorized")) {
    return {
      code: "AUTH_FAILED",
      status: 401,
      message: "API kimlik dogrulamasi basarisiz.",
      hint: "API anahtarini kontrol edin ve dogru saglayici/model secili oldugundan emin olun.",
    };
  }

  if (lower.includes("404") || (lower.includes("model") && lower.includes("not"))) {
    return {
      code: "MODEL_NOT_FOUND",
      status: 400,
      message: "Secilen model kullanilamiyor.",
      hint: "Model adini saglayiciya uygun sekilde guncelleyin.",
    };
  }

  if (
    lower.includes("quota")
    || lower.includes("resource exhausted")
    || lower.includes("resource_exhausted")
    || lower.includes("billing")
    || lower.includes("exceeded your current quota")
  ) {
    const retryMatch = detail.match(/retry(?:\s+after|\s+in)?\s+(\d+)/i);
    const retryHint = retryMatch ? ` Bekleme onerisi: ${retryMatch[1]} saniye.` : "";
    return {
      code: "QUOTA_EXCEEDED",
      status: 429,
      message: "Saglayici kotasi tukenmis veya faturalandirma gerekli.",
      hint: `Kota, faturalandirma ve proje limitlerini kontrol edin.${retryHint}`.trim(),
    };
  }

  if (lower.includes("429") || lower.includes("rate") || lower.includes("too many requests")) {
    return {
      code: "RATE_LIMITED",
      status: 429,
      message: "Saglayici limitine takildi.",
      hint: "Biraz bekleyip tekrar deneyin veya baska model secin.",
    };
  }

  if (
    lower.includes("enotfound")
    || lower.includes("econnrefused")
    || lower.includes("fetch")
    || lower.includes("network")
    || lower.includes("connection error")
    || lower.includes("could not connect")
    || lower.includes("connect")
  ) {
    return {
      code: "NETWORK_ERROR",
      status: 502,
      message: "Saglayiciya baglanilamadi.",
      hint: "Base URL, internet baglantisi ve Docker/localhost ayarlarini kontrol edin.",
    };
  }

  return {
    code: "PROVIDER_ERROR",
    status: 500,
    message: "Saglayici istegi basarisiz oldu.",
    hint: "Ayarlarinizi kontrol edip tekrar deneyin.",
  };
}

async function chatWithGemini(messages, systemInstruction, runtimeConfig, options = {}) {
  const genAI = new GoogleGenerativeAI(runtimeConfig.apiKey);
  const model = genAI.getGenerativeModel({
    model: runtimeConfig.model,
    systemInstruction,
    generationConfig: {
      maxOutputTokens: options.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS,
      temperature: options.temperature ?? 0.2,
    },
  });

  const geminiHistory = messages.slice(0, -1).map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));

  const lastMsg = messages[messages.length - 1];
  const parts = [{ text: lastMsg.content }];

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(parts);
      return result.response.text();
    } catch (err) {
      const mapped = mapProviderError(err);
      if (mapped.code === "AUTH_FAILED") throw new Error(mapped.message);
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  return "";
}

async function chatWithOpenAICompatible(messages, systemInstruction, runtimeConfig, options = {}) {
  const preset = PROVIDER_PRESETS[runtimeConfig.provider] || {};
  const baseURL = runtimeConfig.baseUrl || preset.baseUrl || "https://api.openai.com/v1";
  const client = new OpenAI({ baseURL, apiKey: runtimeConfig.apiKey || "ollama" });

  const chatMessages = [
    { role: "system", content: systemInstruction },
    ...messages.map((msg) => ({ role: msg.role === "user" ? "user" : "assistant", content: msg.content })),
  ];

  const completion = await client.chat.completions.create({
    model: runtimeConfig.model,
    messages: chatMessages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? GENERIC_MAX_OUTPUT_TOKENS,
  });

  return completion?.choices?.[0]?.message?.content || "";
}

function truncateForModel(value, maxChars) {
  if (typeof value !== "string") return "";
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[kisaltildi]...";
}

function buildRecentHistory(sessionHistory) {
  return sessionHistory
    .slice(-CHAT_HISTORY_WINDOW)
    .map((msg) => ({
      role: msg.role,
      content: truncateForModel(msg.content || "", MAX_HISTORY_MESSAGE_CHARS),
    }));
}

async function sendChatMessage(sessionHistory, promptPlan, runtimeConfig) {
  const messages = [
    ...buildRecentHistory(sessionHistory),
    { role: "user", content: promptPlan.userPrompt },
  ];

  if (runtimeConfig.provider === "gemini") {
    return chatWithGemini(messages, promptPlan.systemInstruction, runtimeConfig, {
      maxOutputTokens: promptPlan.budgets.maxOutputTokens,
      temperature: promptPlan.budgets.temperature,
    });
  }
  return chatWithOpenAICompatible(messages, promptPlan.systemInstruction, runtimeConfig, {
    maxTokens: promptPlan.budgets.maxOutputTokens,
    temperature: promptPlan.budgets.temperature,
  });
}

async function callAI(prompt, runtimeConfig, options = {}) {
  const systemInstruction = typeof options.systemInstruction === "string" && options.systemInstruction.trim()
    ? options.systemInstruction.trim()
    : SYSTEM_PROMPT;
  const modelOptions = { ...options };
  delete modelOptions.systemInstruction;
  const messages = [{ role: "user", content: prompt }];
  if (runtimeConfig.provider === "gemini") {
    return chatWithGemini(messages, systemInstruction, runtimeConfig, modelOptions);
  }
  return chatWithOpenAICompatible(messages, systemInstruction, runtimeConfig, modelOptions);
}

async function inspectOllamaModels(baseURL) {
  const tagsUrl = baseURL.replace(/\/v1\/?$/, "") + "/api/tags";
  const response = await fetch(tagsUrl);
  if (!response.ok) {
    throw new Error(`Ollama tags istegi basarisiz: ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.models) ? payload.models : [];
}

async function testProviderConnection(runtimeConfig) {
  if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
    throw new Error("API key eksik.");
  }
  if (!runtimeConfig.model) {
    throw new Error("Model secimi zorunlu.");
  }

  const started = Date.now();

  if (runtimeConfig.provider === "gemini") {
    const genAI = new GoogleGenerativeAI(runtimeConfig.apiKey);
    const model = genAI.getGenerativeModel({ model: runtimeConfig.model });
    const result = await model.generateContent("Reply only with: OK");
    return {
      success: true,
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      baseUrl: "",
      latencyMs: Date.now() - started,
      sample: (result.response.text() || "").trim(),
    };
  }

  const preset = PROVIDER_PRESETS[runtimeConfig.provider] || {};
  const baseURL = runtimeConfig.baseUrl || preset.baseUrl;
  if (!baseURL) throw new Error("Base URL zorunlu.");

  const client = new OpenAI({ baseURL, apiKey: runtimeConfig.apiKey || "ollama" });
  let availableModels = [];
  let modelOrigin = "";
  let remoteHost = "";

  if (runtimeConfig.provider === "ollama") {
    const modelList = await client.models.list();
    availableModels = Array.isArray(modelList?.data) ? modelList.data.map((item) => item.id).filter(Boolean) : [];
    try {
      const tags = await inspectOllamaModels(baseURL);
      const tagEntry = tags.find((item) => item?.name === runtimeConfig.model || item?.model === runtimeConfig.model);
      if (tagEntry?.details?.remote_host || tagEntry?.remote_host) {
        modelOrigin = "cloud";
        remoteHost = tagEntry?.details?.remote_host || tagEntry?.remote_host || "";
      } else if (tagEntry) {
        modelOrigin = "local";
      }
    } catch {
      modelOrigin = modelOrigin || "";
    }

    if (availableModels.length > 0 && !availableModels.includes(runtimeConfig.model)) {
      const err = new Error(`Ollama model "${runtimeConfig.model}" bulunamadi. Kullanilabilir modeller: ${availableModels.join(", ")}`);
      err.code = "OLLAMA_MODEL_NOT_FOUND";
      err.availableModels = availableModels;
      err.modelOrigin = modelOrigin;
      throw err;
    }
  }

  const completion = await client.chat.completions.create({
    model: runtimeConfig.model,
    messages: [
      { role: "system", content: "Connection test" },
      { role: "user", content: "Reply only with: OK" },
    ],
    temperature: 0,
    max_tokens: 8,
  });

  return {
    success: true,
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    baseUrl: baseURL,
    latencyMs: Date.now() - started,
    sample: completion?.choices?.[0]?.message?.content || "",
    availableModels,
    modelOrigin,
    remoteHost,
  };
}

function buildDocumentContext(indexedDocs, userMessage = "") {
  let totalChars = 0;
  const topicCatalog = buildTopicCatalog(indexedDocs, 14);
  let docContext = "\n\n=== DOCUMENT-GROUNDED TUTOR MODE ===\n";
  docContext += "Yuklu belgeler birincil ve zorunlu kaynaktir.\n";
  docContext += "Belgedeki kavramlari acmak, siralamak, neden-sonuc iliskisi kurmak, karsilastirmak ve ogretmen gibi detaylandirmak serbesttir; ancak bu anlatim belge konularina bagli kalmalidir.\n";
  docContext += "Belgede gecmeyen alakasiz dis bilgi, tarih, kisi, kurum, olay veya iddia ekleme.\n";
  docContext += "Kullanici 'from scratch', 'continue', 'teach me', 'Feynman' gibi bir stil isterse bunu belge temelli olarak yerine getir.\n";
  docContext += "Sadece istek belge konulariyla gercekten ilgisizse [[OUT_OF_SCOPE_QUERY]] Belgede bulunamadi. yaz.\n";
  if (topicCatalog.length) {
    docContext += `Belgedeki ana konu havuzu: ${topicCatalog.join(" | ")}\n`;
  }
  if (userMessage) {
    docContext += `Kullanici istegi: ${truncateForModel(userMessage, 800)}\n`;
  }
  docContext += "\n=== BELGE ICERIGI BASLANGIC ===\n";

  for (const doc of indexedDocs) {
    if (totalChars >= MAX_DOC_CONTEXT_TOTAL_CHARS) break;
    const sourceText = sanitizeDocumentTextForAI(doc.text || "");
    if (!sourceText.trim()) continue;

    const remaining = MAX_DOC_CONTEXT_TOTAL_CHARS - totalChars;
    const maxAllowed = Math.min(MAX_DOC_CONTEXT_CHARS_PER_DOC, remaining);
    let text = sourceText.slice(0, maxAllowed);
    if (sourceText.length > maxAllowed) text += "\n...[belge kisaltildi]...";

    const docTopics = sanitizeTopicList(
      Array.isArray(doc.topics) && doc.topics.length ? doc.topics : fallbackTopicsFromText(sourceText, 4),
      6
    );
    docContext += `\n[Belge: ${doc.name}]\n`;
    if (docTopics.length) {
      docContext += `[Belge Konulari: ${docTopics.join(" | ")}]\n`;
    }
    docContext += `${text}\n`;
    totalChars += text.length;
  }

  docContext += "\n=== BELGE ICERIGI SONU ===\n";
  return docContext;
}

function getSettingsResponse(cfg, includePresets = false) {
  const activeProvider = cfg?.activeProvider && PROVIDER_PRESETS[cfg.activeProvider]
    ? cfg.activeProvider
    : "gemini";
  const activeProfile = getProfileConfig(cfg, activeProvider);
  const activePreset = PROVIDER_PRESETS[activeProvider] || {};
  const profiles = {};

  for (const provider of Object.keys(PROVIDER_PRESETS)) {
    const preset = PROVIDER_PRESETS[provider];
    const profile = getProfileConfig(cfg, provider);
    const hasKey = hasConfiguredKey(profile);
    profiles[provider] = {
      provider,
      name: preset.name,
      requiresKey: providerNeedsKey(provider),
      hasKey,
      keyPreview: hasKey ? maskKey(profile.apiKey) : "",
      model: profile.model || preset.defaultModel || "",
      baseUrl: profile.baseUrl || preset.baseUrl || "",
      lastTest: profile.lastTest || null,
    };
  }

  const activeHasKey = hasConfiguredKey(activeProfile);
  const response = {
    success: true,
    provider: activeProvider,
    activeProvider,
    requiresKey: providerNeedsKey(activeProvider),
    hasKey: activeHasKey,
    model: activeProfile.model || activePreset.defaultModel || "",
    baseUrl: activeProfile.baseUrl || activePreset.baseUrl || "",
    keyPreview: activeHasKey ? maskKey(activeProfile.apiKey) : "",
    lastTest: activeProfile.lastTest || null,
    profiles,
    strictSourceMode: true,
  };
  if (includePresets) response.presets = PROVIDER_PRESETS;
  return response;
}

function validateSettingsPayload(payload) {
  const errors = {};

  if (payload.provider !== undefined && !PROVIDER_PRESETS[payload.provider]) {
    errors.provider = "Gecersiz provider secimi.";
  }
  if (payload.model !== undefined && typeof payload.model !== "string") {
    errors.model = "Model metin olmalidir.";
  }
  if (payload.baseUrl !== undefined && typeof payload.baseUrl !== "string") {
    errors.baseUrl = "Base URL metin olmalidir.";
  }
  if (payload.apiKey !== undefined && typeof payload.apiKey !== "string") {
    errors.apiKey = "API key metin olmalidir.";
  }
  if (payload.clearApiKey !== undefined && typeof payload.clearApiKey !== "boolean") {
    errors.clearApiKey = "clearApiKey true/false olmalidir.";
  }

  if (payload.baseUrl !== undefined && typeof payload.baseUrl === "string" && payload.baseUrl.trim()) {
    try {
      const u = new URL(payload.baseUrl.trim());
      if (!["http:", "https:"].includes(u.protocol)) {
        errors.baseUrl = "Base URL http/https ile baslamalidir.";
      }
    } catch {
      errors.baseUrl = "Base URL gecersiz formatta.";
    }
  }

  return errors;
}

function buildCandidateConfigState(payload, baseConfigState, options = {}) {
  const switchActive = options.switchActive !== false;
  const currentState = normalizeAppConfig(baseConfigState);
  const targetProvider = payload.provider && PROVIDER_PRESETS[payload.provider]
    ? payload.provider
    : currentState.activeProvider;
  const currentProfile = getProfileConfig(currentState, targetProvider);
  const preset = PROVIDER_PRESETS[targetProvider] || {};

  const nextProfile = {
    ...currentProfile,
    apiKey: currentProfile.apiKey || "",
    model: currentProfile.model || preset.defaultModel || "",
    baseUrl: currentProfile.baseUrl || preset.baseUrl || "",
    lastTest: currentProfile.lastTest || null,
  };

  if (payload.clearApiKey === true) nextProfile.apiKey = "";
  if (payload.apiKey !== undefined) {
    const trimmed = payload.apiKey.trim();
    if (trimmed) nextProfile.apiKey = trimmed;
  }

  if (payload.model !== undefined) {
    nextProfile.model = payload.model.trim() || preset.defaultModel || "";
  }

  if (payload.baseUrl !== undefined) {
    nextProfile.baseUrl = payload.baseUrl.trim() || preset.baseUrl || "";
  }

  const nextState = {
    activeProvider: switchActive ? targetProvider : currentState.activeProvider,
    profiles: {
      ...currentState.profiles,
      [targetProvider]: normalizeProviderProfile(targetProvider, nextProfile),
    },
  };

  return normalizeAppConfig(nextState);
}

function validateCandidateConfig(candidateState, provider) {
  const errors = {};
  const targetProvider = provider && PROVIDER_PRESETS[provider]
    ? provider
    : candidateState.activeProvider;
  const profile = getProfileConfig(candidateState, targetProvider);

  if (!profile.model) errors.model = "Model zorunludur.";
  if (targetProvider === "custom" && !profile.baseUrl) {
    errors.baseUrl = "Custom provider icin baseUrl zorunludur.";
  }
  return errors;
}

function tryParseJsonCandidate(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const attempts = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
    trimmed.replace(/,\s*([}\]])/g, "$1"),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {}
  }

  return null;
}

function extractBalancedJsonCandidate(raw) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return "";
}

function extractJsonObject(raw) {
  if (typeof raw !== "string") return null;

  const tagged = raw.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  const candidates = [
    tagged?.[1] || "",
    raw,
    extractBalancedJsonCandidate(raw),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed && typeof parsed === "object") return parsed;
  }

  return null;
}

function stripOptionPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/^[A-Da-d][\)\.\:\-]\s*/, "")
    .trim();
}

function normalizeQuizQuestion(item, index, requestedType = "multiple") {
  if (!item || typeof item !== "object") return null;

  const question = String(item.question || item.prompt || "").trim();
  if (!question) return null;

  const sourceType = ["multiple", "classic", "truefalse"].includes(item.type) ? item.type : "multiple";
  const normalizedType = requestedType === "mixed"
    ? sourceType
    : requestedType === "classic"
      ? "classic"
      : requestedType === "truefalse"
        ? "truefalse"
        : "multiple";

  const explanation = String(item.explanation || item.rationale || item.reasoning || "").trim();
  let answer = String(item.answer || item.correctAnswer || "").trim();
  let options = Array.isArray(item.options)
    ? item.options.map((opt) => String(opt || "").trim()).filter(Boolean)
    : [];

  if (normalizedType === "multiple") {
    if (!options.length && Array.isArray(item.choices)) {
      options = item.choices.map((opt) => String(opt || "").trim()).filter(Boolean);
    }
    options = options.slice(0, 4).map((opt, idx) => (
      /^[A-Da-d][\)\.\:\-]\s*/.test(opt) ? opt : `${String.fromCharCode(65 + idx)}) ${opt}`
    ));
    if (options.length < 2) return null;

    const answerLetter = answer.match(/^[A-Da-d]\b/);
    if (answerLetter) {
      const answerIndex = answerLetter[0].toUpperCase().charCodeAt(0) - 65;
      answer = options[answerIndex] || options[0];
    } else {
      const normalizedAnswer = stripOptionPrefix(answer).toLowerCase();
      answer = options.find((opt) => stripOptionPrefix(opt).toLowerCase() === normalizedAnswer)
        || options.find((opt) => opt.toLowerCase() === answer.toLowerCase())
        || options[0];
    }
  } else if (normalizedType === "truefalse") {
    options = ["True", "False"];
    const normalizedAnswer = answer.toLowerCase();
    answer = normalizedAnswer === "false" ? "False" : "True";
  } else {
    options = [];
    if (!answer) answer = explanation || "Model answer not provided.";
  }

  return {
    id: index + 1,
    question,
    type: normalizedType,
    options,
    answer,
    explanation: explanation || "",
    citation: String(item.citation || item.source || "").trim(),
    category: String(item.category || item.topic || "").trim(),
  };
}

function normalizeFlashcard(item, index) {
  if (!item || typeof item !== "object") return null;
  const front = String(item.front || item.question || "").trim();
  const back = String(item.back || item.answer || item.explanation || "").trim();
  if (!front || !back) return null;

  return {
    id: index + 1,
    front,
    back,
    category: String(item.category || item.topic || "core concept").trim(),
    citation: String(item.citation || item.source || "").trim(),
  };
}

function dedupeByKey(items, keySelector) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keySelector(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function repairStructuredJson(raw, key, runtimeConfig, languageCode = "tr-TR", systemInstruction = "") {
  const prompt = [
    buildGenerationLanguageRules(languageCode),
    "",
    `Elindeki bozuk ciktiyi yalnizca gecerliligi olan JSON'a cevir.`,
    `Tek hedef anahtar "${key}" olsun.`,
    "Yalnizca <json>...</json> blogu icinde gecerli JSON dondur.",
    "Ek aciklama, markdown veya yorum yazma.",
    "",
    "Ham cikti:",
    truncateForModel(raw || "", 7000),
  ].join("\n");

  const repaired = await callAI(prompt, runtimeConfig, {
    maxOutputTokens: 3500,
    temperature: 0,
    systemInstruction: systemInstruction || `${SYSTEM_PROMPT}\n${buildTeacherStylePrompt(languageCode)}`,
  });
  return extractJsonObject(repaired);
}

async function generateQuizBatch({ runtimeConfig, languageCode, prompt, batchCount, type, systemInstruction, outputTokens }) {
  const raw = await callAI(prompt, runtimeConfig, {
    maxOutputTokens: outputTokens || getQuizOutputTokens(batchCount, type),
    temperature: 0.1,
    systemInstruction: systemInstruction || `${SYSTEM_PROMPT}\n${buildTeacherStylePrompt(languageCode)}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.questions) || !parsed.questions.length) {
    parsed = await repairStructuredJson(raw, "questions", runtimeConfig, languageCode, systemInstruction);
  }

  return Array.isArray(parsed?.questions) ? parsed.questions : [];
}

async function generateFlashcardBatch({ runtimeConfig, languageCode, prompt, batchCount, systemInstruction, outputTokens }) {
  const raw = await callAI(prompt, runtimeConfig, {
    maxOutputTokens: outputTokens || getFlashcardOutputTokens(batchCount),
    temperature: 0.1,
    systemInstruction: systemInstruction || `${SYSTEM_PROMPT}\n${buildTeacherStylePrompt(languageCode)}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) {
    parsed = await repairStructuredJson(raw, "cards", runtimeConfig, languageCode, systemInstruction);
  }

  return Array.isArray(parsed?.cards) ? parsed.cards : [];
}

function getQuestionSupportDocuments(session, primaryDocumentId, requestedSupportDocumentIds = []) {
  const indexedDocs = getIndexedDocuments(session);
  const fallbackDocs = indexedDocs.filter((doc) => doc.id !== primaryDocumentId);
  const requestedIds = Array.isArray(requestedSupportDocumentIds)
    ? requestedSupportDocumentIds.filter((value) => typeof value === "string" && value && value !== primaryDocumentId)
    : [];

  if (!requestedIds.length) return [];
  return fallbackDocs.filter((doc) => requestedIds.includes(doc.id));
}

function getQuestionSourceDocument(session, documentId) {
  return (session?.documents || []).find((doc) => doc.id === documentId && doc.indexed && doc.questionSet?.detected);
}

function getTeacherQuestionById(questionSet, questionId) {
  const numericId = Number(questionId);
  return (questionSet?.questions || []).find((item) => Number(item.id) === numericId) || null;
}

function resolveTeacherQuestionType(question, questionState = null) {
  if (["multiple", "classic", "truefalse"].includes(questionState?.typeOverride)) {
    return questionState.typeOverride;
  }
  const derivedType = classifyQuestionType(question?.prompt || "", question?.options || []);
  if (derivedType !== "classic") {
    return derivedType;
  }
  if (["multiple", "classic", "truefalse"].includes(question?.type)) {
    return question.type;
  }
  return derivedType;
}

function buildTeacherQuestionView(question, questionState = null) {
  const resolvedType = resolveTeacherQuestionType(question, questionState);
  return {
    ...question,
    type: resolvedType,
    originalType: question?.type || resolvedType,
    typeOverride: questionState?.typeOverride || "",
  };
}

function buildTeacherQuestionMistakeEntry({
  document,
  question,
  evaluation,
  userAnswer,
  languageCode,
}) {
  return normalizeMistakeBookEntry({
    documentId: document?.id || "",
    documentName: document?.name || "",
    sourceType: "teacher-question",
    questionId: question?.id || 0,
    questionType: question?.type || "multiple",
    question: question?.prompt || "",
    userAnswer,
    correctAnswer: evaluation?.correctAnswer || "",
    explanation: evaluation?.teachingExplanation || evaluation?.feedback || "",
    citation: evaluation?.citation || "",
    category: evaluation?.category || "",
    language: languageCode,
  });
}

function getMistakeEntries(session, entryIds = [], documentId = "") {
  const allEntries = Array.isArray(session?.generated?.mistakeBook) ? session.generated.mistakeBook : [];
  const requestedIds = Array.isArray(entryIds)
    ? entryIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  let selected = requestedIds.length
    ? allEntries.filter((item) => requestedIds.includes(String(item.id)))
    : allEntries;

  if (documentId) {
    selected = selected.filter((item) => item.documentId === documentId);
  }

  return selected;
}

async function generateMistakeRecoveryQuiz({
  runtimeConfig,
  languageCode,
  preset,
  citationMode,
  resolvedContextPack,
  mistakeEntries,
  supportDocs,
  requestedCount,
}) {
  const safeCount = Math.max(3, Math.min(8, Number(requestedCount) || 4));
  const promptPlan = adaptPrompt({
    task: "quiz",
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    preset,
    language: languageCode,
    teachingMode: "drill",
    contextPack: resolvedContextPack,
    schemaHint: [
      "Return only valid JSON inside <json>...</json>.",
      "Top-level shape: {\"questions\": [...]}",
      "Each question must include: id, question, type, options, answer, explanation, category, citation.",
      "Prefer multiple choice or true/false questions unless the source strongly requires open-ended.",
    ].join("\n"),
    extraInstructions: [
      buildCitationInstruction(citationMode),
      "These questions are recovery questions based on the student's mistakes.",
      "Read the mistake list first, identify the missing concept, then write focused questions that reteach that concept.",
      "Use support documents to improve the explanation and keep everything grounded.",
    ].join("\n"),
    userPrompt: [
      supportDocs.length ? `Support kaynaklar: ${supportDocs.map((doc) => doc.name).join(" | ")}` : "Support kaynak yok.",
      `Hedef hata listesi:\n<json>${JSON.stringify(mistakeEntries.map((item) => ({
        id: item.id,
        question: item.question,
        userAnswer: item.userAnswer,
        correctAnswer: item.correctAnswer,
        explanation: item.explanation,
        category: item.category,
        citation: item.citation,
      })))}</json>`,
      `Create ${safeCount} recovery quiz questions that directly fix these mistakes.`,
      "Return questions only as schema-valid JSON.",
    ].join("\n\n"),
    overrides: { maxOutputTokens: getQuizOutputTokens(safeCount, "multiple") },
  });

  const batchQuestions = await generateQuizBatch({
    runtimeConfig,
    languageCode,
    prompt: promptPlan.userPrompt,
    batchCount: safeCount,
    type: "multiple",
    systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
    outputTokens: promptPlan.budgets.maxOutputTokens,
  });

  return dedupeByKey(
    batchQuestions.map((item, index) => normalizeQuizQuestion(item, index, item?.type || "multiple")).filter(Boolean),
    (item) => item.question.toLowerCase()
  ).slice(0, safeCount);
}

async function generateMistakeRecoveryFlashcards({
  runtimeConfig,
  languageCode,
  preset,
  citationMode,
  resolvedContextPack,
  mistakeEntries,
  supportDocs,
  requestedCount,
}) {
  const safeCount = Math.max(4, Math.min(12, Number(requestedCount) || 6));
  const promptPlan = adaptPrompt({
    task: "flashcards",
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    preset,
    language: languageCode,
    teachingMode: "deep",
    contextPack: resolvedContextPack,
    schemaHint: [
      "Return only valid JSON inside <json>...</json>.",
      "Top-level shape: {\"cards\": [...]}",
      "Each card must include: id, front, back, category, citation.",
    ].join("\n"),
    extraInstructions: [
      buildCitationInstruction(citationMode),
      "These cards are recovery cards based on the student's mistakes.",
      "Each card should reteach the missing logic and make the student answer the next similar question correctly.",
      "Prefer concept + reasoning cards over trivia cards.",
    ].join("\n"),
    userPrompt: [
      supportDocs.length ? `Support kaynaklar: ${supportDocs.map((doc) => doc.name).join(" | ")}` : "Support kaynak yok.",
      `Hedef hata listesi:\n<json>${JSON.stringify(mistakeEntries.map((item) => ({
        id: item.id,
        question: item.question,
        userAnswer: item.userAnswer,
        correctAnswer: item.correctAnswer,
        explanation: item.explanation,
        category: item.category,
        citation: item.citation,
      })))}</json>`,
      `Create ${safeCount} recovery flashcards that teach the missing concepts behind these mistakes.`,
    ].join("\n\n"),
    overrides: { maxOutputTokens: getFlashcardOutputTokens(safeCount) },
  });

  const cards = await generateFlashcardBatch({
    runtimeConfig,
    languageCode,
    prompt: promptPlan.userPrompt,
    batchCount: safeCount,
    systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
    outputTokens: promptPlan.budgets.maxOutputTokens,
  });

  return dedupeByKey(
    cards.map((item, index) => normalizeFlashcard(item, index)).filter(Boolean),
    (item) => item.front.toLowerCase()
  ).slice(0, safeCount);
}

async function generateTeacherQuestionQuizBatch({
  runtimeConfig,
  languageCode,
  preset,
  citationMode,
  resolvedContextPack,
  questions,
  supportDocs,
}) {
  const questionPayload = questions.map((item) => ({
    id: item.id,
    prompt: item.prompt,
    type: item.type,
    options: item.options,
  }));

  const promptPlan = adaptPrompt({
    task: "quiz",
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    preset,
    language: languageCode,
    teachingMode: "drill",
    contextPack: resolvedContextPack,
    schemaHint: [
      "Return only valid JSON inside <json>...</json>.",
      "Top-level shape: {\"questions\": [...]}",
      "Preserve the provided id for each question.",
      "Each item must include: id, question, type, options, answer, explanation, category, citation.",
      "Keep the original question wording unless it clearly needs tiny cleanup.",
      "If the question already has options, keep them.",
      "For true/false use options [\"True\",\"False\"].",
    ].join("\n"),
    extraInstructions: [
      buildCitationInstruction(citationMode),
      "These are teacher-provided exam questions. Solve them using the selected support sources when available.",
      "Teach the logic behind the answer in the explanation, not just the final answer.",
      supportDocs.length
        ? "Support documents are available. Use them to ground the solution and the explanation."
        : "No support document was selected. You may infer cautiously from the question text itself, but do not invent fake citations.",
    ].join("\n"),
    userPrompt: [
      supportDocs.length
        ? `Support kaynaklar: ${supportDocs.map((doc) => doc.name).join(" | ")}`
        : "Support kaynak yok.",
      `Teacher question batch:\n<json>${JSON.stringify(questionPayload)}</json>`,
      "Return the solved teacher questions only as schema-valid JSON.",
    ].join("\n\n"),
    overrides: { maxOutputTokens: getQuizOutputTokens(questions.length, "multiple") },
  });

  const raw = await callAI(promptPlan.userPrompt, runtimeConfig, {
    maxOutputTokens: promptPlan.budgets.maxOutputTokens,
    temperature: 0.15,
    systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.questions) || !parsed.questions.length) {
    parsed = await repairStructuredJson(raw, "questions", runtimeConfig, languageCode, `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`);
  }

  return Array.isArray(parsed?.questions) ? parsed.questions : [];
}

async function generateTeacherQuestionFlashcards({
  runtimeConfig,
  languageCode,
  preset,
  citationMode,
  resolvedContextPack,
  questions,
  supportDocs,
  requestedCount,
}) {
  const promptPlan = adaptPrompt({
    task: "flashcards",
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    preset,
    language: languageCode,
    teachingMode: "deep",
    contextPack: resolvedContextPack,
    schemaHint: [
      "Return only valid JSON inside <json>...</json>.",
      "Top-level shape: {\"cards\": [...]}",
      "Each card must include: id, front, back, category, citation.",
    ].join("\n"),
    extraInstructions: [
      buildCitationInstruction(citationMode),
      "These flashcards must teach the logic behind the teacher's exam questions until the student understands the concept.",
      "Prefer concept-and-solution cards over shallow definition cards.",
      supportDocs.length
        ? "Use support documents to explain why the answer works."
        : "If support documents are missing, derive the teaching card from the question wording itself and avoid fake citations.",
    ].join("\n"),
    userPrompt: [
      supportDocs.length
        ? `Support kaynaklar: ${supportDocs.map((doc) => doc.name).join(" | ")}`
        : "Support kaynak yok.",
      `Question set:\n<json>${JSON.stringify(questions.map((item) => ({
        id: item.id,
        prompt: item.prompt,
        type: item.type,
        options: item.options,
      })))}</json>`,
      `Create ${requestedCount} flashcards that teach the concepts behind these teacher questions.`,
    ].join("\n\n"),
    overrides: { maxOutputTokens: getFlashcardOutputTokens(requestedCount) },
  });

  const raw = await callAI(promptPlan.userPrompt, runtimeConfig, {
    maxOutputTokens: promptPlan.budgets.maxOutputTokens,
    temperature: 0.15,
    systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) {
    parsed = await repairStructuredJson(raw, "cards", runtimeConfig, languageCode, `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`);
  }

  return Array.isArray(parsed?.cards) ? parsed.cards : [];
}

async function explainTeacherQuestion({
  runtimeConfig,
  languageCode,
  preset,
  citationMode,
  contextPack,
  question,
  supportDocs,
  questionState,
}) {
  const optionBlock = question.type !== "classic" && question.options?.length
    ? `Options:\n${question.options.join("\n")}`
    : "";
  const promptPlan = adaptPrompt({
    task: "explain",
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    preset,
    language: languageCode,
    teachingMode: "deep",
    contextPack,
    userPrompt: [
      "Teach this teacher-provided exam question step by step.",
      "First explain what the question is testing.",
      "Then teach the underlying concept in a teacher-like way.",
      "Then show how to reach the answer without skipping logic.",
      "End with a short exam tip.",
      `Question:\n${question.prompt}`,
      optionBlock,
      supportDocs.length ? `Support sources: ${supportDocs.map((doc) => doc.name).join(" | ")}` : "No support sources selected.",
    ].filter(Boolean).join("\n\n"),
    extraInstructions: [
      buildCitationInstruction(citationMode),
      "Do not just restate the question. Turn it into a mini-lesson that teaches the logic.",
      "If support sources are selected, connect the question to those sources and cite them inline.",
      questionState?.wrongCount > 0
        ? `The student has already missed this question ${questionState.wrongCount} time(s). Be firmer: explain why the tempting wrong options fail, point out the trap, and end with one short retry checkpoint.`
        : "",
    ].join("\n"),
  });

  const raw = await callAI(promptPlan.userPrompt, runtimeConfig, {
    maxOutputTokens: Math.min(promptPlan.budgets.maxOutputTokens, getTeacherQuestionOutputTokens(preset, runtimeConfig.provider, "teach")),
    temperature: promptPlan.budgets.temperature,
    systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
  });

  return String(raw || "").trim();
}

async function evaluateTeacherQuestionAnswer({
  runtimeConfig,
  languageCode,
  preset,
  citationMode,
  contextPack,
  question,
  userAnswer,
  supportDocs,
  questionState,
}) {
  const optionBlock = question.type !== "classic" && question.options?.length
    ? `Options:\n${question.options.join("\n")}`
    : "";
  const schemaHint = [
    "Return only valid JSON inside <json>...</json>.",
    "Top-level shape: {\"isCorrect\":true,\"score\":0,\"correctAnswer\":\"\",\"feedback\":\"\",\"teachingExplanation\":\"\",\"citation\":\"\",\"category\":\"\"}",
    "score must be between 0 and 100.",
    "correctAnswer must be the best answer in the selected output language.",
  ].join("\n");

  const promptPlan = adaptPrompt({
    task: "explain",
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    preset,
    language: languageCode,
    teachingMode: "drill",
    contextPack,
    schemaHint,
    userPrompt: [
      "Evaluate the student's answer to this teacher-provided exam question.",
      "Judge correctness, explain the logic, and teach the concept clearly.",
      `Question:\n${question.prompt}`,
      optionBlock,
      `Student answer:\n${userAnswer}`,
      supportDocs.length ? `Support sources: ${supportDocs.map((doc) => doc.name).join(" | ")}` : "No support sources selected.",
    ].filter(Boolean).join("\n\n"),
    extraInstructions: [
      buildCitationInstruction(citationMode),
      "When the answer is wrong or incomplete, explain the missing reasoning in a teacher-like way.",
      "Be strict but constructive.",
      questionState?.wrongCount > 0
        ? `This student has already missed this question ${questionState.wrongCount} time(s). Use stronger correction, expose the misconception clearly, and end with one line they should remember next time.`
        : "",
    ].join("\n"),
  });

  const raw = await callAI(promptPlan.userPrompt, runtimeConfig, {
    maxOutputTokens: Math.min(promptPlan.budgets.maxOutputTokens, getTeacherQuestionOutputTokens(preset, runtimeConfig.provider, "check")),
    temperature: 0.1,
    systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.correctAnswer !== "string") {
    const repaired = await repairStructuredJson(raw, "evaluation", runtimeConfig, languageCode, `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`);
    parsed = repaired?.evaluation && typeof repaired.evaluation === "object" ? repaired.evaluation : repaired;
  }

  return {
    isCorrect: parsed?.isCorrect === true,
    score: Number.isFinite(parsed?.score) ? Math.max(0, Math.min(100, Number(parsed.score))) : 0,
    correctAnswer: String(parsed?.correctAnswer || "").trim(),
    feedback: String(parsed?.feedback || "").trim(),
    teachingExplanation: String(parsed?.teachingExplanation || "").trim(),
    citation: String(parsed?.citation || "").trim(),
    category: String(parsed?.category || "").trim(),
  };
}

function buildMermaidMindMap(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!nodes.length) return "";

  const lines = ["flowchart LR"];
  nodes.forEach((node, index) => {
    const id = String(node.id || `n${index + 1}`).replace(/[^A-Za-z0-9_]/g, "_");
    const label = String(node.label || node.title || `Node ${index + 1}`).replace(/"/g, "'");
    lines.push(`  ${id}["${label}"]`);
  });
  edges.forEach((edge) => {
    const from = String(edge.from || "").replace(/[^A-Za-z0-9_]/g, "_");
    const to = String(edge.to || "").replace(/[^A-Za-z0-9_]/g, "_");
    if (!from || !to) return;
    const label = String(edge.label || "").trim().replace(/"/g, "'");
    lines.push(label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`);
  });
  return lines.join("\n");
}

app.post("/api/session", (req, res) => {
  const sessionId = uuidv4();
  const session = getSession(sessionId);
  const { name, uiLocale, responseLanguage, theme, promptPreset, simpleMode, fontScale } = req.body || {};
  if (typeof name === "string" && name.trim()) session.name = name.trim();
  if (uiLocale) session.preferences.uiLocale = normalizeUiLocale(uiLocale);
  if (responseLanguage) session.preferences.responseLanguage = normalizeResponseLanguage(responseLanguage);
  if (typeof theme === "string" && theme) session.preferences.theme = theme;
  if (promptPreset) session.preferences.promptPreset = normalizePromptPreset(promptPreset);
  if (typeof simpleMode === "boolean") session.preferences.simpleMode = simpleMode;
  if (fontScale) session.preferences.fontScale = normalizeFontScale(fontScale);
  session.createdAt = Date.now();
  saveSession(session);
  res.json({ success: true, sessionId, name: session.name || null });
});

app.post("/api/session/:id/preferences", (req, res) => {
  const sessionId = req.params.id;
  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  const payload = req.body || {};
  session.preferences = {
    ...session.preferences,
    promptPreset: payload.promptPreset ? normalizePromptPreset(payload.promptPreset) : session.preferences.promptPreset,
    responseLanguage: payload.responseLanguage ? normalizeResponseLanguage(payload.responseLanguage) : session.preferences.responseLanguage,
    uiLocale: payload.uiLocale ? normalizeUiLocale(payload.uiLocale) : normalizeUiLocale(session.preferences.uiLocale),
    theme: typeof payload.theme === "string" && payload.theme ? payload.theme : session.preferences.theme,
    simpleMode: typeof payload.simpleMode === "boolean" ? payload.simpleMode : session.preferences.simpleMode,
    fontScale: payload.fontScale ? normalizeFontScale(payload.fontScale) : normalizeFontScale(session.preferences.fontScale),
  };
  saveSession(session);
  res.json({ success: true, preferences: session.preferences });
});

app.get("/api/sessions", (req, res) => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    const list = files
      .map((f) => {
        try {
          const loaded = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
          const s = normalizeSession(loaded, loaded.id || f.replace(/\.json$/, ""));
          return {
            id: s.id,
            name: s.name || null,
            messageCount: s.history.length,
            documentCount: s.documents.length,
            indexedDocumentCount: s.documents.filter((d) => d.indexed).length,
            createdAt: s.createdAt,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.json(list);
  } catch {
    res.json([]);
  }
});

app.delete("/api/session/:id", (req, res) => {
  const sessionId = req.params.id;
  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda bir sessionId gerekli.");
  }

  const session = getSession(sessionId);
  for (const doc of session.documents) {
    cleanupDocumentPreview(sessionId, doc.id);
  }

  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  sessions.delete(sessionId);
  res.json({ success: true });
});
app.post("/api/upload", handleUploadSingle, async (req, res) => {
  let tempPath = "";
  let sessionId = "";
  let documentId = "";

  try {
    ({ sessionId } = req.body || {});
    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz sessionId.", "Yukleme icin aktif bir oturum gerekli.");
    }

    const file = req.file;
    if (!file) {
      return sendError(res, 400, "FILE_REQUIRED", "Dosya yuklenmedi.", "PDF, TXT, MD, DOCX, PNG, JPG, WEBP veya PPTX yukleyin.");
    }

    tempPath = file.path;
    const session = getSession(sessionId);
    const runtimeConfig = getActiveRuntimeConfig();
    documentId = uuidv4();
    const analysis = await analyzeUploadedFile(file.path, file.mimetype, runtimeConfig, file.originalname, {
      sessionId,
      documentId,
    });
    const questionSet = analysis.indexed && analysis.text
      ? buildQuestionSetFromText(analysis.text, file.originalname)
      : normalizeQuestionSet();

    const docEntry = {
      id: documentId,
      name: file.originalname,
      type: file.mimetype,
      text: analysis.text || "",
      indexed: !!analysis.indexed,
      reason: analysis.reason || "",
      hint: analysis.hint || "",
      uploadedAt: Date.now(),
      topics: [],
      preview: analysis.preview || null,
      ocrRegions: normalizeOcrRegions(analysis.ocrRegions),
      ocrQuality: ["low", "medium", "high"].includes(analysis.ocrQuality) ? analysis.ocrQuality : "medium",
      detectedQuestionCount: Math.max(
        Number.isFinite(analysis.detectedQuestionCount) ? analysis.detectedQuestionCount : 0,
        questionSet?.count || 0
      ),
      questionSet,
    };

    session.documents.push(docEntry);
    saveSession(session);

    return res.json({
      success: true,
      documentId: docEntry.id,
      fileName: docEntry.name,
      indexed: docEntry.indexed,
      reason: docEntry.reason,
      hint: docEntry.hint,
      hasText: !!docEntry.text,
      preview: getDocumentPreviewState(sessionId, docEntry),
      questionSource: !!docEntry.questionSet?.detected,
      ocrRegionCount: Array.isArray(docEntry.ocrRegions) ? docEntry.ocrRegions.length : 0,
      ocrQuality: docEntry.ocrQuality,
      detectedQuestionCount: docEntry.detectedQuestionCount,
      questionSummary: {
        count: docEntry.questionSet?.count || 0,
        types: docEntry.questionSet?.types || [],
        tags: docEntry.questionSet?.tags || [],
      },
    });
  } catch (err) {
    console.error("Upload error:", err);
    if (sessionId && documentId) {
      cleanupDocumentPreview(sessionId, documentId);
    }
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupErr) {
        console.error("Upload temp cleanup error:", cleanupErr.message);
      }
    }
  }
});

app.get("/api/settings", (req, res) => {
  res.json(getSettingsResponse(appConfig, true));
});

app.post("/api/settings", (req, res) => {
  const payload = req.body || {};
  const fieldErrors = validateSettingsPayload(payload);

  if (Object.keys(fieldErrors).length > 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Ayarlar gecersiz.", "Alanlari kontrol edip tekrar deneyin.", {
      errors: fieldErrors,
    });
  }

  const targetProvider = payload.provider || appConfig.activeProvider;
  const candidate = buildCandidateConfigState(payload, appConfig, { switchActive: true });
  const configErrors = validateCandidateConfig(candidate, targetProvider);

  if (Object.keys(configErrors).length > 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Ayarlar gecersiz.", "Eksik alanlari tamamlayin.", {
      errors: configErrors,
    });
  }

  appConfig = candidate;
  saveConfig(appConfig);
  return res.json(getSettingsResponse(appConfig, false));
});

app.post("/api/settings/test", async (req, res) => {
  const payload = req.body || {};
  const fieldErrors = validateSettingsPayload(payload);

  if (Object.keys(fieldErrors).length > 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Baglanti testi ayarlari gecersiz.", "Alanlari kontrol edin.", {
      errors: fieldErrors,
    });
  }

  const targetProvider = payload.provider || appConfig.activeProvider;
  const candidateState = buildCandidateConfigState(payload, appConfig, { switchActive: false });
  const candidate = {
    provider: targetProvider,
    ...getProfileConfig(candidateState, targetProvider),
  };
  const configErrors = validateCandidateConfig(candidateState, targetProvider);

  if (Object.keys(configErrors).length > 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Baglanti testi icin alanlar eksik.", "Model/baseUrl bilgilerini tamamlayin.", {
      errors: configErrors,
    });
  }

  try {
    const result = await testProviderConnection(candidate);
    const testedState = normalizeAppConfig(appConfig);
    testedState.profiles[targetProvider] = normalizeProviderProfile(targetProvider, {
      ...testedState.profiles[targetProvider],
      lastTest: buildLastTestRecord("ok", result),
    });
    appConfig = testedState;
    saveConfig(appConfig);
    return res.json(result);
  } catch (err) {
    const mapped = mapProviderError(err);
    const testedState = normalizeAppConfig(appConfig);
    testedState.profiles[targetProvider] = normalizeProviderProfile(targetProvider, {
      ...testedState.profiles[targetProvider],
      lastTest: buildLastTestRecord("error", {
        message: mapped.message,
        hint: mapped.hint,
        code: mapped.code,
        baseUrl: candidate.baseUrl || "",
        availableModels: mapped.availableModels || [],
        modelOrigin: mapped.modelOrigin || "",
      }),
    });
    appConfig = testedState;
    saveConfig(appConfig);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
      baseUrl: candidate.baseUrl || "",
      availableModels: mapped.availableModels || [],
      modelOrigin: mapped.modelOrigin || "",
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      sessionId,
      message,
      language = "tr-TR",
      mode = "deep",
      preset = "auto",
      citationMode = "inline",
      contextPack = {},
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz sessionId.", "UUID formatinda sessionId gonderin.");
    }

    if (typeof message !== "string" || !message.trim()) {
      return sendError(res, 400, "MESSAGE_REQUIRED", "message zorunlu.", "Bos mesaj gonderilemez.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API anahtarini kaydedin.");
    }

    const session = getSession(sessionId);
    const indexedDocs = getIndexedDocuments(session);

    if (indexedDocs.length === 0) {
      return sendError(
        res,
        400,
        "NO_INDEXED_DOCUMENT",
        "Sohbet icin en az bir analiz edilebilir dokuman gerekli.",
        "PDF/TXT/MD yukleyin veya gorsel icin Gemini vision uyumlu bir model secin."
      );
    }

    const userMessage = message.trim();
    const safeMode = ["deep", "rapid", "drill", "viva", "paper"].includes(mode) ? mode : "deep";
    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const resolvedContextPack = resolveRouteContextPack(session, { contextPack }, { maxChars: MAX_DOC_CONTEXT_TOTAL_CHARS });
    const effectiveDocs = resolvedContextPack.documentIds.length
      ? indexedDocs.filter((doc) => resolvedContextPack.documentIds.includes(doc.id))
      : indexedDocs;
    const groundedUserMessage = buildTutorUserMessage(userMessage, effectiveDocs);
    const promptPlan = adaptPrompt({
      task: "chat",
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      preset: safePreset,
      language: safeLanguage,
      teachingMode: safeMode,
      contextPack: resolvedContextPack,
      userPrompt: groundedUserMessage,
      extraInstructions: [
        CHAT_SYSTEM_PROMPT,
        buildCitationInstruction(normalizeCitationMode(citationMode)),
        "If the user asks to continue, continue from the current document flow instead of resetting the topic.",
      ].join("\n"),
      overrides: { maxOutputTokens: getChatOutputTokens(safeMode) },
    });
    const response = await sendChatMessage(session.history, promptPlan, runtimeConfig);

    if (typeof response === "string" && response.trim().startsWith("[[OUT_OF_SCOPE_QUERY]]")) {
      return sendError(
        res,
        400,
        "OUT_OF_SCOPE_QUERY",
        "Belgede bulunamadi.",
        "Soruyu belge konularina daha yakin bir ifadeyle sorun veya 'Feynman teknigiyle acikla' gibi bir anlatim istegi belirtin."
      );
    }

    session.history.push({ role: "user", content: userMessage });
    session.history.push({ role: "assistant", content: response });

    if (session.history.length > 50) {
      session.history = session.history.slice(-50);
    }

    session.preferences.promptPreset = safePreset;
    session.preferences.responseLanguage = safeLanguage;

    saveSession(session);
    return res.json({ success: true, response });
  } catch (err) {
    console.error("Chat error:", err.message || err);
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.post("/api/topics", async (req, res) => {
  try {
    const { sessionId, documentId = "" } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Konu listesi icin gecerli sessionId gerekli.", "Yeni bir oturum olusturup tekrar deneyin.");
    }

    const session = getSession(sessionId);
    const indexedDocs = getIndexedDocuments(session);
    if (!indexedDocs.length) {
      return sendError(res, 400, "NO_INDEXED_DOCUMENT", "Konu listesi icin analiz edilmis dokuman gerekli.", "Once PDF/TXT/PPTX yukleyin.");
    }

    const selectedDocs = getSelectedIndexedDocuments(session, documentId);
    if (!selectedDocs.length) {
      return sendError(res, 404, "DOCUMENT_NOT_FOUND", "Secilen dokuman bulunamadi veya kaynak olarak hazir degil.", "Listeden indexed durumda bir dokuman secin.");
    }

    if (documentId && selectedDocs.length === 1 && selectedDocs[0].questionSet?.detected) {
      const questionTopics = [
        ...(selectedDocs[0].questionSet?.tags || []),
        ...((selectedDocs[0].questionSet?.types || []).map((type) => `Question Type: ${type}`)),
      ].filter(Boolean);
      if (questionTopics.length) {
        return res.json({ success: true, topics: questionTopics.slice(0, 12), documentId, questionSource: true });
      }
    }

    if (documentId && selectedDocs.length === 1 && Array.isArray(selectedDocs[0].topics) && selectedDocs[0].topics.length) {
      return res.json({ success: true, topics: selectedDocs[0].topics, documentId });
    }

    const runtimeConfig = getActiveRuntimeConfig();
    const topics = await extractTopicsForDocuments(selectedDocs, runtimeConfig);
    if (!topics.length) {
      return sendError(res, 500, "TOPIC_EXTRACTION_FAILED", "Konu listesi cikarilamadi.", "Daha acik metin iceren bir dokuman deneyin.");
    }

    if (documentId && selectedDocs.length === 1) {
      selectedDocs[0].topics = topics;
      saveSession(session);
    }

    return res.json({ success: true, topics, documentId: documentId || "" });
  } catch (err) {
    console.error("Topic extraction error:", err);
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.post("/api/context/suggest-pages", (req, res) => {
  try {
    const { sessionId, documentId, selectedPages = [], limit = 4 } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Baglantili sayfa onerisi icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }
    if (typeof documentId !== "string" || !documentId.trim()) {
      return sendError(res, 400, "DOCUMENT_REQUIRED", "documentId zorunlu.", "Oneri icin bir kaynak dokuman secin.");
    }

    const session = getSession(sessionId);
    const suggestions = suggestRelatedPages({
      session,
      documentId: documentId.trim(),
      selectedPages: Array.isArray(selectedPages) ? selectedPages : [],
      limit: Math.max(1, Math.min(8, Number(limit) || 4)),
    });

    return res.json({
      success: true,
      documentId: documentId.trim(),
      selectedPages: Array.isArray(selectedPages) ? selectedPages : [],
      suggestions,
    });
  } catch (err) {
    console.error("Context suggestion error:", err);
    return sendError(res, 500, "SUGGESTION_FAILED", "Baglantili sayfa onerisi olusturulamadi.", err.message || "Tekrar deneyin.");
  }
});

app.get("/api/review-queue", (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Review queue icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  const queue = buildReviewQueue(session, { limit: Math.max(1, Math.min(50, Number(req.query.limit) || 20)) });
  return res.json({ success: true, items: queue });
});

app.post("/api/review-grade", (req, res) => {
  try {
    const { sessionId, deckId, cardId, grade = "good" } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Review kaydi icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }
    if (!deckId || !cardId) {
      return sendError(res, 400, "REVIEW_TARGET_REQUIRED", "deckId ve cardId zorunlu.", "Bir deste ve kart secin.");
    }

    const safeGrade = ["again", "hard", "good", "easy"].includes(grade) ? grade : "good";
    const session = getSession(sessionId);
    const result = reviewDeckCard(session, { deckId, cardId, grade: safeGrade });
    saveSession(session);
    return res.json({
      success: true,
      deckId,
      cardId,
      grade: safeGrade,
      due: result.card.fsrs?.due || null,
      difficulty: result.card.fsrs?.difficulty || 0,
      reps: result.card.fsrs?.reps || 0,
    });
  } catch (err) {
    return sendError(res, 404, "REVIEW_UPDATE_FAILED", "Review durumu guncellenemedi.", err.message || "Kart veya deste bulunamadi.");
  }
});

app.post("/api/progress/record", (req, res) => {
  try {
    const { sessionId, type = "quiz", payload = {} } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Ilerleme kaydi icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const session = getSession(sessionId);
    if (type === "study") {
      recordStudyEvent(session, payload);
    } else {
      recordQuizAttempt(session, payload);
    }
    saveSession(session);
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, 500, "PROGRESS_RECORD_FAILED", "Ilerleme kaydi guncellenemedi.", err.message || "Tekrar deneyin.");
  }
});

app.post("/api/quiz/result", (req, res) => {
  try {
    const {
      sessionId,
      quiz = {},
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Quiz sonucunu kaydetmek icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const session = getSession(sessionId);
    const stored = storeSolvedQuizAttempt(session, quiz);
    const sourceDocument = getQuestionSourceDocument(session, stored.documentId);
    if (sourceDocument) {
      const wrongEntries = stored.answers
        .map((answer, index) => ({ answer, question: stored.questions[index] || null, order: index }))
        .filter(({ answer }) => answer && !answer.isCorrect)
        .map(({ answer, question, order }) => normalizeMistakeBookEntry({
          documentId: stored.documentId,
          documentName: stored.documentName || sourceDocument.name,
          sourceType: "teacher-quiz",
          questionId: Number.isFinite(question?.id) ? question.id : order + 1,
          questionType: question?.type || "multiple",
          question: answer.question || question?.question || "",
          userAnswer: answer.userAnswer || "",
          correctAnswer: answer.correctAnswer || question?.answer || "",
          explanation: answer.explanation || question?.explanation || "",
          citation: answer.citation || question?.citation || "",
          category: answer.category || question?.category || "",
          language: stored.language || "tr-TR",
        }));
      storeMistakeBookEntries(session, wrongEntries);
    }
    saveSession(session);
    return res.json({ success: true, quiz: stored });
  } catch (err) {
    return sendError(res, 500, "QUIZ_RESULT_SAVE_FAILED", "Quiz sonucu kaydedilemedi.", err.message || "Tekrar deneyin.");
  }
});

app.post("/api/mistake-book", (req, res) => {
  try {
    const { sessionId, entries = [] } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Mistake book icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const session = getSession(sessionId);
    const stored = storeMistakeBookEntries(session, entries);
    saveSession(session);
    return res.json({ success: true, stored });
  } catch (err) {
    return sendError(res, 500, "MISTAKE_BOOK_SAVE_FAILED", "Mistake book kaydi yapilamadi.", err.message || "Tekrar deneyin.");
  }
});

app.post("/api/mistake-book/recovery-quiz", async (req, res) => {
  try {
    const {
      sessionId,
      entryIds = [],
      documentId = "",
      supportDocumentIds = [],
      language = "tr-TR",
      preset = "auto",
      citationMode = "inline",
      count = 4,
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Recovery quiz icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const session = getSession(sessionId);
    const mistakeEntries = getMistakeEntries(session, entryIds, documentId);
    if (!mistakeEntries.length) {
      return sendError(res, 404, "MISTAKE_NOT_FOUND", "Secili hata kayitlari bulunamadi.", "Mistake book'tan en az bir kayit secin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const sourceDocumentIds = [...new Set(mistakeEntries.map((item) => item.documentId).filter(Boolean))];
    const primaryDocumentId = documentId || sourceDocumentIds[0] || "";
    const supportDocs = primaryDocumentId
      ? getQuestionSupportDocuments(session, primaryDocumentId, supportDocumentIds)
      : getIndexedDocuments(session).filter((doc) => supportDocumentIds.includes(doc.id));
    const contextDocumentIds = [...new Set([...sourceDocumentIds, ...supportDocs.map((doc) => doc.id)].filter(Boolean))];
    const resolvedContextPack = buildContextPack({
      session,
      documentIds: contextDocumentIds,
      citationsRequired: normalizeCitationMode(citationMode) !== "off",
      scopeLabel: "Mistake Book Recovery Quiz",
      maxChars: 18000,
    });

    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);
    const questions = await generateMistakeRecoveryQuiz({
      runtimeConfig,
      languageCode: safeLanguage,
      preset: safePreset,
      citationMode: safeCitationMode,
      resolvedContextPack,
      mistakeEntries,
      supportDocs,
      requestedCount: count,
    });

    if (!questions.length) {
      return sendError(res, 500, "INVALID_AI_JSON", "Recovery quiz uretilemedi.", "Daha az soru veya farkli model ile tekrar deneyin.");
    }

    questions.forEach((item, index) => { item.id = index + 1; });
    return res.json({
      success: true,
      title: "Mistake Recovery Quiz",
      sourceType: "mistake-book",
      questions,
      language: safeLanguage,
      supportDocuments: supportDocs.map((doc) => ({ id: doc.id, name: doc.name })),
    });
  } catch (err) {
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.post("/api/mistake-book/recovery-flashcards", async (req, res) => {
  try {
    const {
      sessionId,
      entryIds = [],
      documentId = "",
      supportDocumentIds = [],
      language = "tr-TR",
      preset = "auto",
      citationMode = "inline",
      count = 6,
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Recovery flashcard icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const session = getSession(sessionId);
    const mistakeEntries = getMistakeEntries(session, entryIds, documentId);
    if (!mistakeEntries.length) {
      return sendError(res, 404, "MISTAKE_NOT_FOUND", "Secili hata kayitlari bulunamadi.", "Mistake book'tan en az bir kayit secin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const sourceDocumentIds = [...new Set(mistakeEntries.map((item) => item.documentId).filter(Boolean))];
    const primaryDocumentId = documentId || sourceDocumentIds[0] || "";
    const supportDocs = primaryDocumentId
      ? getQuestionSupportDocuments(session, primaryDocumentId, supportDocumentIds)
      : getIndexedDocuments(session).filter((doc) => supportDocumentIds.includes(doc.id));
    const contextDocumentIds = [...new Set([...sourceDocumentIds, ...supportDocs.map((doc) => doc.id)].filter(Boolean))];
    const resolvedContextPack = buildContextPack({
      session,
      documentIds: contextDocumentIds,
      citationsRequired: normalizeCitationMode(citationMode) !== "off",
      scopeLabel: "Mistake Book Recovery Cards",
      maxChars: 18000,
    });

    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);
    const cards = await generateMistakeRecoveryFlashcards({
      runtimeConfig,
      languageCode: safeLanguage,
      preset: safePreset,
      citationMode: safeCitationMode,
      resolvedContextPack,
      mistakeEntries,
      supportDocs,
      requestedCount: count,
    });

    if (!cards.length) {
      return sendError(res, 500, "INVALID_AI_JSON", "Recovery kartlari uretilemedi.", "Daha az kart veya farkli model ile tekrar deneyin.");
    }

    cards.forEach((item, index) => { item.id = index + 1; });
    const deck = storeGeneratedDeck(session, {
      deckId: uuidv4(),
      deckName: "Mistake Recovery Cards",
      sourceDocumentId: primaryDocumentId,
      topic: "Mistake Recovery",
      language: safeLanguage,
      preset: safePreset,
      cards,
    });
    saveSession(session);

    return res.json({
      success: true,
      title: deck.name,
      deckId: deck.id,
      cards,
      language: safeLanguage,
      supportDocuments: supportDocs.map((doc) => ({ id: doc.id, name: doc.name })),
    });
  } catch (err) {
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.get("/api/progress/summary", (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Progress ozeti icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  return res.json({ success: true, summary: buildProgressSummary(session) });
});

app.delete("/api/progress", (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Progress sifirlama icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  session.progress = {};
  session.review = {};
  ensureSessionReviewState(session);
  saveSession(session);
  return res.json({ success: true });
});

app.post("/api/audio-overview", async (req, res) => {
  try {
    const {
      sessionId,
      documentId = "",
      documentIds = [],
      contextPack = {},
      language = "tr-TR",
      preset = "auto",
      teachingMode = "deep",
      topic = "",
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Audio overview icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const session = getSession(sessionId);
    const resolvedContextPack = resolveRouteContextPack(session, { documentId, documentIds, contextPack }, { maxChars: 14000 });
    if (!resolvedContextPack.sources.length) {
      return sendError(res, 400, "NO_INDEXED_DOCUMENT", "Audio overview icin kaynak gerekli.", "Dokuman yukleyin ve kaynak secin.");
    }

    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const schemaHint = [
      "Return only valid JSON inside <json>...</json>.",
      "Shape: {\"title\":\"...\",\"lines\":[{\"speaker\":\"Host A\",\"text\":\"...\",\"citation\":\"[Page 4]\"}]}",
      "Create 8 to 14 turns. Keep each line brief enough for browser speech synthesis.",
    ].join("\n");

    const promptPlan = adaptPrompt({
      task: "audio",
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      preset: safePreset,
      language: safeLanguage,
      teachingMode,
      contextPack: resolvedContextPack,
      schemaHint,
      extraInstructions: "Create a grounded podcast-style overview with two speakers. Do not add facts outside the source pack.",
      userPrompt: topic ? `Focus topic: ${topic}` : "Cover the most important ideas in source order.",
    });

    const raw = await callAI(promptPlan.userPrompt, runtimeConfig, {
      maxOutputTokens: promptPlan.budgets.maxOutputTokens,
      temperature: promptPlan.budgets.temperature,
      systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
    });

    let parsed = extractJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.lines) || !parsed.lines.length) {
      parsed = await repairStructuredJson(raw, "lines", runtimeConfig, safeLanguage, `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`);
    }

    const lines = Array.isArray(parsed?.lines)
      ? parsed.lines
          .map((line) => ({
            speaker: String(line.speaker || "Host A").trim() || "Host A",
            text: String(line.text || "").trim(),
            citation: String(line.citation || "").trim(),
          }))
          .filter((line) => line.text)
      : [];

    if (!lines.length) {
      return sendError(res, 500, "INVALID_AI_JSON", "Audio overview uretilemedi.", "Model gecerli script donmedi.");
    }

    session.generated.audioHistory.unshift({
      id: uuidv4(),
      title: String(parsed?.title || topic || "Audio Overview").trim() || "Audio Overview",
      lines,
      createdAt: Date.now(),
      language: safeLanguage,
    });
    session.generated.audioHistory = session.generated.audioHistory.slice(0, 20);
    saveSession(session);

    return res.json({
      success: true,
      title: session.generated.audioHistory[0].title,
      lines,
    });
  } catch (err) {
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, { details: err.message || String(err) });
  }
});

app.post("/api/mind-map", async (req, res) => {
  try {
    const {
      sessionId,
      documentId = "",
      documentIds = [],
      contextPack = {},
      language = "tr-TR",
      preset = "auto",
      teachingMode = "deep",
      topic = "",
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Mind map icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const session = getSession(sessionId);
    const resolvedContextPack = resolveRouteContextPack(session, { documentId, documentIds, contextPack }, { maxChars: 12000 });
    if (!resolvedContextPack.sources.length) {
      return sendError(res, 400, "NO_INDEXED_DOCUMENT", "Mind map icin kaynak gerekli.", "Dokuman yukleyin ve kaynak secin.");
    }

    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const schemaHint = [
      "Return only valid JSON inside <json>...</json>.",
      "Shape: {\"title\":\"...\",\"nodes\":[{\"id\":\"root\",\"label\":\"Main Topic [Page 4]\"}],\"edges\":[{\"from\":\"root\",\"to\":\"n1\",\"label\":\"leads to\"}]}",
      "Keep 5 to 10 nodes. Every node label should stay grounded to the source pack.",
    ].join("\n");

    const promptPlan = adaptPrompt({
      task: "mind-map",
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      preset: safePreset,
      language: safeLanguage,
      teachingMode,
      contextPack: resolvedContextPack,
      schemaHint,
      extraInstructions: "Build a grounded concept map. Do not add unsupported concepts.",
      userPrompt: topic ? `Focus topic: ${topic}` : "Map the main concept structure in source order.",
    });

    const raw = await callAI(promptPlan.userPrompt, runtimeConfig, {
      maxOutputTokens: promptPlan.budgets.maxOutputTokens,
      temperature: promptPlan.budgets.temperature,
      systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
    });

    let parsed = extractJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.nodes) || !parsed.nodes.length) {
      parsed = await repairStructuredJson(raw, "nodes", runtimeConfig, safeLanguage, `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`);
    }

    const mermaid = buildMermaidMindMap(parsed);
    if (!mermaid) {
      return sendError(res, 500, "INVALID_AI_JSON", "Mind map uretilemedi.", "Model gecerli dugum/kenar yapisi donmedi.");
    }

    const result = {
      id: uuidv4(),
      title: String(parsed?.title || topic || "Mind Map").trim() || "Mind Map",
      nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed?.edges) ? parsed.edges : [],
      mermaid,
      createdAt: Date.now(),
      language: safeLanguage,
    };

    session.generated.mindMaps.unshift(result);
    session.generated.mindMaps = session.generated.mindMaps.slice(0, 20);
    saveSession(session);

    return res.json({ success: true, ...result });
  } catch (err) {
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, { details: err.message || String(err) });
  }
});

app.post("/api/quiz", async (req, res) => {
  try {
    const {
      sessionId,
      type = "multiple",
      count = 5,
      difficulty = "medium",
      topic = "",
      documentId = "",
      supportDocumentIds = [],
      language = "tr-TR",
      preset = "auto",
      citationMode = "inline",
      contextPack = {},
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Quiz olusturmak icin gecerli sessionId gerekli.", "Yeni bir oturum olusturup tekrar deneyin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const session = getSession(sessionId);
    const primaryDoc = documentId
      ? session.documents.find((doc) => doc.id === documentId)
      : null;
    const indexedDocs = getSelectedIndexedDocuments(session, documentId);
    const safeLanguage = normalizeResponseLanguage(language);
    const requestedCount = Math.max(1, Math.min(30, Number(count) || 5));
    const safeType = ["multiple", "classic", "truefalse"].includes(type) ? type : "multiple";
    const safeDifficulty = ["easy", "medium", "hard"].includes(difficulty) ? difficulty : "medium";
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);

    if (indexedDocs.length === 0) {
      return sendError(
        res,
        documentId ? 404 : 400,
        documentId ? "DOCUMENT_NOT_FOUND" : "NO_INDEXED_DOCUMENT",
        documentId ? "Secilen dokuman quiz icin hazir degil." : "Quiz uretmek icin en az bir analiz edilmis dokuman gerekli.",
        documentId ? "Listeden indexed durumda bir dokuman secin." : "Dokuman yukleyip analiz durumu indexed olan bir kaynak olusturun."
      );
    }

    if (primaryDoc?.questionSet?.detected && primaryDoc.questionSet.questions.length) {
      const supportDocs = getQuestionSupportDocuments(session, primaryDoc.id, supportDocumentIds);
      const teacherQuestions = primaryDoc.questionSet.questions.slice(0, requestedCount);
      const teacherContextPackInput = {
        ...normalizeContextPackPayload(contextPack),
        documentIds: [primaryDoc.id, ...supportDocs.map((doc) => doc.id)],
      };
      const resolvedTeacherContextPack = resolveRouteContextPack(
        session,
        { documentId: "", contextPack: teacherContextPackInput },
        { maxChars: 18000 }
      );

      const solvedQuestions = [];
      const batchSize = 4;
      for (let offset = 0; offset < teacherQuestions.length; offset += batchSize) {
        const batch = teacherQuestions.slice(offset, offset + batchSize);
        const aiBatch = await generateTeacherQuestionQuizBatch({
          runtimeConfig,
          languageCode: safeLanguage,
          preset: safePreset,
          citationMode: safeCitationMode,
          resolvedContextPack: resolvedTeacherContextPack,
          questions: batch,
          supportDocs,
        });

        const mergedBatch = batch.map((sourceQuestion) => {
          const aiQuestion = aiBatch.find((item) => Number(item?.id) === sourceQuestion.id) || {};
          return normalizeQuizQuestion({
            id: sourceQuestion.id,
            question: aiQuestion.question || sourceQuestion.prompt,
            type: sourceQuestion.type,
            options: sourceQuestion.options.length ? sourceQuestion.options : aiQuestion.options,
            answer: aiQuestion.answer || "",
            explanation: aiQuestion.explanation || aiQuestion.rationale || "",
            citation: aiQuestion.citation || `[Question Sheet: ${primaryDoc.name}]`,
            category: aiQuestion.category || topic.trim() || primaryDoc.name,
          }, sourceQuestion.id - 1, "mixed");
        }).filter(Boolean);

        solvedQuestions.push(...mergedBatch);
      }

      const normalizedTeacherQuestions = dedupeByKey(
        solvedQuestions,
        (item) => `${item.type}:${item.question.toLowerCase()}`
      ).slice(0, requestedCount);

      if (!normalizedTeacherQuestions.length) {
        return sendError(
          res,
          500,
          "INVALID_TEACHER_QUESTION_SET",
          "Hoca sorulari quiz'e donusturulemedi.",
          "Soru dokumani algilandi ama cozum uretilemedi. Destek dokuman ekleyip tekrar deneyin."
        );
      }

      normalizedTeacherQuestions.forEach((item, idx) => { item.id = idx + 1; });
      return res.json({
        success: true,
        questions: normalizedTeacherQuestions,
        questionSource: true,
        supportDocuments: supportDocs.map((doc) => ({ id: doc.id, name: doc.name })),
      });
    }

    const mergedQuizContextPack = supportDocumentIds.length
      ? {
          ...normalizeContextPackPayload(contextPack),
          documentIds: [...new Set([documentId, ...supportDocumentIds].filter(Boolean))],
        }
      : contextPack;
    const resolvedContextPack = resolveRouteContextPack(session, { documentId, contextPack: mergedQuizContextPack }, { maxChars: 16000 });
    const effectiveDocs = resolvedContextPack.documentIds.length
      ? indexedDocs.filter((doc) => resolvedContextPack.documentIds.includes(doc.id))
      : indexedDocs;
    const topicCatalog = buildTopicCatalog(effectiveDocs, 18);

    const focusLine = topic && topic.trim()
      ? `Odak konusu: ${topic.trim()} (Yalnizca belgede gecen bolumlerden soru uret)`
      : "\nOdak konusu verilmedi. Belgelerdeki onemli bolumlerden soru uret.\n";

    const difficultyMap = { easy: "kolay", medium: "orta", hard: "zor" };
    const diffTR = difficultyMap[safeDifficulty] || "orta";
    const typeMap = {
      multiple: "coktan secmeli (A, B, C, D sikli)",
      classic: "acik uclu (kisa cevap)",
      truefalse: "dogru/yanlis",
    };
    const typeTR = typeMap[safeType] || "coktan secmeli";
    const batchSize = safeType === "classic" ? 4 : 6;
    const questions = [];
    const schemaHint = [
      "Return only valid JSON inside <json>...</json>.",
      "Top-level shape: {\"questions\": [...]}",
      "Each question must include: id, question, type, options, answer, explanation, category, citation.",
      safeType === "multiple"
        ? "For multiple choice, options must be exactly 4 strings. answer must be the full correct option text."
        : safeType === "truefalse"
          ? "For true/false, options must be [\"True\",\"False\"] and answer must be one of them."
          : "For classic questions, options must be []. answer must be a concise model answer.",
    ].join("\n");

    for (let offset = 0; offset < requestedCount; offset += batchSize) {
      const batchCount = Math.min(batchSize, requestedCount - offset);
      const promptPlan = adaptPrompt({
        task: "quiz",
        provider: runtimeConfig.provider,
        model: runtimeConfig.model,
        preset: safePreset,
        language: safeLanguage,
        teachingMode: "drill",
        contextPack: resolvedContextPack,
        schemaHint,
        extraInstructions: [
          buildCitationInstruction(safeCitationMode),
          `Generate ${batchCount} ${typeTR} questions at ${diffTR} difficulty.`,
          "Read the content first, follow the content order, and prefer reasoning/application checks over shallow recall.",
          "If there is not enough detail for a perfect question, stay close to the source instead of hallucinating.",
        ].join("\n"),
        userPrompt: [
          topicCatalog.length ? `Belgedeki ana konu havuzu: ${topicCatalog.join(" | ")}` : "",
          focusLine.trim(),
          "Return questions only as schema-valid JSON.",
        ].filter(Boolean).join("\n"),
        overrides: { maxOutputTokens: getQuizOutputTokens(batchCount, safeType) },
      });

      const batchQuestions = await generateQuizBatch({
        runtimeConfig,
        languageCode: safeLanguage,
        prompt: promptPlan.userPrompt,
        batchCount,
        type: safeType,
        systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
        outputTokens: promptPlan.budgets.maxOutputTokens,
      });

      const normalizedBatch = batchQuestions
        .map((item, idx) => normalizeQuizQuestion(item, questions.length + idx, safeType))
        .filter(Boolean);

      questions.push(...normalizedBatch);
    }

    const dedupedQuestions = dedupeByKey(questions, (item) => item.question.toLowerCase()).slice(0, requestedCount);
    if (!dedupedQuestions.length) {
      return sendError(res, 500, "INVALID_AI_JSON", "Quiz JSON formati gecersiz.", "Model gecerli soru uretemedi. Farkli konu, daha az soru sayisi veya baska model deneyin.");
    }

    dedupedQuestions.forEach((item, idx) => { item.id = idx + 1; });
    return res.json({ success: true, questions: dedupedQuestions });
  } catch (err) {
    console.error("Quiz error:", err);
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.post("/api/flashcards", async (req, res) => {
  try {
    const {
      sessionId,
      count = 10,
      topic = "",
      documentId = "",
      supportDocumentIds = [],
      language = "tr-TR",
      preset = "auto",
      citationMode = "inline",
      contextPack = {},
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Flashcard icin gecerli sessionId gerekli.", "Yeni bir oturum olusturup tekrar deneyin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const session = getSession(sessionId);
    const primaryDoc = documentId
      ? session.documents.find((doc) => doc.id === documentId)
      : null;
    const indexedDocs = getSelectedIndexedDocuments(session, documentId);
    const safeLanguage = normalizeResponseLanguage(language);
    const requestedCount = Math.max(1, Math.min(50, Number(count) || 10));
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);

    if (indexedDocs.length === 0) {
      return sendError(
        res,
        documentId ? 404 : 400,
        documentId ? "DOCUMENT_NOT_FOUND" : "NO_INDEXED_DOCUMENT",
        documentId ? "Secilen dokuman flashcard icin hazir degil." : "Flashcard uretmek icin en az bir analiz edilmis dokuman gerekli.",
        documentId ? "Listeden indexed durumda bir dokuman secin." : "PDF/TXT/MD yukleyin veya gorsel icin uyumlu model secin."
      );
    }

    if (primaryDoc?.questionSet?.detected && primaryDoc.questionSet.questions.length) {
      const supportDocs = getQuestionSupportDocuments(session, primaryDoc.id, supportDocumentIds);
      const questionContextPackInput = {
        ...normalizeContextPackPayload(contextPack),
        documentIds: [primaryDoc.id, ...supportDocs.map((doc) => doc.id)],
      };
      const resolvedTeacherContextPack = resolveRouteContextPack(
        session,
        { documentId: "", contextPack: questionContextPackInput },
        { maxChars: 18000 }
      );

      const aiCards = await generateTeacherQuestionFlashcards({
        runtimeConfig,
        languageCode: safeLanguage,
        preset: safePreset,
        citationMode: safeCitationMode,
        resolvedContextPack: resolvedTeacherContextPack,
        questions: primaryDoc.questionSet.questions.slice(0, Math.max(8, requestedCount)),
        supportDocs,
        requestedCount,
      });

      const normalizedCards = dedupeByKey(
        aiCards.map((item, idx) => normalizeFlashcard(item, idx)).filter(Boolean),
        (item) => item.front.toLowerCase()
      ).slice(0, requestedCount);

      if (!normalizedCards.length) {
        return sendError(
          res,
          500,
          "INVALID_TEACHER_FLASHCARDS",
          "Hoca sorularindan ogretici kartlar uretilemedi.",
          "Destek dokuman ekleyip tekrar deneyin."
        );
      }

      normalizedCards.forEach((item, idx) => { item.id = idx + 1; });
      const deckId = uuidv4();
      const deckName = topic && topic.trim()
        ? topic.trim()
        : `${primaryDoc.name} Teaching Cards`;
      const deck = storeGeneratedDeck(session, {
        deckId,
        deckName,
        sourceDocumentId: primaryDoc.id,
        topic: topic.trim(),
        language: safeLanguage,
        preset: safePreset,
        cards: normalizedCards,
      });
      saveSession(session);
      return res.json({
        success: true,
        cards: normalizedCards,
        deckId: deck.id,
        deckName: deck.name,
        questionSource: true,
        supportDocuments: supportDocs.map((doc) => ({ id: doc.id, name: doc.name })),
      });
    }

    const mergedFlashContextPack = supportDocumentIds.length
      ? {
          ...normalizeContextPackPayload(contextPack),
          documentIds: [...new Set([documentId, ...supportDocumentIds].filter(Boolean))],
        }
      : contextPack;
    const resolvedContextPack = resolveRouteContextPack(session, { documentId, contextPack: mergedFlashContextPack }, { maxChars: 16000 });
    const effectiveDocs = resolvedContextPack.documentIds.length
      ? indexedDocs.filter((doc) => resolvedContextPack.documentIds.includes(doc.id))
      : indexedDocs;
    const topicCatalog = buildTopicCatalog(effectiveDocs, 18);

    const focusLine = topic && topic.trim()
      ? `Odak konusu: ${topic.trim()} (yalnizca belge icerigine dayan)`
      : "\nOdak konusu verilmedi; belgelerdeki ana kavramlardan sec.\n";

    const batchSize = 10;
    const cards = [];
    const schemaHint = [
      "Return only valid JSON inside <json>...</json>.",
      "Top-level shape: {\"cards\": [...]}",
      "Each card must include: id, front, back, category, citation.",
      "front must be concise and durable for recall.",
      "back must teach the concept clearly without filler.",
    ].join("\n");

    for (let offset = 0; offset < requestedCount; offset += batchSize) {
      const batchCount = Math.min(batchSize, requestedCount - offset);
      const promptPlan = adaptPrompt({
        task: "flashcards",
        provider: runtimeConfig.provider,
        model: runtimeConfig.model,
        preset: safePreset,
        language: safeLanguage,
        teachingMode: "rapid",
        contextPack: resolvedContextPack,
        schemaHint,
        extraInstructions: [
          buildCitationInstruction(safeCitationMode),
          `Generate ${batchCount} flashcards that follow the source order.`,
          "Prefer cards that help retention and understanding together.",
          "Avoid shallow copy-paste cards when a stronger conceptual card can still stay grounded.",
        ].join("\n"),
        userPrompt: [
          topicCatalog.length ? `Belgedeki ana konu havuzu: ${topicCatalog.join(" | ")}` : "",
          focusLine.trim(),
          "Return cards only as schema-valid JSON.",
        ].filter(Boolean).join("\n"),
        overrides: { maxOutputTokens: getFlashcardOutputTokens(batchCount) },
      });

      const batchCards = await generateFlashcardBatch({
        runtimeConfig,
        languageCode: safeLanguage,
        prompt: promptPlan.userPrompt,
        batchCount,
        systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
        outputTokens: promptPlan.budgets.maxOutputTokens,
      });

      const normalizedBatch = batchCards
        .map((item, idx) => normalizeFlashcard(item, cards.length + idx))
        .filter(Boolean);

      cards.push(...normalizedBatch);
    }

    const dedupedCards = dedupeByKey(cards, (item) => item.front.toLowerCase()).slice(0, requestedCount);
    if (!dedupedCards.length) {
      return sendError(res, 500, "INVALID_AI_JSON", "Flashcard JSON formati gecersiz.", "Model gecerli kart uretemedi. Daha az kart sayisi veya farkli model deneyin.");
    }

    dedupedCards.forEach((item, idx) => { item.id = idx + 1; });
    const deckPrimaryDoc = effectiveDocs[0];
    const deckId = uuidv4();
    const deckName = topic && topic.trim()
      ? topic.trim()
      : (deckPrimaryDoc?.name ? `${deckPrimaryDoc.name} Cards` : `Deck ${new Date().toLocaleDateString("en-GB")}`);
    const deck = storeGeneratedDeck(session, {
      deckId,
      deckName,
      sourceDocumentId: deckPrimaryDoc?.id || "",
      topic: topic.trim(),
      language: safeLanguage,
      preset: safePreset,
      cards: dedupedCards,
    });
    saveSession(session);
    return res.json({ success: true, cards: dedupedCards, deckId: deck.id, deckName: deck.name });
  } catch (err) {
    console.error("Flashcard error:", err);
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.post("/api/explain", async (req, res) => {
  try {
    const {
      text,
      mode = "explain",
      question = "",
      pageNumber = null,
      totalPages = null,
      scopeLabel = "",
      language = "tr-TR",
      teachingMode = "deep",
      preset = "auto",
      citationMode = "inline",
      contextPack = {},
    } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return sendError(res, 400, "TEXT_REQUIRED", "text zorunlu.", "Aciklama icin metin gonderin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const safeQuestion = typeof question === "string" ? question.trim() : "";
    const safeScopeLabel = typeof scopeLabel === "string" ? scopeLabel.trim() : "";
    const safeTeachingMode = ["deep", "rapid", "drill", "viva", "paper"].includes(teachingMode) ? teachingMode : "deep";
    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);
    const safePageNumber = Number.isFinite(Number(pageNumber)) ? Number(pageNumber) : null;
    const safeTotalPages = Number.isFinite(Number(totalPages)) ? Number(totalPages) : null;
    const pageLabel = safeScopeLabel || (safePageNumber && safeTotalPages
      ? `PDF sayfasi ${safePageNumber}/${safeTotalPages}`
      : (safePageNumber ? `PDF sayfasi ${safePageNumber}` : "Mevcut calisma kapsami"));
    const resolvedContextPack = buildContextPack({
      session: { documents: [] },
      ...normalizeContextPackPayload(contextPack),
      scopeLabel: safeScopeLabel || pageLabel,
      scopeText: text,
      maxChars: 12000,
    });

    const modePrompts = {
      explain: "Explain the selected scope as a coherent lesson with concept links, logic flow, exam risks, and one check question.",
      summarize: "Summarize the selected scope without losing essential detail. Preserve order and main ideas.",
      keypoints: "List the key points in source order. For each point, include why it matters and what is easy to confuse.",
      feynman: "Teach the selected scope first like you are explaining to a beginner, then restate it in a more academic way.",
    };

    const promptPlan = adaptPrompt({
      task: "explain",
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      preset: safePreset,
      language: safeLanguage,
      teachingMode: safeTeachingMode,
      contextPack: resolvedContextPack,
      userPrompt: [
        modePrompts[mode] || modePrompts.explain,
        safeQuestion ? `User follow-up question: ${safeQuestion}` : "",
        "Do not produce decorative markdown. Use clean headings and citations only where useful.",
      ].filter(Boolean).join("\n"),
      extraInstructions: [
        buildCitationInstruction(safeCitationMode),
        "Keep the explanation source-grounded but turn the raw material into a teacher-like lesson.",
        "If the selected scope spans multiple pages, explain them as one topic flow instead of isolated page summaries.",
      ].join("\n"),
      overrides: { maxOutputTokens: EXPLAIN_MAX_OUTPUT_TOKENS },
    });

    const response = await callAI(promptPlan.userPrompt, runtimeConfig, {
      maxOutputTokens: promptPlan.budgets.maxOutputTokens,
      temperature: promptPlan.budgets.temperature,
      systemInstruction: `${SYSTEM_PROMPT}\n${promptPlan.systemInstruction}`,
    });
    return res.json({ success: true, response });
  } catch (err) {
    console.error("Explain error:", err);
    const mapped = mapProviderError(err);
    return sendError(res, mapped.status, mapped.code, mapped.message, mapped.hint, {
      details: err.message || String(err),
    });
  }
});

app.get("/api/localip", (req, res) => {
  res.json({ ip: getLocalIP(), port: PORT });
});

app.get("/api/session/:id", (req, res) => {
  const sessionId = req.params.id;
  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda sessionId kullanin.");
  }

  const session = sessions.get(sessionId);
  const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);

  if (!session && !fs.existsSync(sessionFile)) {
    return sendError(res, 404, "SESSION_NOT_FOUND", "Oturum bulunamadi.", "Yeni bir session olusturun.");
  }

  const s = session || getSession(sessionId);

  return res.json({
    success: true,
    id: s.id,
    name: s.name || null,
    messageCount: s.history.length,
    documentCount: s.documents.length,
    indexedDocumentCount: s.documents.filter((d) => d.indexed).length,
    history: s.history.map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: typeof item.content === "string" ? item.content : "",
    })),
    documents: s.documents.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      indexed: d.indexed,
      reason: d.reason,
      hint: d.hint,
      uploadedAt: d.uploadedAt || 0,
      topics: Array.isArray(d.topics) ? d.topics : [],
      preview: getDocumentPreviewState(s.id, d),
      questionSource: !!d.questionSet?.detected,
      ocrRegionCount: Array.isArray(d.ocrRegions) ? d.ocrRegions.length : 0,
      ocrQuality: d.ocrQuality || "medium",
      detectedQuestionCount: d.detectedQuestionCount || d.questionSet?.count || 0,
      questionSummary: {
        count: d.questionSet?.count || 0,
        types: d.questionSet?.types || [],
        tags: d.questionSet?.tags || [],
      },
    })),
    preferences: s.preferences,
    contextSelections: s.contextSelections,
    progress: buildProgressSummary(s),
    generated: s.generated,
  });
});

app.delete("/api/session/:id/document/:documentId", (req, res) => {
  const sessionId = req.params.id;
  const documentId = req.params.documentId;

  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  const index = session.documents.findIndex((doc) => doc.id === documentId);
  if (index === -1) {
    return sendError(res, 404, "DOCUMENT_NOT_FOUND", "Dokuman bulunamadi.", "Listeden gecerli bir dokuman secin.");
  }

  const [removed] = session.documents.splice(index, 1);
  cleanupDocumentPreview(sessionId, documentId);
  saveSession(session);

  return res.json({
    success: true,
    documentId,
    fileName: removed?.name || "",
  });
});

app.get("/api/session/:id/document/:documentId/preview", (req, res) => {
  const sessionId = req.params.id;
  const documentId = req.params.documentId;

  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  const document = session.documents.find((doc) => doc.id === documentId);
  if (!document) {
    return sendError(res, 404, "DOCUMENT_NOT_FOUND", "Dokuman bulunamadi.", "Gecerli bir dokuman secin.");
  }

  const preview = getDocumentPreviewState(sessionId, document);
  if (!preview?.available) {
    return sendError(res, 404, "PREVIEW_NOT_FOUND", "Bu dokuman icin slide preview hazir degil.", "Dosyayi yeniden yukleyin veya PPTX/PDF kullanin.");
  }

  return res.sendFile(getDocumentPreviewPdfPath(sessionId, documentId));
});

app.get("/api/session/:id/document/:documentId/text", (req, res) => {
  const sessionId = req.params.id;
  const documentId = req.params.documentId;

  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  const document = session.documents.find((doc) => doc.id === documentId);
  if (!document) {
    return sendError(res, 404, "DOCUMENT_NOT_FOUND", "Dokuman bulunamadi.", "Gecerli bir dokuman secin.");
  }

  return res.json({
    success: true,
    id: document.id,
    name: document.name,
    type: document.type,
    indexed: document.indexed,
    text: document.text || "",
    hint: document.hint || "",
  });
});

app.get("/api/session/:id/document/:documentId/questions", (req, res) => {
  const sessionId = req.params.id;
  const documentId = req.params.documentId;

  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Gecersiz oturum ID.", "UUID formatinda sessionId kullanin.");
  }

  const session = getSession(sessionId);
  const document = getQuestionSourceDocument(session, documentId);
  if (!document) {
    return sendError(res, 404, "QUESTION_SOURCE_NOT_FOUND", "Soru paketi bulunamadi.", "Question source olarak algilanan bir dokuman secin.");
  }

  return res.json({
    success: true,
    documentId: document.id,
    name: document.name,
    summary: {
      count: document.questionSet?.count || 0,
      types: document.questionSet?.types || [],
      tags: document.questionSet?.tags || [],
      statusCounts: buildTeacherQuestionStatusCounts(session, document),
    },
    questions: (document.questionSet?.questions || []).map((item) => {
      const questionState = getTeacherQuestionState(session, document.id, item.id);
      const view = buildTeacherQuestionView(item, questionState);
      return {
        id: item.id,
        prompt: item.prompt,
        options: item.options || [],
        type: view.type,
        originalType: view.originalType,
        typeOverride: view.typeOverride,
        status: questionState.status,
        attempts: questionState.attempts,
        lastActionAt: questionState.lastActionAt,
      };
    }),
  });
});

app.post("/api/teacher-questions/type", (req, res) => {
  const {
    sessionId,
    documentId = "",
    questionId,
    type = "",
  } = req.body || {};

  if (!isValidSessionId(sessionId)) {
    return sendError(res, 400, "INVALID_SESSION_ID", "Teacher Questions icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
  }
  if (!["multiple", "classic", "truefalse"].includes(type)) {
    return sendError(res, 400, "INVALID_QUESTION_TYPE", "Gecerli soru tipi secin.", "multiple, classic veya truefalse kullanin.");
  }

  const session = getSession(sessionId);
  const document = getQuestionSourceDocument(session, documentId);
  if (!document) {
    return sendError(res, 404, "QUESTION_SOURCE_NOT_FOUND", "Soru paketi bulunamadi.", "Question source olarak algilanan bir dokuman secin.");
  }

  const question = getTeacherQuestionById(document.questionSet, questionId);
  if (!question) {
    return sendError(res, 404, "QUESTION_NOT_FOUND", "Soru bulunamadi.", "Listeden gecerli bir soru secin.");
  }

  const nextState = upsertTeacherQuestionState(session, document.id, question.id, {
    status: getTeacherQuestionState(session, document.id, question.id).status,
    typeOverride: type,
  });
  saveSession(session);

  return res.json({
    success: true,
    question: {
      id: question.id,
      prompt: question.prompt,
      options: question.options || [],
      type: resolveTeacherQuestionType(question, nextState),
      originalType: question.type || resolveTeacherQuestionType(question, null),
      typeOverride: nextState.typeOverride || "",
      status: nextState.status,
    },
  });
});

app.post("/api/teacher-questions/teach", async (req, res) => {
  try {
    const {
      sessionId,
      documentId = "",
      questionId,
      supportDocumentIds = [],
      language = "tr-TR",
      preset = "auto",
      citationMode = "inline",
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Teacher Questions icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }

    const session = getSession(sessionId);
    const document = getQuestionSourceDocument(session, documentId);
    if (!document) {
      return sendError(res, 404, "QUESTION_SOURCE_NOT_FOUND", "Soru paketi bulunamadi.", "Question source olarak algilanan bir dokuman secin.");
    }

    const rawQuestion = getTeacherQuestionById(document.questionSet, questionId);
    if (!rawQuestion) {
      return sendError(res, 404, "QUESTION_NOT_FOUND", "Soru bulunamadi.", "Listeden gecerli bir soru secin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);
    const questionState = getTeacherQuestionState(session, document.id, rawQuestion.id);
    const question = buildTeacherQuestionView(rawQuestion, questionState);
    const supportDocs = getQuestionSupportDocuments(session, document.id, supportDocumentIds);
    const resolvedContextPack = buildContextPack({
      session,
      documentIds: [document.id, ...supportDocs.map((doc) => doc.id)],
      citationsRequired: safeCitationMode !== "off",
      scopeLabel: `${document.name} • Question ${question.id}`,
      maxChars: supportDocs.length ? 9000 : 5500,
    });

    const explanation = await explainTeacherQuestion({
      runtimeConfig,
      languageCode: safeLanguage,
      preset: safePreset,
      citationMode: safeCitationMode,
      contextPack: resolvedContextPack,
      question,
      supportDocs,
      questionState,
    });

    const previousState = questionState;
    upsertTeacherQuestionState(session, document.id, question.id, {
      status: previousState.status === "solved" ? "solved" : "studying",
      attempts: previousState.attempts,
      correctCount: previousState.correctCount,
      wrongCount: previousState.wrongCount,
      typeOverride: previousState.typeOverride,
    });
    saveSession(session);

    return res.json({
      success: true,
      question: {
        id: question.id,
        prompt: question.prompt,
        type: question.type,
        originalType: question.originalType,
        typeOverride: question.typeOverride,
        options: question.options || [],
      },
      supportSources: supportDocs.map((doc) => ({ id: doc.id, name: doc.name })),
      explanation,
      status: getTeacherQuestionState(session, document.id, question.id).status,
    });
  } catch (err) {
    return sendError(res, 500, "TEACHER_QUESTION_TEACH_FAILED", "Soru anlatimi olusturulamadi.", err.message || "Tekrar deneyin.");
  }
});

app.post("/api/teacher-questions/check", async (req, res) => {
  try {
    const {
      sessionId,
      documentId = "",
      questionId,
      userAnswer = "",
      supportDocumentIds = [],
      language = "tr-TR",
      preset = "auto",
      citationMode = "inline",
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Teacher Questions icin gecerli sessionId gerekli.", "UUID formatinda sessionId kullanin.");
    }
    if (typeof userAnswer !== "string" || !userAnswer.trim()) {
      return sendError(res, 400, "ANSWER_REQUIRED", "Kontrol icin cevap gerekli.", "Ogrenci cevabini girin.");
    }

    const session = getSession(sessionId);
    const document = getQuestionSourceDocument(session, documentId);
    if (!document) {
      return sendError(res, 404, "QUESTION_SOURCE_NOT_FOUND", "Soru paketi bulunamadi.", "Question source olarak algilanan bir dokuman secin.");
    }

    const rawQuestion = getTeacherQuestionById(document.questionSet, questionId);
    if (!rawQuestion) {
      return sendError(res, 404, "QUESTION_NOT_FOUND", "Soru bulunamadi.", "Listeden gecerli bir soru secin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();
    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const safeLanguage = normalizeResponseLanguage(language);
    const safePreset = normalizePromptPreset(preset);
    const safeCitationMode = normalizeCitationMode(citationMode);
    const questionState = getTeacherQuestionState(session, document.id, rawQuestion.id);
    const question = buildTeacherQuestionView(rawQuestion, questionState);
    const supportDocs = getQuestionSupportDocuments(session, document.id, supportDocumentIds);
    const resolvedContextPack = buildContextPack({
      session,
      documentIds: [document.id, ...supportDocs.map((doc) => doc.id)],
      citationsRequired: safeCitationMode !== "off",
      scopeLabel: `${document.name} • Question ${question.id}`,
      maxChars: supportDocs.length ? 9000 : 5500,
    });

    const evaluation = await evaluateTeacherQuestionAnswer({
      runtimeConfig,
      languageCode: safeLanguage,
      preset: safePreset,
      citationMode: safeCitationMode,
      contextPack: resolvedContextPack,
      question,
      userAnswer: userAnswer.trim(),
      supportDocs,
      questionState,
    });

    let storedMistake = null;
    const previousState = questionState;
    const nextState = upsertTeacherQuestionState(session, document.id, question.id, {
      status: evaluation.isCorrect ? "solved" : "wrong",
      attempts: previousState.attempts + 1,
      correctCount: previousState.correctCount + (evaluation.isCorrect ? 1 : 0),
      wrongCount: previousState.wrongCount + (evaluation.isCorrect ? 0 : 1),
      typeOverride: previousState.typeOverride,
    });
    if (!evaluation.isCorrect) {
      [storedMistake] = storeMistakeBookEntries(session, [buildTeacherQuestionMistakeEntry({
        document,
        question,
        evaluation,
        userAnswer: userAnswer.trim(),
        languageCode: safeLanguage,
      })]);
    }
    saveSession(session);

    return res.json({
      success: true,
      evaluation,
      storedMistake,
      status: nextState.status,
    });
  } catch (err) {
    return sendError(res, 500, "TEACHER_QUESTION_CHECK_FAILED", "Soru kontrol edilemedi.", err.message || "Tekrar deneyin.");
  }
});

app.listen(PORT, HOST, () => {
  const localIP = getLocalIP();
  const runtimeConfig = getActiveRuntimeConfig();
  console.log("\n=== OmniTutor v3 Baslatildi ===");
  console.log(`  Yerel:    http://localhost:${PORT}`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    console.log(`  Ag:       http://${localIP}:${PORT}`);
  } else {
    console.log("  Ag:       devre disi (yalnizca localhost)");
  }
  console.log(`  Saglayici: ${PROVIDER_PRESETS[runtimeConfig.provider]?.name || runtimeConfig.provider}`);
  console.log("  Mod:      Strict Source Mode (dokuman-kilitli)");

  if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
    console.log("  UYARI: API anahtari ayarli degil. Arayuzdeki Ayarlar panelini kullanin.\n");
  } else {
    console.log("  API anahtari yapilandirildi.\n");
  }
});
