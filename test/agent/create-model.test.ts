import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogle } from "@langchain/google/node";
import { ChatOpenAI } from "@langchain/openai";
import { createModel } from "../../src/agent/index.ts";

// Constructing a LangChain chat model makes no network calls (auth/clients
// resolve lazily on first request), so these assert the gemini-enterprise
// surface dispatch and the project-id guard without needing GCP credentials.

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";
const GEMINI_KEY = "GEMINI_API_KEY";
const MAX_OUTPUT_TOKENS_KEY = "OPENWIKI_MAX_OUTPUT_TOKENS";

function modelName(model: unknown): string | undefined {
  return (model as { model?: string }).model;
}

function googleMaxOutputTokens(model: ChatGoogle): number | undefined {
  return (
    model.invocationParams({}) as {
      generationConfig?: { maxOutputTokens?: number };
    }
  ).generationConfig?.maxOutputTokens;
}

describe("createModel gemini-enterprise surface dispatch", () => {
  let savedProject: string | undefined;
  let savedLocation: string | undefined;
  let savedMaxOutputTokens: string | undefined;

  beforeEach(() => {
    savedProject = process.env[PROJECT_KEY];
    savedLocation = process.env[LOCATION_KEY];
    savedMaxOutputTokens = process.env[MAX_OUTPUT_TOKENS_KEY];
    process.env[PROJECT_KEY] = "test-project";
    process.env[LOCATION_KEY] = "us-central1";
    delete process.env[MAX_OUTPUT_TOKENS_KEY];
  });

  afterEach(() => {
    restoreEnv(PROJECT_KEY, savedProject);
    restoreEnv(LOCATION_KEY, savedLocation);
    restoreEnv(MAX_OUTPUT_TOKENS_KEY, savedMaxOutputTokens);
  });

  test("routes Claude IDs to ChatAnthropic and strips the publisher path", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      0,
    );

    expect(model).toBeInstanceOf(ChatAnthropic);
    expect(modelName(model)).toBe("claude-sonnet-4-5@20250929");
    expect((model as ChatAnthropic).maxTokens).toBe(16_384);
  });

  test("routes MaaS IDs to ChatOpenAI and normalizes to publisher/model", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    );

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model).not.toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("meta/llama-3.3-70b-instruct-maas");
  });

  test("routes Gemini IDs to ChatGoogle", () => {
    const model = createModel("gemini-enterprise", "gemini-3.1-pro", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3.1-pro");
  });

  test("routes Gemma IDs to ChatGoogle (default surface)", () => {
    const model = createModel("gemini-enterprise", "gemma-3-27b-it", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemma-3-27b-it");
  });

  test("strips the publisher path on the Gemini surface", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/google/models/gemini-3-pro",
      0,
    );

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3-pro");
  });

  test("maps an explicit limit across all Vertex model surfaces", () => {
    process.env[MAX_OUTPUT_TOKENS_KEY] = "10000";

    const anthropic = createModel(
      "gemini-enterprise",
      "claude-sonnet-5",
      0,
    ) as ChatAnthropic;
    const maas = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    ) as ChatOpenAI;
    const gemini = createModel(
      "gemini-enterprise",
      "gemini-3.1-pro",
      0,
    ) as ChatGoogle;

    expect(anthropic.maxTokens).toBe(10_000);
    expect(maas.maxTokens).toBe(10_000);
    expect(googleMaxOutputTokens(gemini)).toBe(10_000);
  });

  test("resolves the global endpoint for the MaaS surface when location is unset", () => {
    delete process.env[LOCATION_KEY];

    const model = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    );

    // The global endpoint uses the unprefixed host (not global-aiplatform…).
    const baseURL = (model as { clientConfig?: { baseURL?: string } })
      .clientConfig?.baseURL;
    expect(baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi",
    );
  });

  test("throws a clear error when the project ID is missing", () => {
    delete process.env[PROJECT_KEY];

    expect(() => createModel("gemini-enterprise", "gemini-3.1-pro", 0)).toThrow(
      /GOOGLE_CLOUD_PROJECT is required/u,
    );
  });
});

describe("createModel gemini (AI Studio)", () => {
  let savedGeminiKey: string | undefined;
  let savedMaxOutputTokens: string | undefined;

  beforeEach(() => {
    savedGeminiKey = process.env[GEMINI_KEY];
    savedMaxOutputTokens = process.env[MAX_OUTPUT_TOKENS_KEY];
    process.env[GEMINI_KEY] = "test-gemini-key";
    delete process.env[MAX_OUTPUT_TOKENS_KEY];
  });

  afterEach(() => {
    restoreEnv(GEMINI_KEY, savedGeminiKey);
    restoreEnv(MAX_OUTPUT_TOKENS_KEY, savedMaxOutputTokens);
  });

  test("builds a ChatGoogle AI Studio client with v0 output pinned", () => {
    const model = createModel("gemini", "gemini-3.1-pro", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3.1-pro");

    // Thought-signature workaround: streaming disabled + v0 output, on the AI
    // Studio ("gai") platform. (The API key is stored privately by ChatGoogle
    // and is asserted via the constructor mock in gemini-retry.test.ts.)
    const config = model as {
      _platform?: string;
      disableStreaming?: boolean;
      outputVersion?: string;
    };
    expect(config.disableStreaming).toBe(true);
    expect(config.outputVersion).toBe("v0");
    expect(config._platform).toBe("gai");
  });

  test("maps the provider-neutral limit to maxOutputTokens", () => {
    process.env[MAX_OUTPUT_TOKENS_KEY] = "12000";

    const model = createModel("gemini", "gemini-3.1-pro", 0) as ChatGoogle;

    expect(googleMaxOutputTokens(model)).toBe(12_000);
  });
});

describe("createModel Anthropic output-token limit", () => {
  const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";
  let savedApiKey: string | undefined;
  let savedMaxOutputTokens: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env[ANTHROPIC_KEY];
    savedMaxOutputTokens = process.env[MAX_OUTPUT_TOKENS_KEY];
    process.env[ANTHROPIC_KEY] = "test-key";
    delete process.env[MAX_OUTPUT_TOKENS_KEY];
  });

  afterEach(() => {
    restoreEnv(ANTHROPIC_KEY, savedApiKey);
    restoreEnv(MAX_OUTPUT_TOKENS_KEY, savedMaxOutputTokens);
  });

  test("raises LangChain's fallback for modern Claude aliases", () => {
    const model = createModel("anthropic", "claude-sonnet-5", 0);

    expect(model.maxTokens).toBe(16_384);
  });

  test("honors an explicit limit for any Anthropic model", () => {
    process.env[MAX_OUTPUT_TOKENS_KEY] = "24000";

    const model = createModel("anthropic", "custom-claude-model", 0);

    expect(model.maxTokens).toBe(24_000);
  });
});

