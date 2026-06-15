import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM_URL =
  process.env.GLM_UPSTREAM_URL ||
  "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";
const DEFAULT_MODEL = process.env.GLM_MODEL || "glm-5.2";
const LOG_DIR = process.env.GLM_SHIM_LOG_DIR || path.resolve("logs");
const LOG_BODIES = process.env.GLM_SHIM_LOG_BODIES === "1";
const THINKING_MODE = process.env.GLM_SHIM_THINKING || "enabled";
const MAX_RETRIES = Number(process.env.GLM_SHIM_MAX_RETRIES || 5);
const RETRY_BASE_MS = Number(process.env.GLM_SHIM_RETRY_BASE_MS || 2000);
const MAX_CONCURRENT = Number(process.env.GLM_SHIM_MAX_CONCURRENT || 3);
const UPSTREAM_TIMEOUT_MS = Number(process.env.GLM_SHIM_UPSTREAM_TIMEOUT_MS || 300000);

let activeUpstreamRequests = 0;
const upstreamQueue = [];

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

export function normalizeModel(model) {
  const raw = String(model || DEFAULT_MODEL).trim();
  if (!raw || raw.startsWith("claude-")) return DEFAULT_MODEL;
  return raw.replace(/\[[^\]]+\]$/i, "");
}

export function anthropicToOpenAI(body) {
  const messages = [];
  const system = normalizeTextContent(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages || []) {
    messages.push(...convertMessage(message));
  }

  const out = {
    model: normalizeModel(body.model),
    messages,
    stream: Boolean(body.stream),
    max_tokens: body.max_tokens || 4096,
  };

  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  const thinking = normalizeThinking(body.thinking, THINKING_MODE);
  if (thinking) out.thinking = thinking;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: sanitizeJsonSchema(tool.input_schema || { type: "object", properties: {} }),
      },
    }));
  }

  if (body.tool_choice) {
    out.tool_choice = convertToolChoice(body.tool_choice);
  }

  return out;
}

