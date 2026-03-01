// src/services/llm.js
import OpenAI from "openai";
import { safeTruncate, normalizeWhitespace } from "../utils/text.js";
import { loadConfig } from "../config.js";

const cfg = loadConfig();

const DEFAULT_MODEL =
  cfg.LLM_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-5.2"; // ok se lo usi davvero

const DEFAULT_MAX_OUTPUT = Number(
  process.env.LLM_MAX_OUTPUT_TOKENS ||
  process.env.OPENAI_MAX_OUTPUT_TOKENS ||
  900
);

function getOpenAIKey() {
  const k = cfg.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  return String(k || "").trim();
}

function getClient() {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error("Missing LLM_API_KEY (or OPENAI_API_KEY)");
  return new OpenAI({ apiKey });
}

function assertProviderOpenAI() {
  const p = String(cfg.LLM_PROVIDER || "none").toLowerCase();
  if (p !== "openai") {
    throw new Error(`LLM_PROVIDER is '${cfg.LLM_PROVIDER}'. Set LLM_PROVIDER=openai to use OpenAI.`);
  }
}

function isRetryable(err) {
  const msg = String(err?.message || "").toLowerCase();
  const code = err?.status || err?.code;
  if (code === 429) return true;
  if (typeof code === "number" && code >= 500) return true;
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("socket")) return true;
  return false;
}

async function withRetry(fn, { retries = 2, baseDelayMs = 350 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) break;
      const wait = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ✅ Robust: usa Responses API + json_schema, poi JSON.parse(output_text)
export async function llmJSON({
  input,
  system,
  schema,
  model = DEFAULT_MODEL,
  maxOutputTokens = DEFAULT_MAX_OUTPUT,
  metadata,
} = {}) {
  assertProviderOpenAI();
  if (!schema) throw new Error("llmJSON requires 'schema' (JSON Schema)");

  const client = getClient();

  const finalInput = typeof input === "string" ? normalizeWhitespace(input) : String(input ?? "");
  const finalSystem = system ? normalizeWhitespace(system) : "";

  // Responses API accetta input come array di messaggi
  const messages = [];
  if (finalSystem) messages.push({ role: "system", content: finalSystem });
  messages.push({ role: "user", content: finalInput });

  const resp = await withRetry(() =>
  client.responses.create({
    model,
    input: messages,
    max_output_tokens: maxOutputTokens,
    ...(metadata ? { metadata } : {}),
    text: {
      format: {
        type: "json_schema",
        name: "result",
        schema,
        strict: true,
      },
    },
  })
);

  const rawText = String(resp?.output_text || "").trim();

  if (!rawText) {
    const debug = safeTruncate(JSON.stringify(resp, null, 2), 20_000);
    throw new Error(`LLM returned empty output_text. Debug:\n${debug}`);
  }

  try {
    const data = JSON.parse(rawText);
    return { id: resp?.id, model: resp?.model || model, data, rawText, raw: resp };
  } catch {
    const clipped = safeTruncate(rawText, 50_000);
    throw new Error(`Failed to parse JSON from model output. Output was:\n${clipped}`);
  }
}