import { ICON_NAMES } from "../ui/details";
import { jsonObject, type ModelInput } from "./protocol";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Mirrors the reply shape Role 3's DESIGN_SYSTEM_PROMPT asks for; Role 3's grounding still validates it.
export const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "title", "sections"],
  properties: {
    status: { type: "string", enum: ["ready", "use_original", "not_found"] },
    title: { type: "string" },
    // Optional detail for a richer screen (see ui/details.ts); none of it is trusted.
    summary: { type: "string" },
    highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "text"],
        properties: { title: { type: "string" }, text: { type: "string" } },
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "heading", "buttons"],
        properties: {
          priority: { type: "string", enum: ["main", "more"] },
          heading: { type: "string" },
          description: { type: "string" },
          buttons: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["actionId", "label"],
              properties: {
                actionId: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                icon: { type: "string", enum: [...ICON_NAMES] },
              },
            },
          },
        },
      },
    },
    search: {
      type: "object",
      additionalProperties: false,
      required: ["actionId", "label"],
      properties: { actionId: { type: "string" }, label: { type: "string" } },
    },
  },
};

// Raised for provider-reported failures; the message comes from the provider, never from the key.
export class ProviderRejected extends Error {}

export function geminiBody(input: ModelInput, model?: string) {
  const isGemini3 = model ? model.includes("3") : true;
  return {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload),
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      ...(input.task === "design" ? { responseJsonSchema: DESIGN_SCHEMA } : {}),
      temperature: 0.2,
      // Choosing and labelling a page's real actions needs little reasoning, and
      // the default made each design several seconds slower. Only Gemini 3+ models support thinkingLevel.
      ...(isGemini3 ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
  };
}

export async function generateJSON(
  input: ModelInput,
  key: string,
  model: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const modelsToTry = [model];
  if (!modelsToTry.includes("gemini-2.5-flash")) modelsToTry.push("gemini-2.5-flash");

  let lastError: Error | null = null;
  for (const currentModel of modelsToTry) {
    if (signal.aborted) break;
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(currentModel)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(geminiBody(input, currentModel)),
      signal,
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      promptFeedback?: { blockReason?: string };
      candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
    };
    if (!response.ok) {
      if ((response.status === 503 || response.status === 429) && currentModel !== modelsToTry[modelsToTry.length - 1]) {
        lastError = new ProviderRejected(
          `Gemini ${response.status}: ${data.error?.message ?? "request failed"}`,
        );
        continue;
      }
      throw new ProviderRejected(
        `Gemini ${response.status}: ${data.error?.message ?? "request failed"}`,
      );
    }
    if (data.promptFeedback?.blockReason)
      throw new ProviderRejected(`Gemini blocked the request (${data.promptFeedback.blockReason})`);
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text)
      throw new ProviderRejected(`Gemini returned no text (${candidate?.finishReason ?? "unknown"})`);
    if (candidate?.finishReason && candidate.finishReason !== "STOP")
      throw new ProviderRejected(`Gemini stopped early (${candidate.finishReason})`);
    return jsonObject(JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")));
  }
  throw lastError ?? new ProviderRejected("Gemini request failed.");
}