export function openAIToAnthropic(json, requestedModel = DEFAULT_MODEL) {
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  const text = message.content || message.reasoning_content || "";
  if (text) content.push({ type: "text", text });

  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name: call.function?.name || call.name || "unknown_tool",
      input: parseToolArguments(call.function?.arguments ?? call.arguments),
    });
  }

  return {
    id: json.id || `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: content.some((block) => block.type === "tool_use")
      ? "tool_use"
      : mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };
}

function convertMessage(message) {
  const role = message.role;
  const content = message.content;

  if (typeof content === "string") {
    return [{ role, content }];
  }

  if (!Array.isArray(content)) {
    return [{ role, content: content == null ? "" : String(content) }];
  }

  if (role === "assistant") {
    const text = [];
    const tool_calls = [];
    for (const block of content) {
      if (block.type === "text") text.push(block.text || "");
      if (block.type === "tool_use") {
        tool_calls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
    return [
      {
        role: "assistant",
        content: text.join(""),
        ...(tool_calls.length ? { tool_calls } : {}),
      },
    ];
  }

  const out = [];
  const text = [];
  for (const block of content) {
    if (block.type === "text") text.push(block.text || "");
    if (block.type === "tool_result") {
      if (text.length) {
        out.push({ role: "user", content: text.splice(0).join("") });
      }
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: normalizeTextContent(block.content),
      });
    }
  }
  if (text.length || out.length === 0) out.push({ role, content: text.join("") });
  return out;
}

function normalizeTextContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return JSON.stringify(part);
      })
      .join("");
  }
  return String(content);
}

function normalizeThinking(thinking, mode) {
  if (mode === "strip") return undefined;
  if (mode === "enabled") return { type: "enabled" };
  if (mode === "disabled") return { type: "disabled" };
  if (thinking === true) return { type: "enabled" };
  if (thinking?.type === "enabled") return { type: "enabled" };
  if (thinking?.type === "disabled") return { type: "disabled" };
  return thinking;
}

function convertToolChoice(choice) {
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    return { type: "function", function: { name: choice.name } };
  }
  return choice;
}

function sanitizeJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);
  if (!schema || typeof schema !== "object") return schema;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return sanitizeJsonSchema(simplifySchemaUnion(schema.anyOf));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return sanitizeJsonSchema(simplifySchemaUnion(schema.oneOf));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return sanitizeJsonSchema(Object.assign({}, ...schema.allOf));
  }

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "$schema" ||
      key === "$defs" ||
      key === "definitions" ||
      key === "default" ||
      key === "examples" ||
      key === "format" ||
      key === "not" ||
      key === "pattern" ||
      key === "patternProperties"
    ) {
      continue;
    }
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    out[key] = sanitizeJsonSchema(value);
  }
  return out;
}

function simplifySchemaUnion(items) {
  const branches = items.filter((item) => item && typeof item === "object");
  const nonNull = branches.filter((item) => item.type !== "null");
  const constValues = nonNull
    .filter((item) => Object.prototype.hasOwnProperty.call(item, "const"))
    .map((item) => item.const);
  if (constValues.length === nonNull.length && constValues.length > 0) {
    return { enum: constValues };
  }
  const enumValues = nonNull.flatMap((item) => (Array.isArray(item.enum) ? item.enum : []));
  if (enumValues.length > 0 && nonNull.every((item) => Array.isArray(item.enum))) {
    return { enum: enumValues };
  }
  return nonNull[0] || branches[0] || {};
}

function parseToolArguments(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: String(value) };
  }
}

function mapFinishReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop" || !reason) return "end_turn";
  return "end_turn";
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleMessages(req, res) {
  const requestId = randomUUID();
  const body = JSON.parse(await readBody(req));
  const upstreamBody = anthropicToOpenAI(body);
  const apiKey = extractApiKey(req);

  await logJson(requestId, "request", {
    path: req.url,
    model: body.model,
    upstreamModel: upstreamBody.model,
    stream: upstreamBody.stream,
    toolCount: upstreamBody.tools?.length || 0,
    body: LOG_BODIES ? redact(body) : undefined,
    upstreamBody: LOG_BODIES ? redact(upstreamBody) : undefined,
  });

  const releaseSlot = await acquireUpstreamSlot();
  try {
    const upstreamResult = await fetchUpstreamWithRetry(requestId, apiKey, upstreamBody);
    const upstream = upstreamResult.response;

    try {
      if (!upstream.ok) {
        const text = await upstream.text();
        await logJson(requestId, "upstream-error", {
          status: upstream.status,
          body: text.slice(0, 4000),
        });
        res.writeHead(upstream.status, JSON_HEADERS);
        res.end(JSON.stringify({ type: "error", error: { message: text } }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        await streamOpenAIAsAnthropic(upstream, res, body.model || upstreamBody.model, requestId);
        return;
      }

      const json = await upstream.json();
      await logJson(requestId, "response", {
        upstreamFinish: json.choices?.[0]?.finish_reason,
        usage: json.usage,
        body: LOG_BODIES ? redact(json) : undefined,
      });
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(openAIToAnthropic(json, body.model || upstreamBody.model)));
    } finally {
      upstreamResult.cleanup();
    }
  } finally {
    releaseSlot();
  }
}

async function fetchUpstreamWithRetry(requestId, apiKey, upstreamBody) {
  const body = JSON.stringify(upstreamBody);
  let lastResponse = null;
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const waitMs = retryDelayMs(attempt, lastResponse);
      await logJson(requestId, "upstream-retry", {
        attempt,
        waitMs,
        status: lastResponse?.status,
        error: lastError?.message,
      });
      await sleep(waitMs);
    }

    let timeout = null;
    try {
      timeout = createUpstreamTimeout();
      const response = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: timeout.signal,
      });
      if (!isRetryableUpstreamStatus(response.status) || attempt === MAX_RETRIES) {
        return { response, cleanup: timeout.cleanup };
      }
      lastResponse = response;
      await response.text().catch(() => "");
      timeout.cleanup();
    } catch (error) {
      timeout?.cleanup();
      lastError = error;
      if (attempt === MAX_RETRIES) throw error;
    }
  }
  throw lastError || new Error("Upstream request failed without a response");
}

function createUpstreamTimeout() {
  if (!Number.isFinite(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS} ms`));
  }, UPSTREAM_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

export function isRetryableUpstreamStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(attempt, response) {
  const retryAfter = parseRetryAfterMs(response?.headers?.get?.("retry-after"));
  if (retryAfter != null) return retryAfter;
  const exponential = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(500, RETRY_BASE_MS));
  return exponential + jitter;
}

