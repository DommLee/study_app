const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "..", "prompts");
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

const PROVIDER_RULES = {
  ollama: {
    name: "ollama-local",
    system: [
      "Provider profile: local or self-hosted model.",
      "Prefer a fuller reasoning scaffold, explicit transitions, and teacher-like depth.",
      "When JSON is required, still stay strict, but use defensive self-checking before finalizing the answer.",
    ].join("\n"),
    multipliers: { input: 1.25, output: 1.2 },
  },
  gemini: {
    name: "cloud-fast",
    system: [
      "Provider profile: fast cloud model.",
      "Be concise, token-efficient, and schema-first.",
      "Avoid redundant prose before the answer.",
    ].join("\n"),
    multipliers: { input: 0.9, output: 0.9 },
  },
  groq: {
    name: "cloud-fast",
    system: [
      "Provider profile: low-latency cloud model.",
      "Keep instructions crisp, structured, and token-efficient.",
      "When JSON is requested, output only the schema payload.",
    ].join("\n"),
    multipliers: { input: 0.85, output: 0.85 },
  },
  deepseek: {
    name: "cloud-balanced",
    system: [
      "Provider profile: cloud reasoning model.",
      "Prefer compact structure and avoid decorative text.",
      "Stay grounded to the provided sources.",
    ].join("\n"),
    multipliers: { input: 0.95, output: 1.0 },
  },
  openai: {
    name: "cloud-balanced",
    system: [
      "Provider profile: cloud chat model.",
      "Be clear, structured, and schema-first when needed.",
      "Do not waste tokens on prefatory remarks.",
    ].join("\n"),
    multipliers: { input: 1.0, output: 1.0 },
  },
  custom: {
    name: "openai-compatible",
    system: [
      "Provider profile: custom OpenAI-compatible model.",
      "Use conservative prompt wording and robust output formatting.",
    ].join("\n"),
    multipliers: { input: 1.0, output: 1.0 },
  },
};

const PRESET_RULES = {
  auto: {
    system: "Preset: Auto. Balance speed and depth according to the provider profile.",
    inputMultiplier: 1.0,
    outputMultiplier: 1.0,
  },
  deep: {
    system: [
      "Preset: Deep.",
      "Give a complete, teacher-like explanation with connective logic, exam framing, and compact sectioning.",
    ].join("\n"),
    inputMultiplier: 1.15,
    outputMultiplier: 1.25,
  },
  balanced: {
    system: [
      "Preset: Balanced.",
      "Stay concise but do not skip reasoning steps needed for understanding.",
    ].join("\n"),
    inputMultiplier: 1.0,
    outputMultiplier: 1.0,
  },
  fast: {
    system: [
      "Preset: Fast.",
      "Prioritize fast response, short structure, and only the most useful details.",
    ].join("\n"),
    inputMultiplier: 0.8,
    outputMultiplier: 0.8,
  },
};

const TASK_BUDGETS = {
  chat: { input: 14000, output: 1800, temperature: 0.15 },
  explain: { input: 14000, output: 2200, temperature: 0.15 },
  quiz: { input: 16000, output: 6000, temperature: 0.1 },
  flashcards: { input: 16000, output: 4200, temperature: 0.1 },
  audio: { input: 14000, output: 2400, temperature: 0.2 },
  "mind-map": { input: 12000, output: 1800, temperature: 0.1 },
};

