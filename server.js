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
  "de-DE": "German",
  "fr-FR": "French",
  "ar-SA": "Arabic",
  "es-ES": "Spanish",
};

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
    ];
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowedExts = new Set([".pdf", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".ppt", ".pptx"]);
    if (allowed.includes(file.mimetype) || allowedExts.has(ext)) cb(null, true);
    else cb(new Error("Desteklenmeyen dosya tipi. PDF, TXT, MD, PNG, JPG, WEBP veya PPTX kullanin."));
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
      err.message || "PDF, TXT, MD, PNG, JPG, WEBP veya PPTX kullanin."
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
  }));

  return safe;
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
  if (mimetype === "application/pdf") {
    const pdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return (data.text || "").trim();
  }
  if (mimetype.startsWith("text/")) {
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

async function analyzeUploadedFile(filePath, mimetype, runtimeConfig, originalName = "", options = {}) {
  const ext = path.extname(originalName || filePath || "").toLowerCase();
  const isPdf = mimetype === "application/pdf" || ext === ".pdf";
  const isText = mimetype.startsWith("text/") || ext === ".txt" || ext === ".md";
  const isPpt = PPT_MIMES.has(mimetype) || ext === ".pptx" || ext === ".ppt";
  const normalizedMime = isPdf
    ? "application/pdf"
    : (isText ? "text/plain" : mimetype);

  if (isPdf || isText) {
    const text = await extractText(filePath, normalizedMime);
    if (!text) {
      return {
        indexed: false,
        text: "",
        reason: "NO_TEXT_EXTRACTED",
        hint: "Dosyadan metin cikarilamadi. Taranmis PDF ise metin iceren bir kopya yukleyin.",
      };
    }
    return { indexed: true, text, reason: "TEXT_EXTRACTED", hint: "" };
  }

  if (IMAGE_MIMES.has(mimetype)) {
    return extractImageTextWithGemini(filePath, mimetype, runtimeConfig);
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

async function sendChatMessage(sessionHistory, userMessage, docContext, runtimeConfig, responseLanguage = "tr-TR", mode = "deep") {
  const maxOutputTokens = getChatOutputTokens(mode);
  const systemInstruction = `${CHAT_SYSTEM_PROMPT}\n${buildTeacherStylePrompt(responseLanguage)}\n${buildChatModePrompt(mode)}\n${docContext}`;
  const messages = [
    ...buildRecentHistory(sessionHistory),
    { role: "user", content: userMessage },
  ];

  if (runtimeConfig.provider === "gemini") {
    return chatWithGemini(messages, systemInstruction, runtimeConfig, {
      maxOutputTokens,
      temperature: 0.15,
    });
  }
  return chatWithOpenAICompatible(messages, systemInstruction, runtimeConfig, {
    maxTokens: maxOutputTokens,
    temperature: 0.15,
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

  const normalizedType = requestedType === "classic"
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

async function repairStructuredJson(raw, key, runtimeConfig, languageCode = "tr-TR") {
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
    systemInstruction: `${SYSTEM_PROMPT}\n${buildTeacherStylePrompt(languageCode)}`,
  });
  return extractJsonObject(repaired);
}

async function generateQuizBatch({ runtimeConfig, languageCode, prompt, batchCount, type }) {
  const raw = await callAI(prompt, runtimeConfig, {
    maxOutputTokens: getQuizOutputTokens(batchCount, type),
    temperature: 0.1,
    systemInstruction: `${SYSTEM_PROMPT}\n${buildTeacherStylePrompt(languageCode)}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.questions) || !parsed.questions.length) {
    parsed = await repairStructuredJson(raw, "questions", runtimeConfig, languageCode);
  }

  return Array.isArray(parsed?.questions) ? parsed.questions : [];
}

async function generateFlashcardBatch({ runtimeConfig, languageCode, prompt, batchCount }) {
  const raw = await callAI(prompt, runtimeConfig, {
    maxOutputTokens: getFlashcardOutputTokens(batchCount),
    temperature: 0.1,
    systemInstruction: `${SYSTEM_PROMPT}\n${buildTeacherStylePrompt(languageCode)}`,
  });

  let parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) {
    parsed = await repairStructuredJson(raw, "cards", runtimeConfig, languageCode);
  }

  return Array.isArray(parsed?.cards) ? parsed.cards : [];
}

app.post("/api/session", (req, res) => {
  const sessionId = uuidv4();
  const session = getSession(sessionId);
  const { name } = req.body || {};
  if (typeof name === "string" && name.trim()) session.name = name.trim();
  session.createdAt = Date.now();
  saveSession(session);
  res.json({ success: true, sessionId, name: session.name || null });
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
      return sendError(res, 400, "FILE_REQUIRED", "Dosya yuklenmedi.", "PDF, TXT, MD, PNG, JPG, WEBP veya PPTX yukleyin.");
    }

    tempPath = file.path;
    const session = getSession(sessionId);
    const runtimeConfig = getActiveRuntimeConfig();
    documentId = uuidv4();
    const analysis = await analyzeUploadedFile(file.path, file.mimetype, runtimeConfig, file.originalname, {
      sessionId,
      documentId,
    });

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
    const { sessionId, message, language = "tr-TR", mode = "deep" } = req.body || {};

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
    const groundedUserMessage = buildTutorUserMessage(userMessage, indexedDocs);
    const docContext = buildDocumentContext(indexedDocs, userMessage);
    const safeMode = ["deep", "rapid", "drill", "viva", "paper"].includes(mode) ? mode : "deep";
    const response = await sendChatMessage(session.history, groundedUserMessage, docContext, runtimeConfig, language, safeMode);

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

app.post("/api/quiz", async (req, res) => {
  try {
    const {
      sessionId,
      type = "multiple",
      count = 5,
      difficulty = "medium",
      topic = "",
      documentId = "",
      language = "tr-TR",
    } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Quiz olusturmak icin gecerli sessionId gerekli.", "Yeni bir oturum olusturup tekrar deneyin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const session = getSession(sessionId);
    const indexedDocs = getSelectedIndexedDocuments(session, documentId);
    const safeLanguage = normalizeResponseLanguage(language);
    const requestedCount = Math.max(1, Math.min(30, Number(count) || 5));
    const safeType = ["multiple", "classic", "truefalse"].includes(type) ? type : "multiple";
    const safeDifficulty = ["easy", "medium", "hard"].includes(difficulty) ? difficulty : "medium";

    if (indexedDocs.length === 0) {
      return sendError(
        res,
        documentId ? 404 : 400,
        documentId ? "DOCUMENT_NOT_FOUND" : "NO_INDEXED_DOCUMENT",
        documentId ? "Secilen dokuman quiz icin hazir degil." : "Quiz uretmek icin en az bir analiz edilmis dokuman gerekli.",
        documentId ? "Listeden indexed durumda bir dokuman secin." : "Dokuman yukleyip analiz durumu indexed olan bir kaynak olusturun."
      );
    }

    let contentContext = "Asagidaki belgeler tek kaynak olacak sekilde kullan. Belge sirasini ve konu akisini koru:\n";
    for (const doc of indexedDocs) {
      contentContext += `\n[${doc.name}]\n${sanitizeDocumentTextForAI(doc.text || "", 2600)}\n`;
    }
    const topicCatalog = buildTopicCatalog(indexedDocs, 18);

    const focusLine = topic && topic.trim()
      ? `\nOdak konusu: ${topic.trim()} (Yalnizca belgede gecen bolumlerden soru uret)\n`
      : "\nOdak konusu verilmedi. Belgelerdeki onemli bolumlerden soru uret.\n";

    const difficultyMap = { easy: "kolay", medium: "orta", hard: "zor" };
    const diffTR = difficultyMap[difficulty] || "orta";
    const typeMap = {
      multiple: "coktan secmeli (A, B, C, D sikli)",
      classic: "acik uclu (kisa cevap)",
      truefalse: "dogru/yanlis",
    };
    const typeTR = typeMap[safeType] || "coktan secmeli";
    const batchSize = safeType === "classic" ? 4 : 6;
    const questions = [];

    for (let offset = 0; offset < requestedCount; offset += batchSize) {
      const batchCount = Math.min(batchSize, requestedCount - offset);
      const prompt = [
        buildGenerationLanguageRules(safeLanguage),
        "",
        `Sen bir sinav hazirlayan egitim uzmansin.`,
        `Sadece asagidaki belgelere dayanarak ${batchCount} adet ${diffTR} zorlukta ${typeTR} soru hazirla.`,
        "Once belge icerigini oku; tanimlar, iliskiler, ornekler, neden-sonuc zinciri ve uygulama noktalarini tespit et.",
        "Sorular salt kopya olmasin; belge icindeki bilgiye sadik kalarak olcu ve yorum gucu de eklenebilsin.",
        "Belgede acikca olan bilgiyi temel al, ama mantikli bag kurarak soru kalitesini yukseltebilirsin.",
        topicCatalog.length ? `Belgedeki ana konu havuzu: ${topicCatalog.join(" | ")}` : "",
        focusLine.trim(),
        "",
        contentContext,
        "",
        "Kurallar:",
        "- Belge disi bilgi uretme.",
        "- Sorulari belge sirasina gore ilerlet: once erken bolumler, sonra sonraki bolumler.",
        "- Batch icinde onceki sorulari tekrar etme; yeni aci yakala.",
        "- Classic exam mantigi kur: neden-sonuc, kavram iliskisi, yorum ve uygulama sorularina agirlik ver.",
        "- Her explanation alaninda neden dogru oldugunu ve gerekiyorsa neden diger seceneklerin zayif oldugunu kisa ama net acikla.",
        "- Bilgi yetersizse en yakin belge iceriginden guvenli soru uret; bos donme.",
        "- Cikti YALNIZCA <json>...</json> blogu icinde gecerli JSON olsun.",
        "- <json> disinda tek kelime bile yazma.",
        safeType === "multiple"
          ? "- Multiple choice ise 4 secenek ver. answer alani dogru secenegin TAM METNI olsun; sadece harf yazma."
          : safeType === "truefalse"
            ? "- True/false ise options alani [\"True\",\"False\"] olsun ve answer yalnizca \"True\" veya \"False\" olsun."
            : "- Classic soruda options bos dizi olabilir; answer alani model cevap ozeti olmali.",
        "",
        "<json>",
        "{",
        '  "questions": [',
        "    {",
        '      "id": 1,',
        '      "question": "Question text",',
        `      "type": "${safeType}",`,
        safeType === "classic"
          ? '      "options": [],'
          : safeType === "truefalse"
            ? '      "options": ["True", "False"],'
            : '      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],',
        safeType === "multiple"
          ? '      "answer": "A) Correct full option text",'
          : safeType === "truefalse"
            ? '      "answer": "True",'
            : '      "answer": "Model answer",',
        '      "explanation": "Short but useful explanation"',
        "    }",
        "  ]",
        "}",
        "</json>",
      ].filter(Boolean).join("\n");

      const batchQuestions = await generateQuizBatch({
        runtimeConfig,
        languageCode: safeLanguage,
        prompt,
        batchCount,
        type: safeType,
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
    const { sessionId, count = 10, topic = "", documentId = "", language = "tr-TR" } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return sendError(res, 400, "INVALID_SESSION_ID", "Flashcard icin gecerli sessionId gerekli.", "Yeni bir oturum olusturup tekrar deneyin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const session = getSession(sessionId);
    const indexedDocs = getSelectedIndexedDocuments(session, documentId);
    const safeLanguage = normalizeResponseLanguage(language);
    const requestedCount = Math.max(1, Math.min(50, Number(count) || 10));

    if (indexedDocs.length === 0) {
      return sendError(
        res,
        documentId ? 404 : 400,
        documentId ? "DOCUMENT_NOT_FOUND" : "NO_INDEXED_DOCUMENT",
        documentId ? "Secilen dokuman flashcard icin hazir degil." : "Flashcard uretmek icin en az bir analiz edilmis dokuman gerekli.",
        documentId ? "Listeden indexed durumda bir dokuman secin." : "PDF/TXT/MD yukleyin veya gorsel icin uyumlu model secin."
      );
    }

    let contentContext = "Asagidaki belgeler tek kaynak olacak sekilde kullan. Belge sirasini ve konu akisini koru:\n";
    for (const doc of indexedDocs) {
      contentContext += `\n[${doc.name}]\n${sanitizeDocumentTextForAI(doc.text || "", 3000)}\n`;
    }
    const topicCatalog = buildTopicCatalog(indexedDocs, 18);

    const focusLine = topic && topic.trim()
      ? `\nOdak konusu: ${topic.trim()} (yalnizca belge icerigine dayan)\n`
      : "\nOdak konusu verilmedi; belgelerdeki ana kavramlardan sec.\n";

    const batchSize = 10;
    const cards = [];

    for (let offset = 0; offset < requestedCount; offset += batchSize) {
      const batchCount = Math.min(batchSize, requestedCount - offset);
      const prompt = [
        buildGenerationLanguageRules(safeLanguage),
        "",
        "Sen bir egitim uzmansin.",
        `Sadece verilen belgelerden ${batchCount} adet flashcard olustur.`,
        "Once belgeyi oku; ana kavramlari, tanimlari, karsilastirmalari ve kritik ayrintilari tespit et.",
        "Kartlar sadece metni kopyalamasin; belgeye sadik kalarak anlasilir ve sinavda ise yarar hale getir.",
        topicCatalog.length ? `Belgedeki ana konu havuzu: ${topicCatalog.join(" | ")}` : "",
        focusLine.trim(),
        "",
        contentContext,
        "",
        "Kurallar:",
        "- Dis bilgi kullanma.",
        "- Kartlari belge akisina gore sirala; ilk bolumler once gelsin.",
        "- Back alaninda kavramin mantigini, kritik ayrintisini ve hatirlatici bir vurgu ver.",
        "- Gereksiz uzun yazma ama eksik de birakma.",
        "- Cikti YALNIZCA <json>...</json> blogu icinde gecerli JSON olsun.",
        "- <json> disinda hicbir aciklama yazma.",
        "",
        "<json>",
        "{",
        '  "cards": [',
        "    {",
        '      "id": 1,',
        '      "front": "Front of card",',
        '      "back": "Back of card",',
        '      "category": "topic category"',
        "    }",
        "  ]",
        "}",
        "</json>",
      ].filter(Boolean).join("\n");

      const batchCards = await generateFlashcardBatch({
        runtimeConfig,
        languageCode: safeLanguage,
        prompt,
        batchCount,
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
    return res.json({ success: true, cards: dedupedCards });
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
      language = "tr-TR",
      teachingMode = "deep",
    } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return sendError(res, 400, "TEXT_REQUIRED", "text zorunlu.", "Aciklama icin metin gonderin.");
    }

    const runtimeConfig = getActiveRuntimeConfig();

    if (providerNeedsKey(runtimeConfig) && !hasConfiguredKey(runtimeConfig)) {
      return sendError(res, 400, "MISSING_API_KEY", "API anahtari ayarlanmamis.", "Ayarlar panelinden API key ekleyin.");
    }

    const safeQuestion = typeof question === "string" ? question.trim() : "";
    const safeTeachingMode = ["deep", "rapid", "drill", "viva", "paper"].includes(teachingMode) ? teachingMode : "deep";
    const safePageNumber = Number.isFinite(Number(pageNumber)) ? Number(pageNumber) : null;
    const safeTotalPages = Number.isFinite(Number(totalPages)) ? Number(totalPages) : null;
    const pageLabel = safePageNumber && safeTotalPages
      ? `PDF sayfasi ${safePageNumber}/${safeTotalPages}`
      : (safePageNumber ? `PDF sayfasi ${safePageNumber}` : "Mevcut PDF sayfasi");

    const commonRules = [
      "Yalnizca verilen sayfa metnini kullan. Belge disi bilgi, web search veya varsayim kullanma.",
      "Metindeki sira nasil ilerliyorsa aciklamayi da ayni sira ile kur.",
      language === "tr-TR"
        ? "Ana akademik terimlerde Turkce anlatimdan hemen sonra kisa English equivalent ver."
        : `Yaniti esas olarak ${getResponseLanguageLabel(language)} ver. Gerektiginde kaynak terimleri aynen koru.`,
      "Anlatim sinav odakli, detayli, mantik merkezli ve eksik nokta birakmayacak kadar kapsayici olsun.",
      "Metinde olmayan ayrinti icin acikca 'Bu sayfada bu ayrinti yok.' de.",
      "Her onemli iddiayi dogrudan sayfadaki ifadeye bagla; zorunlu olmadikca yorum veya ima uretme.",
      "URL, isim, kurum veya kisaltma geciyorsa sadece 'metinde gecen bir URL/isim/kisaltma' oldugunu soyle; amacini, gecmisini, hukuk durumunu veya ne oldugunu metin aciklamiyorsa tahmin etme.",
      "Ozellikle URL ve domain adlarina bakip 'site', 'yayinci', 'dagitim kanali', 'kitap kaynagi' gibi roller atama; kaynak bunu acik secik demiyorsa sadece var oldugunu belirt.",
      "Temiz ve sade markdown kullan. Gereksiz #### veya ** kalabaligi yapma.",
      "Tablo gerekiyorsa gecerli markdown tablo formati kullan; tablo gerekmiyorsa duz madde listesi tercih et.",
    ].join("\n- ");

    const questionBlock = safeQuestion
      ? `\nKULLANICI EK SORUSU:\n${safeQuestion}\n\nBu soruya once dogrudan cevap ver. Eger sayfa metni yetmiyorsa acikca belirt.\n`
      : "";

    const modePrompts = {
      explain: [
        `Sen bir ozel ders hocasisin. ${pageLabel} icin kapsamli ama duzenli bir ders notu uret.`,
        "Su formatla ilerle:",
        "1. Akademik Aciklama",
        "2. Sirali Kavramlar ve TR/EN Karsiliklari",
        "3. Mantik ve Neden-Sonuc Iliskisi",
        "4. Feynman Tarzi Basitlestirme",
        "5. Sinavda Kacirilabilecek Kritik Noktalar",
        "6. 1 adet klasik sinav sorusu",
      ].join("\n"),
      summarize: [
        `${pageLabel} icin kisa ama eksik birakmayan bir ozet hazirla.`,
        "Su formatla ilerle:",
        "1. Iki-uc cumlelik genel ozet",
        "2. Metin sirasina gore ana fikirler",
        "3. En kritik 5 terim ve English equivalent",
        "4. Sinav icin son tekrar notu",
      ].join("\n"),
      keypoints: [
        `${pageLabel} icin metin sirasina gore anahtar noktalar cikar.`,
        "Her maddede su yapida yaz:",
        "- Nokta",
        "- Neden onemli",
        "- Sinav tuzagi / karistirilabilecek kisim",
      ].join("\n"),
      feynman: [
        `${pageLabel} icin konuyu once cok basit, sonra biraz daha sistemli anlat.`,
        "Su formatla ilerle:",
        "1. Bes yasindaki birine anlatir gibi cok basit aciklama",
        "2. Gozde canlanacak bir benzetme",
        "3. Sonra ayni fikrin universite seviyesinde toparlanisi",
        "4. En onemli terimler ve English equivalent",
      ].join("\n"),
    };

    const prompt = [
      buildTeacherStylePrompt(language),
      "",
      `KURALLAR:\n- ${commonRules}`,
      "",
      `OGRETIM MODU:\n${buildChatModePrompt(safeTeachingMode)}`,
      questionBlock,
      `GOREV:\n${modePrompts[mode] || modePrompts.explain}`,
      "",
      "Ek kurallar:",
      "- Markdown kullanabilirsin ama gereksiz uzun giris yapma.",
      "- Cevabi dogrudan ders anlatimi olarak baslat.",
      "- Belge sirasini bozma; sayfadaki akisi koru.",
      "",
      `KAYNAK METIN (${pageLabel}):\n${text}`,
    ].join("\n");

    const response = await callAI(prompt, runtimeConfig, {
      maxOutputTokens: EXPLAIN_MAX_OUTPUT_TOKENS,
      temperature: 0.15,
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
    })),
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