export function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function acquireUpstreamSlot() {
  if (!Number.isFinite(MAX_CONCURRENT) || MAX_CONCURRENT <= 0) return () => {};
  if (activeUpstreamRequests >= MAX_CONCURRENT) {
    await new Promise((resolve) => upstreamQueue.push(resolve));
  }
  activeUpstreamRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUpstreamRequests = Math.max(0, activeUpstreamRequests - 1);
    const next = upstreamQueue.shift();
    if (next) next();
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamOpenAIAsAnthropic(upstream, res, requestedModel, requestId) {
  const decoder = new TextDecoder();
  let buffer = "";
  let textIndex = null;
  let toolIndexBase = 0;
  const toolBlocks = new Map();
  let sawTool = false;
  let finalUsage = {};

  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        await logJson(requestId, "bad-sse-json", { data: data.slice(0, 1000) });
        continue;
      }
      finalUsage = json.usage || finalUsage;
      const delta = json.choices?.[0]?.delta || {};

      if (delta.content) {
        if (textIndex == null) {
          textIndex = 0;
          toolIndexBase = 1;
          sse(res, "content_block_start", {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          });
        }
        sse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const call of delta.tool_calls || []) {
        sawTool = true;
        const key = call.index ?? toolBlocks.size;
        let block = toolBlocks.get(key);
        if (!block && (call.id || call.function?.name)) {
          block = {
            index: toolIndexBase + toolBlocks.size,
            id: call.id || `toolu_${randomUUID().replaceAll("-", "")}`,
            name: call.function?.name || "unknown_tool",
          };
          toolBlocks.set(key, block);
          sse(res, "content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            },
          });
        }
        if (block && call.function?.arguments) {
          sse(res, "content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: {
              type: "input_json_delta",
              partial_json: call.function.arguments,
            },
          });
        }
      }
    }
  }

  if (textIndex != null) {
    sse(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
  }
  for (const block of toolBlocks.values()) {
    sse(res, "content_block_stop", { type: "content_block_stop", index: block.index });
  }

  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: sawTool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: {
      input_tokens: finalUsage.prompt_tokens || 0,
      output_tokens: finalUsage.completion_tokens || 0,
    },
  });
  sse(res, "message_stop", { type: "message_stop" });
  await logJson(requestId, "stream-finished", { sawTool, usage: finalUsage });
  res.end();
}

function extractApiKey(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const anthropicKey = req.headers["x-api-key"];
  if (anthropicKey) return String(anthropicKey);
  const envKey = process.env.GLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (envKey) return envKey;
  throw Object.assign(new Error("Missing API key"), { statusCode: 401 });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 50 * 1024 * 1024) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data || "{}"));
    req.on("error", reject);
  });
}

async function logJson(requestId, kind, data) {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(
    path.join(LOG_DIR, `${Date.now()}-${requestId}-${kind}.json`),
    `${JSON.stringify(redact(data), null, 2)}\n`,
  );
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|api[-_]?key|authorization|auth/i.test(key) ? "***redacted***" : redact(item),
      ]),
    );
  }
  if (typeof value === "string" && /sk-[A-Za-z0-9_-]{12,}/.test(value)) {
    return value.replace(/sk-[A-Za-z0-9_-]{12,}/g, "***redacted***");
  }
  return value;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        res.writeHead(204, JSON_HEADERS);
        res.end();
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_URL, model: DEFAULT_MODEL }));
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/v1/messages")) {
        await handleMessages(req, res);
        return;
      }
      await logJson(randomUUID(), "not-found", { method: req.method, url: req.url });
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      sendError(res, error);
    }
  });
}

function sendError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  const payload = {
    type: "error",
    error: { message: error.message || "Internal error" },
  };
  if (res.headersSent) {
    try {
      sse(res, "error", payload);
    } catch {
      // The client may have already disconnected.
    }
    res.end();
    return;
  }
  res.writeHead(error.statusCode || 500, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, "127.0.0.1", () => {
    console.error(`GLM Anthropic shim listening on http://127.0.0.1:${PORT}/anthropic`);
    console.error(`Forwarding to ${UPSTREAM_URL} with default model ${DEFAULT_MODEL}`);
  });
}