function loadRegistry() {
  const registry = {};
  if (!fs.existsSync(PROMPTS_DIR)) return registry;

  for (const entry of fs.readdirSync(PROMPTS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = path.join(PROMPTS_DIR, entry);
    const task = entry.replace(/-template\.json$/i, "").replace(/\.json$/i, "");
    try {
      registry[task] = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch (error) {
      console.error(`Prompt template load error for ${entry}:`, error.message);
    }
  }
  return registry;
}

const PROMPT_REGISTRY = loadRegistry();

function normalizeLanguage(languageCode = "tr-TR") {
  return RESPONSE_LANGUAGE_LABELS[languageCode] ? languageCode : "tr-TR";
}

function getLanguageInstruction(languageCode = "tr-TR") {
  const safeLanguage = normalizeLanguage(languageCode);
  const label = RESPONSE_LANGUAGE_LABELS[safeLanguage];
  if (safeLanguage === "tr-TR") {
    return [
      "Primary output language must be Turkish.",
      "For important academic terms, add short English equivalents in parentheses.",
    ].join("\n");
  }

  return [
    `Primary output language must be ${label}.`,
    "Do not mix in Turkish unless the user explicitly asks for bilingual output.",
    "Keep source terms in original wording when useful, but explain in the chosen output language.",
  ].join("\n");
}

function resolvePreset(provider, preset = "auto") {
  if (preset && PRESET_RULES[preset]) return preset;
  if (provider === "ollama") return "deep";
  if (provider === "groq" || provider === "gemini") return "fast";
  return "balanced";
}

function getTaskTemplate(task) {
  return PROMPT_REGISTRY[task] || PROMPT_REGISTRY.chat || {};
}

function getProviderRule(provider) {
  return PROVIDER_RULES[provider] || PROVIDER_RULES.custom;
}

function getTaskBudgets(task, provider, preset = "auto", overrides = {}) {
  const base = TASK_BUDGETS[task] || TASK_BUDGETS.chat;
  const providerRule = getProviderRule(provider);
  const resolvedPreset = resolvePreset(provider, preset);
  const presetRule = PRESET_RULES[resolvedPreset] || PRESET_RULES.auto;

  const inputMultiplier = (providerRule.multipliers?.input || 1) * (presetRule.inputMultiplier || 1);
  const outputMultiplier = (providerRule.multipliers?.output || 1) * (presetRule.outputMultiplier || 1);

  return {
    maxInputChars: Math.round((overrides.maxInputChars || base.input) * inputMultiplier),
    maxOutputTokens: Math.round((overrides.maxOutputTokens || base.output) * outputMultiplier),
    temperature: overrides.temperature ?? base.temperature ?? 0.15,
    preset: resolvedPreset,
  };
}

function buildContextLayer(contextPack = {}) {
  const lines = [];
  const sources = Array.isArray(contextPack.sources) ? contextPack.sources : [];
  const citationsRequired = contextPack.citationsRequired !== false;

  lines.push("Grounding rules:");
  lines.push("- Use only the provided source pack.");
  lines.push("- If a detail is missing from the sources, say so clearly.");
  lines.push("- Connect related source fragments into a coherent lesson instead of listing raw snippets.");
  if (citationsRequired) {
    lines.push("- Cite claims inline using the provided source labels, for example [Page 4] or [Slide 7].");
  }

  if (contextPack.scopeLabel) lines.push(`- Active source scope: ${contextPack.scopeLabel}`);
  if (contextPack.selectedPagesSummary) lines.push(`- Selected pages/slides: ${contextPack.selectedPagesSummary}`);
  if (contextPack.relatedPagesSummary) lines.push(`- Also consider related pages/slides: ${contextPack.relatedPagesSummary}`);
  if (sources.length) lines.push(`- Source pack contains ${sources.length} source chunk(s).`);

  return lines.join("\n");
}

function buildTeachingModeLayer(teachingMode = "deep") {
  const map = {
    deep: "Teaching mode: Deep Learn. Prefer a complete concept-first explanation.",
    rapid: "Teaching mode: Rapid Review. Prefer compressed but still accurate teaching.",
    drill: "Teaching mode: Exam Drill. Prefer exam-style framing, model answers, and traps.",
    viva: "Teaching mode: Oral Viva. Prefer short teaching blocks followed by probing follow-up questions.",
    paper: "Teaching mode: Past Paper. Frame the answer around likely written-exam structure and scoring logic.",
  };
  return map[teachingMode] || map.deep;
}

function adaptPrompt({
  task = "chat",
  provider = "custom",
  model = "",
  preset = "auto",
  language = "tr-TR",
  teachingMode = "deep",
  contextPack = {},
  userPrompt = "",
  extraInstructions = "",
  schemaHint = "",
  overrides = {},
}) {
  const template = getTaskTemplate(task);
  const providerRule = getProviderRule(provider);
  const resolvedPreset = resolvePreset(provider, preset);
  const budgets = getTaskBudgets(task, provider, resolvedPreset, overrides);

  const systemInstruction = [
    template.base || "",
    buildContextLayer(contextPack),
    getLanguageInstruction(language),
    buildTeachingModeLayer(teachingMode),
    providerRule.system || "",
    PRESET_RULES[resolvedPreset]?.system || "",
    template.provider?.[provider] || template.provider?.[providerRule.name] || template.provider?.default || "",
    schemaHint ? `Output schema rule:\n${schemaHint}` : "",
    extraInstructions || "",
  ].filter(Boolean).join("\n\n");

  const userInstruction = [
    template.user || "",
    contextPack.contextText ? `SOURCE PACK:\n${contextPack.contextText}` : "",
    userPrompt ? `USER TASK:\n${userPrompt}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    systemInstruction,
    userPrompt: userInstruction,
    budgets,
    meta: {
      task,
      provider,
      model,
      preset: resolvedPreset,
      sourceCount: Array.isArray(contextPack.sources) ? contextPack.sources.length : 0,
    },
  };
}

module.exports = {
  adaptPrompt,
  getTaskBudgets,
  resolvePreset,
  normalizeLanguage,
};