describe("createModel OpenAI-compatible transport selection", () => {
  test("routes Copilot GPT-5 models through the Responses API", () => {
    const model = createModel("copilot", "gpt-5.5", 0) as {
      useResponsesApi?: boolean;
    };

    expect(model.useResponsesApi).toBe(true);
  });

  test("keeps non-GPT-5 Copilot models on chat completions", () => {
    const model = createModel("copilot", "claude-sonnet-5", 0) as {
      useResponsesApi?: boolean;
    };

    expect(model.useResponsesApi).toBe(false);
  });
});

describe("createModel provider-neutral maxTokens mapping", () => {
  const OPENAI_KEY = "OPENAI_API_KEY";
  const BEDROCK_REGION_KEY = "BEDROCK_AWS_REGION";
  let savedApiKey: string | undefined;
  let savedBedrockRegion: string | undefined;
  let savedMaxOutputTokens: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env[OPENAI_KEY];
    savedBedrockRegion = process.env[BEDROCK_REGION_KEY];
    savedMaxOutputTokens = process.env[MAX_OUTPUT_TOKENS_KEY];
    process.env[OPENAI_KEY] = "test-key";
    process.env[BEDROCK_REGION_KEY] = "us-east-1";
    process.env[MAX_OUTPUT_TOKENS_KEY] = "14000";
  });

  afterEach(() => {
    restoreEnv(OPENAI_KEY, savedApiKey);
    restoreEnv(BEDROCK_REGION_KEY, savedBedrockRegion);
    restoreEnv(MAX_OUTPUT_TOKENS_KEY, savedMaxOutputTokens);
  });

  test("passes the limit to ChatOpenAI for Responses API routing", () => {
    const model = createModel("openai", "gpt-5.5", 0) as ChatOpenAI;

    expect(model.useResponsesApi).toBe(true);
    expect(model.maxTokens).toBe(14_000);
  });

  test("passes the limit to Bedrock Converse", () => {
    const model = createModel("bedrock", "anthropic.claude-sonnet-5", 0) as {
      maxTokens?: number;
    };

    expect(model.maxTokens).toBe(14_000);
  });
});

describe("createModel openrouter output-token cap", () => {
  const OPENROUTER_KEY = "OPENROUTER_API_KEY";
  const MAX_TOKENS_KEY = "OPENWIKI_OPENROUTER_MAX_TOKENS";
  let savedApiKey: string | undefined;
  let savedMaxTokens: string | undefined;
  let savedMaxOutputTokens: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env[OPENROUTER_KEY];
    savedMaxTokens = process.env[MAX_TOKENS_KEY];
    savedMaxOutputTokens = process.env[MAX_OUTPUT_TOKENS_KEY];
    process.env[OPENROUTER_KEY] = "test-key";
    delete process.env[MAX_TOKENS_KEY];
    delete process.env[MAX_OUTPUT_TOKENS_KEY];
  });

  afterEach(() => {
    restoreEnv(OPENROUTER_KEY, savedApiKey);
    restoreEnv(MAX_TOKENS_KEY, savedMaxTokens);
    restoreEnv(MAX_OUTPUT_TOKENS_KEY, savedMaxOutputTokens);
  });

  test("leaves maxTokens unset by default", () => {
    const model = createModel("openrouter", "z-ai/glm-4.7-flash", 0) as {
      maxTokens?: number;
    };

    expect(model.maxTokens).toBeUndefined();
  });

  test("passes the configured cap through to ChatOpenRouter", () => {
    process.env[MAX_TOKENS_KEY] = "4096";

    const model = createModel("openrouter", "z-ai/glm-4.7-flash", 0) as {
      maxTokens?: number;
    };

    expect(model.maxTokens).toBe(4096);
  });

  test("accepts the provider-neutral output-token limit", () => {
    process.env[MAX_OUTPUT_TOKENS_KEY] = "12288";

    const model = createModel("openrouter", "z-ai/glm-4.7-flash", 0) as {
      maxTokens?: number;
    };

    expect(model.maxTokens).toBe(12_288);
  });

  test("rejects an invalid cap with a clear error", () => {
    process.env[MAX_TOKENS_KEY] = "lots";

    expect(() => createModel("openrouter", "z-ai/glm-4.7-flash", 0)).toThrow(
      /OPENWIKI_OPENROUTER_MAX_TOKENS/u,
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
