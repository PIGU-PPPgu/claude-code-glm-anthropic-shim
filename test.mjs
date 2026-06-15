import assert from "node:assert/strict";
import {
  anthropicToOpenAI,
  isRetryableUpstreamStatus,
  normalizeModel,
  openAIToAnthropic,
  parseRetryAfterMs,
} from "./server.mjs";

assert.equal(normalizeModel("glm-5.1[1M]"), "glm-5.1");
assert.equal(normalizeModel("glm-5.2[1M]"), "glm-5.2");
assert.equal(normalizeModel("claude-opus-4-6"), "glm-5.2");
assert.equal(isRetryableUpstreamStatus(429), true);
assert.equal(isRetryableUpstreamStatus(500), true);
assert.equal(isRetryableUpstreamStatus(400), false);
assert.equal(parseRetryAfterMs("2"), 2000);
assert.equal(parseRetryAfterMs("bad"), null);

const converted = anthropicToOpenAI({
  model: "glm-5.1[1M]",
  system: "You are terse.",
  stream: true,
  max_tokens: 1000,
  thinking: { type: "enabled", budget_tokens: 1024 },
  tools: [
    {
      name: "Workflow",
      description: "Run a dynamic workflow",
      input_schema: { type: "object", properties: { task: { type: "string" } } },
    },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "Use workflow." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Calling." },
        { type: "tool_use", id: "toolu_1", name: "Workflow", input: { task: "OK" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "OK" },
        { type: "text", text: "finish" },
      ],
    },
  ],
});

assert.equal(converted.model, "glm-5.1");
assert.deepEqual(converted.thinking, { type: "enabled" });
assert.equal(converted.tools[0].function.name, "Workflow");
assert.equal(converted.messages[0].role, "system");
assert.equal(converted.messages[2].tool_calls[0].function.name, "Workflow");
assert.equal(converted.messages[3].role, "tool");

const anthropic = openAIToAnthropic(
  {
    id: "chatcmpl_1",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Workflow", arguments: "{\"task\":\"OK\"}" },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
  "glm-5.1[1M]",
);

assert.equal(anthropic.stop_reason, "tool_use");
assert.equal(anthropic.content[0].type, "tool_use");
assert.deepEqual(anthropic.content[0].input, { task: "OK" });

const ccLikeTools = [
  {
    name: "Bash",
    description: "Run shell commands",
    input_schema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", pattern: ".*" },
        timeout_ms: {
          anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
          default: null,
        },
        sandbox: {
          oneOf: [{ const: "read-only" }, { const: "workspace-write" }, { const: "danger-full-access" }],
        },
      },
    },
  },
  {
    name: "Edit",
    description: "Edit a file",
    input_schema: {
      allOf: [
        { type: "object" },
        {
          required: ["file_path", "old_string", "new_string"],
          properties: {
            file_path: { type: "string", format: "uri-reference" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
        },
      ],
      $defs: { ignored: { type: "string" } },
    },
  },
  {
    name: "TodoWrite",
    description: "Write todos",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", examples: ["test"] },
              status: { enum: ["pending", "in_progress", "completed"] },
              priority: { oneOf: [{ const: "high" }, { const: "medium" }, { const: "low" }] },
            },
          },
        },
      },
    },
  },
  {
    name: "Workflow",
    description: "Run dynamic workflow orchestration",
    input_schema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              model: { anyOf: [{ const: "glm-5.2" }, { const: "glm-5.1" }] },
            },
          },
        },
      },
    },
  },
];

const toolsConverted = anthropicToOpenAI({
  model: "glm-5.2[1M]",
  messages: [{ role: "user", content: "test tools" }],
  tools: ccLikeTools,
});

assert.equal(toolsConverted.model, "glm-5.2");
assert.deepEqual(
  toolsConverted.tools.map((tool) => tool.function.name),
  ccLikeTools.map((tool) => tool.name),
);
assert.deepEqual(
  toolsConverted.tools[0].function.parameters.properties.sandbox.enum,
  ["read-only", "workspace-write", "danger-full-access"],
);
assert.deepEqual(toolsConverted.tools[2].function.parameters.properties.todos.items.properties.priority.enum, [
  "high",
  "medium",
  "low",
]);
assertNoForbiddenSchemaKeys(toolsConverted.tools);

function assertNoForbiddenSchemaKeys(value) {
  const forbidden = new Set([
    "$schema",
    "$defs",
    "definitions",
    "default",
    "examples",
    "format",
    "not",
    "pattern",
    "patternProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "const",
  ]);
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenSchemaKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `forbidden schema key remained: ${key}`);
    assertNoForbiddenSchemaKeys(item);
  }
}

console.log("ok");
