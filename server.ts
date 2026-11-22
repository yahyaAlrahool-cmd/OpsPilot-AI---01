import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import {
  normalizeAnalystResponse,
  normalizeDailyBriefResponse,
  normalizePerformanceResponse,
  safeParseJson,
} from "./src/utils/aiNormalizers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_DEV = process.env.NODE_ENV !== "production";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PRIMARY_MODEL = "gemini-4-hydrogen";
const FAST_MODEL = "gemini-3.1-flash-lite";
const PRIMARY_COOLDOWN_MS = 90_000;

let primaryCooldownUntil = 0;

interface DevDiagnosticRecord {
  endpoint: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  model: string;
  payloadBytes: number;
  responseBytes: number;
  status: "success" | "error" | "canceled" | "timeout";
  errorType?: string;
  cancelReason?: string;
}

function logDevDiagnostic(diag: DevDiagnosticRecord) {
  if (!IS_DEV) return;
  console.log("[OpsPilot Dev Diagnostics]", JSON.stringify(diag));
}

function resolveApiKey(): string | undefined {
  const candidates = [process.env.GEMINI_API_KEY, process.env.API_KEY];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && trimmed !== "MY_GEMINI_API_KEY") {
      return trimmed;
    }
  }
  return undefined;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY_MISSING");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function sanitizeErrorMessage(raw: string): string {
  return raw.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_KEY]");
}

function formatApiError(err: unknown): { status: number; code: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const safe = sanitizeErrorMessage(raw);
  if (IS_DEV) {
    console.error("[OpsPilot AI Error]", safe);
  }

  if (safe.includes("CLIENT_CANCELED")) {
    return {
      status: 499,
      code: "CANCELED",
      message: "Analysis was canceled. Your workspace is unchanged.",
    };
  }
  if (safe.includes("GEMINI_API_KEY_MISSING")) {
    return {
      status: 503,
      code: "NOT_CONFIGURED",
      message:
        "Gemini API key is not configured. Please add GEMINI_API_KEY in AI Studio Settings > Secrets and reload.",
    };
  }
  if (safe.includes("API_KEY_INVALID") || safe.includes("API key not valid")) {
    return {
      status: 400,
      code: "INVALID_KEY",
      message:
        "The configured Gemini API key is invalid. Please update GEMINI_API_KEY in Settings > Secrets.",
    };
  }
  if (safe.includes("403") || safe.includes("PERMISSION_DENIED")) {
    return {
      status: 403,
      code: "PERMISSION_DENIED",
      message:
        "Gemini API permission denied. Please verify your API key in Settings > Secrets.",
    };
  }
  if (safe.includes("404") || safe.includes("NOT_FOUND")) {
    return {
      status: 404,
      code: "MODEL_NOT_FOUND",
      message: "Requested Gemini model is unavailable or unsupported for this API key.",
    };
  }
  if (safe.includes("429") || safe.includes("RESOURCE_EXHAUSTED")) {
    return {
      status: 429,
      code: "RATE_LIMIT",
      message:
        "Gemini API rate limit or quota exceeded (429). Please wait a moment and retry.",
    };
  }
  if (safe.includes("AbortError") || safe.includes("aborted") || safe.includes("timeout")) {
    return {
      status: 504,
      code: "TIMEOUT",
      message: "The analysis took too long to complete. Try a narrower question.",
    };
  }
  if (safe.includes("503") || safe.includes("UNAVAILABLE") || safe.includes("fetch failed")) {
    return {
      status: 502,
      code: "TEMPORARY_FAILURE",
      message: "AI analysis is temporarily unavailable. Please retry.",
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "AI analysis could not be completed. Your workspace data is safe. Please try again.",
  };
}

function getOrderedModels(preferFastModel = true): string[] {
  const now = Date.now();
  if (preferFastModel || now < primaryCooldownUntil) {
    return [FAST_MODEL, PRIMARY_MODEL];
  }
  return [PRIMARY_MODEL, FAST_MODEL];
}

function thinkingConfigForModel(model: string) {
  if (model === FAST_MODEL) {
    return { thinkingLevel: ThinkingLevel.MINIMAL };
  }
  // gemini-4-hydrogen defaults to HIGH thinking; LOW cuts latency while keeping accuracy
  return { thinkingLevel: ThinkingLevel.LOW };
}

function isQuotaOrRateError(msg: string): boolean {
  return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
}

function isTransientError(msg: string): boolean {
  return (
    msg.includes("503") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("500") ||
    msg.includes("fetch failed")
  );
}

async function generateWithFallback(
  ai: GoogleGenAI,
  params: Omit<Parameters<GoogleGenAI["models"]["generateContent"]>[0], "model">,
  externalSignal?: AbortSignal
) {
  const modelsToTry = getOrderedModels(true);
  let lastErr: unknown;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    if (externalSignal?.aborted) {
      throw new Error("CLIENT_CANCELED");
    }

    const model = modelsToTry[mIdx];
    const modelTimeoutMs = model === FAST_MODEL ? 22_000 : 50_000;

    for (let attempt = 0; attempt <= 1; attempt++) {
      if (externalSignal?.aborted) {
        throw new Error("CLIENT_CANCELED");
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onExternalAbort = () => controller.abort("client_disconnected");
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort("timeout");
          reject(new Error(`Request timeout (${modelTimeoutMs}ms) on ${model}`));
        }, modelTimeoutMs);
      });

      try {
        const res = await Promise.race([
          ai.models.generateContent({
            ...params,
            model,
            config: {
              ...params.config,
              thinkingConfig: thinkingConfigForModel(model),
              abortSignal: controller.signal,
            },
          }),
          timeoutPromise,
        ]);
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        return { response: res, model };
      } catch (err) {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);

        if (externalSignal?.aborted) {
          throw new Error("CLIENT_CANCELED");
        }

        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);

        if (isQuotaOrRateError(msg)) {
          if (model === PRIMARY_MODEL) {
            primaryCooldownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
          }
          if (mIdx < modelsToTry.length - 1) break;
        }
        if (isTransientError(msg) && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        if ((controller.signal.aborted || msg.includes("timeout")) && mIdx < modelsToTry.length - 1) {
          break;
        }
        if (!isTransientError(msg)) {
          throw err;
        }
      }
    }
  }
  throw lastErr;
}

function attachClientDisconnectGuard(res: express.Response): {
  signal: AbortSignal;
  isDisconnected: () => boolean;
  cleanup: () => void;
} {
  let disconnected = false;
  const controller = new AbortController();

  const onClose = () => {
    if (!res.writableFinished && !res.writableEnded) {
      disconnected = true;
      controller.abort("client_disconnected");
    }
  };
  res.on("close", onClose);

  return {
    signal: controller.signal,
    isDisconnected: () => disconnected,
    cleanup: () => res.off("close", onClose),
  };
}

type ChatIntent =
  | "greeting"
  | "workload"
  | "risk_overdue"
  | "performance"
  | "projects_lookup"
  | "complex_analysis";

function buildChatSystemInstruction(
  intent: ChatIntent,
  langName: string,
  context: unknown
): { systemInstruction: string; maxOutputTokens: number } {
  if (intent === "greeting") {
    return {
      systemInstruction: `You are OpsPilot AI, an operations copilot for service businesses.
Respond strictly in ${langName}.
The user sent a simple greeting or connection check. Reply warmly and concisely in 1-2 sentences, confirming you are ready to help with project risks, overdue deliveries, team workload, or operational performance.
Do NOT invent or recite unrequested project statistics.`,
      maxOutputTokens: 120,
    };
  }

  const contextJson = JSON.stringify(context ?? {});

  const isArabic = langName.startsWith("Arabic");
  const h = isArabic
    ? {
        direct: "### 1. الإجابة المباشرة",
        evidence: "### 2. الأدلة الداعمة",
        matters: "### 3. لماذا يهم هذا",
        action: "### 4. الإجراء الموصى به",
        priority: "### 5. الأولوية",
        missingPhrase: "لا تحتوي بيانات مساحة العمل الحالية على معلومات كافية للإجابة بدقة على هذا الجزء.",
      }
    : {
        direct: "### 1. Direct Answer",
        evidence: "### 2. Supporting Evidence",
        matters: "### 3. Why It Matters",
        action: "### 4. Recommended Action",
        priority: "### 5. Priority",
        missingPhrase: "The workspace data does not contain enough information to determine this reliably.",
      };

  const intentFormatGuidance: Record<Exclude<ChatIntent, "greeting">, string> = {
    workload: `FOCUS: Team Workload & Capacity.
Answer directly using ONLY the teamWorkload, activeProjects, rebalanceCandidates, and capacityNarrative in the JSON.
- Cite exact utilization %, activeWorkloadHours, weeklyCapacityHours, activeProjectsCount, and overdueProjectsCount.
- State the calculation formula when helpful: remaining hours / weekly capacity * 100.
- If suggesting rebalancing, explicitly note whether skillsVerified is true or requires manager verification.
- Format concisely with these Markdown headings in ${langName}:
${h.direct}
${h.evidence}
${h.matters}
${h.action}
${h.priority}`,
    risk_overdue: `FOCUS: Project Risks, Overdue Deliveries & Priorities.
Answer directly using ONLY the activeRisks, summaryCounts, and operationalPatterns JSON.
- Cite exact project IDs (e.g. \`OP-1041\`), titles, clients, owners, deadlines, daysUntilDeadline, progress %, remainingHours, riskScore, and recorded notes/blockers.
- Clearly distinguish Confirmed Data / Calculated Metrics from AI Interpretation / Recommendations.
- If the user asks for a short specific lookup (e.g., a single highest-risk project with 4 fields or drafting a client follow-up message), keep the response crisp and directly satisfy their exact format. Otherwise structure cleanly with:
${h.direct}
${h.evidence}
${h.matters}
${h.action}
${h.priority}`,
    performance: `FOCUS: Delivery Performance, Completion Rates & Trends.
Answer directly using ONLY the metrics, formulas, completedProjectsRecord, and activeOverdueProjects JSON.
- Show the exact formula and numerator/denominator behind rates (e.g., On-Time Completion Rate = completedOnTimeCount / completedProjects, excluding active projects).
- Cite exact counts, percentages, and project IDs behind delays; explicitly note when historical data is limited.
- Structure cleanly with:
${h.direct}
${h.evidence}
${h.matters}
${h.action}
${h.priority}`,
    projects_lookup: `FOCUS: Project & Client Lookup.
Answer directly and concisely using ONLY the projects and counts JSON. Cite exact IDs, statuses, progress %, owners, and deadlines. Use a clean Markdown list or compact table if listing 3+ projects.`,
    complex_analysis: `FOCUS: Comprehensive Operational Analysis.
Synthesize project execution risks, overdue items, team overload, operationalPatterns, and delivery performance using ONLY the live JSON.
- Clearly label Confirmed Data vs. Calculated Metrics vs. AI Recommendations.
- Cite exact project IDs, employee utilization %, deadlines, recorded notes/blockers, and formulas where applicable.
- Structure concisely in Markdown with these headings in ${langName}:
${h.direct}
${h.evidence}
${h.matters}
${h.action}
${h.priority}`,
  };

  return {
    systemInstruction: `You are OpsPilot AI, an intelligent business operations copilot.
Respond strictly in ${langName}.
${intentFormatGuidance[intent]}

STRICT EPISTEMIC & GROUNDING RULES:
1. Use ONLY the LIVE WORKSPACE DATA below. Never invent projects, deadlines, blockers, budgets, revenue figures, or metrics.
2. Distinguish clearly between Confirmed Data (facts in records), Calculated Metrics (riskScore, utilizationPct, rates), and AI Recommendations.
3. If requested information is absent or notes are empty, explicitly state: "${h.missingPhrase}" (or note "[No notes recorded]" for that project).
4. Wrap project IDs in backticks like \`OP-1041\` and keep Markdown concise, high-signal, and free of filler.

LIVE WORKSPACE DATA:
${contextJson}`,
    maxOutputTokens: intent === "complex_analysis" ? 1500 : 950,
  };
}

app.get("/api/ai/health", (_req, res) => {
  const configured = Boolean(resolveApiKey());
  res.json({
    configured,
    model: FAST_MODEL,
    fallbackModel: PRIMARY_MODEL,
    primaryOnCooldown: Date.now() < primaryCooldownUntil,
    status: configured ? "ready" : "not_configured",
  });
});

app.post("/api/ai/daily-brief", async (req, res) => {
  const startTime = new Date().toISOString();
  const t0 = performance.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  const guard = attachClientDisconnectGuard(res);
  let usedModel = FAST_MODEL;

  try {
    const { language = "en", context } = req.body ?? {};
    if (!context || typeof context !== "object") {
      res.status(400).json({ error: "Operational context payload is required." });
      return;
    }

    const ai = getGeminiClient();
    const langName = language === "ar" ? "Arabic (Modern Standard Business Arabic)" : "English";

    const result = await generateWithFallback(
      ai,
      {
        contents: `Generate an executive Daily Operations Brief based strictly on this pre-calculated operational summary:\n${JSON.stringify(context)}`,
        config: {
          maxOutputTokens: 1200,
          systemInstruction: `You are OpsPilot AI, an operations copilot for a service business.
Write all prose strictly in ${langName}.
STRICT GROUNDING RULES:
- Cite ONLY actual project IDs, project titles, client names, employee names, deadlines, progress percentages, and metrics present in the input JSON.
- NEVER invent deadlines, projects, blockers, or metrics. If a project has no notes recorded, state that explicitly.
- Clearly distinguish confirmed project facts and calculated metrics from AI recommendations.
- Structure each recommended priority with Observation, Supporting Data (evidence), Risk/Impact, and Recommended Action.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallStatus: { type: Type.STRING },
              mostUrgentIssue: { type: Type.STRING },
              attentionToday: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    projectId: { type: Type.STRING },
                    projectTitle: { type: Type.STRING },
                    reason: { type: Type.STRING },
                    deadline: { type: Type.STRING },
                  },
                  required: ["projectId", "projectTitle", "reason", "deadline"],
                },
              },
              workloadConcerns: { type: Type.STRING },
              recommendedPriorities: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    observation: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                    impact: { type: Type.STRING },
                    action: { type: Type.STRING },
                  },
                  required: ["observation", "evidence", "impact", "action"],
                },
              },
            },
            required: [
              "overallStatus",
              "mostUrgentIssue",
              "attentionToday",
              "workloadConcerns",
              "recommendedPriorities",
            ],
          },
        },
      },
      guard.signal
    );

    usedModel = result.model;
    if (guard.isDisconnected() || res.writableEnded) {
      logDevDiagnostic({
        endpoint: "/api/ai/daily-brief",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        model: usedModel,
        payloadBytes,
        responseBytes: 0,
        status: "canceled",
        cancelReason: "client_disconnected",
      });
      return;
    }

    const rawText = (result.response.text ?? "").trim();
    const parsed = safeParseJson(rawText);
    const normalized = parsed.ok ? normalizeDailyBriefResponse(parsed.data) : null;

    if (!normalized) {
      logDevDiagnostic({
        endpoint: "/api/ai/daily-brief",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        model: usedModel,
        payloadBytes,
        responseBytes: Buffer.byteLength(rawText, "utf8"),
        status: "error",
        errorType: "INVALID_AI_RESPONSE",
      });
      res.status(502).json({
        error: "AI analysis could not be completed. Your workspace data is safe. Please try again.",
        code: "INVALID_AI_RESPONSE",
      });
      return;
    }

    const outJson = JSON.stringify(normalized);
    logDevDiagnostic({
      endpoint: "/api/ai/daily-brief",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      model: usedModel,
      payloadBytes,
      responseBytes: Buffer.byteLength(outJson, "utf8"),
      status: "success",
    });

    res.type("application/json").send(outJson);
  } catch (err) {
    const { status, code, message } = formatApiError(err);
    const diagStatus =
      guard.isDisconnected() || code === "CANCELED"
        ? "canceled"
        : code === "TIMEOUT"
        ? "timeout"
        : "error";

    logDevDiagnostic({
      endpoint: "/api/ai/daily-brief",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      model: usedModel,
      payloadBytes,
      responseBytes: 0,
      status: diagStatus,
      errorType: code,
      cancelReason: guard.isDisconnected() ? "client_disconnected" : undefined,
    });

    if (!guard.isDisconnected() && !res.writableEnded) {
      res.status(status).json({ error: message, code });
    }
  } finally {
    guard.cleanup();
  }
});

app.post("/api/ai/analyst", async (req, res) => {
  const startTime = new Date().toISOString();
  const t0 = performance.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  const guard = attachClientDisconnectGuard(res);
  let usedModel = FAST_MODEL;

  try {
    const { language = "en", context } = req.body ?? {};
    if (!context || typeof context !== "object") {
      res.status(400).json({ error: "Operational context payload is required." });
      return;
    }

    const ai = getGeminiClient();
    const langName = language === "ar" ? "Arabic (Modern Standard Business Arabic)" : "English";

    const result = await generateWithFallback(
      ai,
      {
        contents: `Analyze operational risks, bottlenecks, and ranked management priorities from this pre-calculated risk dataset:\n${JSON.stringify(context)}`,
        config: {
          maxOutputTokens: 1200,
          systemInstruction: `You are OpsPilot AI's Risk & Operations Analyst.
Respond strictly in ${langName}.
GROUNDING RULES:
- Base every finding on exact project IDs, deadlines, progress %, remaining workload hours, and lastUpdated dates from the JSON.
- Do NOT fabricate risks, blockers, or metrics not supported by the input. If project notes are absent, state that explicitly.
- Every bottleneck and recommendation must follow: Observation, Supporting Data (evidence), Risk/Impact, and Recommended Action.
- For workload rebalancing, check employee skills and capacity; if skills do not cover the service type or skillsVerified is false, explicitly state that manager verification is required.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              executiveSummary: { type: Type.STRING },
              bottlenecksDetected: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    observation: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                    impact: { type: Type.STRING },
                    action: { type: Type.STRING },
                  },
                  required: ["title", "observation", "evidence", "impact", "action"],
                },
              },
              rankedActions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    priority: { type: Type.STRING },
                    relatedProjectId: { type: Type.STRING },
                    action: { type: Type.STRING },
                    reason: { type: Type.STRING },
                    expectedImpact: { type: Type.STRING },
                  },
                  required: ["priority", "relatedProjectId", "action", "reason", "expectedImpact"],
                },
              },
            },
            required: ["executiveSummary", "bottlenecksDetected", "rankedActions"],
          },
        },
      },
      guard.signal
    );

    usedModel = result.model;
    if (guard.isDisconnected() || res.writableEnded) {
      logDevDiagnostic({
        endpoint: "/api/ai/analyst",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        model: usedModel,
        payloadBytes,
        responseBytes: 0,
        status: "canceled",
        cancelReason: "client_disconnected",
      });
      return;
    }

    const rawText = (result.response.text ?? "").trim();
    const parsed = safeParseJson(rawText);
    const normalized = parsed.ok ? normalizeAnalystResponse(parsed.data) : null;

    if (!normalized) {
      logDevDiagnostic({
        endpoint: "/api/ai/analyst",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        model: usedModel,
        payloadBytes,
        responseBytes: Buffer.byteLength(rawText, "utf8"),
        status: "error",
        errorType: "INVALID_AI_RESPONSE",
      });
      res.status(502).json({
        error: "AI analysis could not be completed. Your workspace data is safe. Please try again.",
        code: "INVALID_AI_RESPONSE",
      });
      return;
    }

    const outJson = JSON.stringify(normalized);
    logDevDiagnostic({
      endpoint: "/api/ai/analyst",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      model: usedModel,
      payloadBytes,
      responseBytes: Buffer.byteLength(outJson, "utf8"),
      status: "success",
    });

    res.type("application/json").send(outJson);
  } catch (err) {
    const { status, code, message } = formatApiError(err);
    const diagStatus =
      guard.isDisconnected() || code === "CANCELED"
        ? "canceled"
        : code === "TIMEOUT"
        ? "timeout"
        : "error";

    logDevDiagnostic({
      endpoint: "/api/ai/analyst",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      model: usedModel,
      payloadBytes,
      responseBytes: 0,
      status: diagStatus,
      errorType: code,
      cancelReason: guard.isDisconnected() ? "client_disconnected" : undefined,
    });

    if (!guard.isDisconnected() && !res.writableEnded) {
      res.status(status).json({ error: message, code });
    }
  } finally {
    guard.cleanup();
  }
});

app.post("/api/ai/performance-insights", async (req, res) => {
  const startTime = new Date().toISOString();
  const t0 = performance.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  const guard = attachClientDisconnectGuard(res);
  let usedModel = FAST_MODEL;

  try {
    const { language = "en", context } = req.body ?? {};
    if (!context || typeof context !== "object") {
      res.status(400).json({ error: "Performance metrics context is required." });
      return;
    }

    const ai = getGeminiClient();
    const langName = language === "ar" ? "Arabic (Modern Standard Business Arabic)" : "English";

    const result = await generateWithFallback(
      ai,
      {
        contents: `Interpret these pre-calculated operational performance metrics, monthly trends, and delayed project summaries:\n${JSON.stringify(context)}`,
        config: {
          maxOutputTokens: 950,
          systemInstruction: `You are OpsPilot AI's Performance Analyst.
Respond strictly in ${langName}.
GROUNDING RULES:
- Clearly distinguish confirmed factual numbers from AI interpretations.
- Cite exact percentages, day counts, categories, and project IDs from the input JSON.
- Keep each item concise (1-2 sentences) and produce 2-3 high-signal items per section.
- Do not invent missing historical data; if a trend has limited data points, state that clearly.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              whatsImproving: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    observation: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                  },
                  required: ["observation", "evidence"],
                },
              },
              whatsGettingWorse: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    observation: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                  },
                  required: ["observation", "evidence"],
                },
              },
              delayPatterns: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    pattern: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                    impact: { type: Type.STRING },
                  },
                  required: ["pattern", "evidence", "impact"],
                },
              },
              improvementActions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    action: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                    expectedImpact: { type: Type.STRING },
                  },
                  required: ["action", "evidence", "expectedImpact"],
                },
              },
            },
            required: [
              "whatsImproving",
              "whatsGettingWorse",
              "delayPatterns",
              "improvementActions",
            ],
          },
        },
      },
      guard.signal
    );

    usedModel = result.model;
    if (guard.isDisconnected() || res.writableEnded) {
      logDevDiagnostic({
        endpoint: "/api/ai/performance-insights",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        model: usedModel,
        payloadBytes,
        responseBytes: 0,
        status: "canceled",
        cancelReason: "client_disconnected",
      });
      return;
    }

    const rawText = (result.response.text ?? "").trim();
    const parsed = safeParseJson(rawText);
    const normalized = parsed.ok ? normalizePerformanceResponse(parsed.data) : null;

    if (!normalized) {
      logDevDiagnostic({
        endpoint: "/api/ai/performance-insights",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        model: usedModel,
        payloadBytes,
        responseBytes: Buffer.byteLength(rawText, "utf8"),
        status: "error",
        errorType: "INVALID_AI_RESPONSE",
      });
      res.status(502).json({
        error: "AI analysis could not be completed. Your workspace data is safe. Please try again.",
        code: "INVALID_AI_RESPONSE",
      });
      return;
    }

    const outJson = JSON.stringify(normalized);
    logDevDiagnostic({
      endpoint: "/api/ai/performance-insights",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      model: usedModel,
      payloadBytes,
      responseBytes: Buffer.byteLength(outJson, "utf8"),
      status: "success",
    });

    res.type("application/json").send(outJson);
  } catch (err) {
    const { status, code, message } = formatApiError(err);
    const diagStatus =
      guard.isDisconnected() || code === "CANCELED"
        ? "canceled"
        : code === "TIMEOUT"
        ? "timeout"
        : "error";

    logDevDiagnostic({
      endpoint: "/api/ai/performance-insights",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      model: usedModel,
      payloadBytes,
      responseBytes: 0,
      status: diagStatus,
      errorType: code,
      cancelReason: guard.isDisconnected() ? "client_disconnected" : undefined,
    });

    if (!guard.isDisconnected() && !res.writableEnded) {
      res.status(status).json({ error: message, code });
    }
  } finally {
    guard.cleanup();
  }
});

app.post("/api/ai/chat", async (req, res) => {
  const startTime = new Date().toISOString();
  const tReqStart = performance.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  const {
    language = "en",
    messages = [],
    context = null,
    intent = "complex_analysis",
    stream = true,
  } = req.body ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Messages array is required." });
    return;
  }
  const safeIntent: ChatIntent = (
    ["greeting", "workload", "risk_overdue", "performance", "projects_lookup", "complex_analysis"] as const
  ).includes(intent)
    ? intent
    : "complex_analysis";

  if (safeIntent !== "greeting" && (!context || typeof context !== "object")) {
    res.status(400).json({ error: "Operational context is required for non-greeting queries." });
    return;
  }

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient();
  } catch (err) {
    const { status, code, message } = formatApiError(err);
    logDevDiagnostic({
      endpoint: "/api/ai/chat",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - tReqStart),
      model: FAST_MODEL,
      payloadBytes,
      responseBytes: 0,
      status: "error",
      errorType: code,
    });
    res.status(status).json({ error: message, code });
    return;
  }

  const langName = language === "ar" ? "Arabic (Modern Standard Business Arabic)" : "English";
  const recentMessages = safeIntent === "greeting" ? messages.slice(-2) : messages.slice(-8);
  const conversation = recentMessages
    .map((m: { role: string; content: string }) => `${m.role === "user" ? "User" : "OpsPilot"}: ${m.content}`)
    .join("\n\n");

  const { systemInstruction, maxOutputTokens } = buildChatSystemInstruction(safeIntent, langName, context);
  const contextBytes = context ? Buffer.byteLength(JSON.stringify(context), "utf8") : 0;
  const userPrompt =
    safeIntent === "greeting"
      ? `${conversation}\n\nRespond briefly as OpsPilot.`
      : `Conversation:\n${conversation}\n\nProvide OpsPilot's response based strictly on the workspace data.`;

  // Non-streaming JSON mode (if explicitly requested stream: false)
  if (stream === false) {
    const guard = attachClientDisconnectGuard(res);
    let usedModel = FAST_MODEL;
    try {
      const preferFast = req.body?.preferFast !== false;
      const modelsToTry = getOrderedModels(preferFast);
      let lastErr: unknown;
      const attempts: Array<{ model: string; ms: number; error?: string }> = [];
      for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
        if (guard.isDisconnected()) throw new Error("CLIENT_CANCELED");
        const model = modelsToTry[mIdx];
        usedModel = model;
        const tAttempt = performance.now();
        const modelTimeout = model === FAST_MODEL ? 22_000 : 50_000;
        const controller = new AbortController();
        const onDisconnect = () => controller.abort("client_disconnected");
        guard.signal.addEventListener("abort", onDisconnect, { once: true });
        const timer = setTimeout(() => controller.abort("timeout"), modelTimeout);
        try {
          const response = await ai.models.generateContent({
            model,
            contents: userPrompt,
            config: {
              systemInstruction,
              maxOutputTokens,
              thinkingConfig: thinkingConfigForModel(model),
              abortSignal: controller.signal,
            },
          });
          clearTimeout(timer);
          guard.signal.removeEventListener("abort", onDisconnect);
          const totalMs = Math.round(performance.now() - tReqStart);
          const reply = response.text ?? "";
          attempts.push({ model, ms: Math.round(performance.now() - tAttempt) });
          const outPayload = JSON.stringify({ reply, intent: safeIntent, model, totalMs, contextBytes, attempts });
          logDevDiagnostic({
            endpoint: "/api/ai/chat(json)",
            startTime,
            endTime: new Date().toISOString(),
            durationMs: totalMs,
            model,
            payloadBytes,
            responseBytes: Buffer.byteLength(outPayload, "utf8"),
            status: "success",
          });
          res.type("application/json").send(outPayload);
          return;
        } catch (err) {
          clearTimeout(timer);
          guard.signal.removeEventListener("abort", onDisconnect);
          if (guard.isDisconnected()) throw new Error("CLIENT_CANCELED");
          lastErr = err;
          const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
          attempts.push({ model, ms: Math.round(performance.now() - tAttempt), error: msg.slice(0, 140) });
          if (isQuotaOrRateError(msg) && model === PRIMARY_MODEL) {
            primaryCooldownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
          }
          if (mIdx < modelsToTry.length - 1 && (isQuotaOrRateError(msg) || isTransientError(msg))) {
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    } catch (err) {
      const { status, code, message } = formatApiError(err);
      logDevDiagnostic({
        endpoint: "/api/ai/chat(json)",
        startTime,
        endTime: new Date().toISOString(),
        durationMs: Math.round(performance.now() - tReqStart),
        model: usedModel,
        payloadBytes,
        responseBytes: 0,
        status: guard.isDisconnected() || code === "CANCELED" ? "canceled" : code === "TIMEOUT" ? "timeout" : "error",
        errorType: code,
        cancelReason: guard.isDisconnected() ? "client_disconnected" : undefined,
      });
      if (!guard.isDisconnected() && !res.writableEnded) {
        res.status(status).json({ error: message, code });
      }
    } finally {
      guard.cleanup();
    }
    return;
  }

  // Streaming SSE mode
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;
  const clientAbort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished && !res.writableEnded) {
      clientClosed = true;
      clientAbort.abort();
    }
  });

  let streamedBytes = 0;
  const writeSse = (payload: Record<string, unknown>) => {
    if (clientClosed || res.writableEnded) return;
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    streamedBytes += Buffer.byteLength(chunk, "utf8");
    res.write(chunk);
  };

  const modelsToTry = getOrderedModels(true);
  let lastErr: unknown;
  let streamedAnyChunk = false;
  let usedModel = modelsToTry[0];
  let ttftMs = -1;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    if (clientClosed) break;
    const model = modelsToTry[mIdx];
    usedModel = model;

    const timeoutMs =
      model === FAST_MODEL
        ? safeIntent === "greeting"
          ? 8_000
          : safeIntent === "complex_analysis"
          ? 25_000
          : 15_000
        : 50_000;
    const timeoutController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timeoutController.abort();
        reject(new Error(`Request timeout (${timeoutMs}ms) waiting for Gemini stream on ${model}`));
      }, timeoutMs);
    });
    const onClientAbort = () => timeoutController.abort();
    clientAbort.signal.addEventListener("abort", onClientAbort, { once: true });

    try {
      writeSse({
        type: "meta",
        intent: safeIntent,
        model,
        contextBytes,
      });

      const consumeStream = async () => {
        const streamResp = await ai.models.generateContentStream({
          model,
          contents: userPrompt,
          config: {
            systemInstruction,
            maxOutputTokens,
            thinkingConfig: thinkingConfigForModel(model),
            abortSignal: timeoutController.signal,
          },
        });

        for await (const chunk of streamResp) {
          if (clientClosed || timeoutController.signal.aborted) break;
          const text = chunk.text;
          if (text) {
            if (ttftMs < 0) {
              ttftMs = Math.round(performance.now() - tReqStart);
            }
            streamedAnyChunk = true;
            writeSse({ type: "chunk", text });
          }
        }
      };

      await Promise.race([consumeStream(), timeoutPromise]);

      if (timeoutHandle) clearTimeout(timeoutHandle);
      clientAbort.signal.removeEventListener("abort", onClientAbort);

      if (!clientClosed) {
        const totalMs = Math.round(performance.now() - tReqStart);
        writeSse({
          type: "done",
          intent: safeIntent,
          model,
          contextBytes,
          ttftMs: ttftMs < 0 ? totalMs : ttftMs,
          totalMs,
        });
        logDevDiagnostic({
          endpoint: "/api/ai/chat(sse)",
          startTime,
          endTime: new Date().toISOString(),
          durationMs: totalMs,
          model,
          payloadBytes,
          responseBytes: streamedBytes,
          status: "success",
        });
        res.end();
      } else {
        logDevDiagnostic({
          endpoint: "/api/ai/chat(sse)",
          startTime,
          endTime: new Date().toISOString(),
          durationMs: Math.round(performance.now() - tReqStart),
          model,
          payloadBytes,
          responseBytes: streamedBytes,
          status: "canceled",
          cancelReason: "client_disconnected",
        });
      }
      return;
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      clientAbort.signal.removeEventListener("abort", onClientAbort);
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (isQuotaOrRateError(msg) && model === PRIMARY_MODEL) {
        primaryCooldownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
      }

      if (!streamedAnyChunk && !clientClosed && mIdx < modelsToTry.length - 1) {
        if (isQuotaOrRateError(msg) || isTransientError(msg) || msg.includes("timeout")) {
          continue;
        }
      }
      break;
    }
  }

  if (clientClosed) {
    logDevDiagnostic({
      endpoint: "/api/ai/chat(sse)",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - tReqStart),
      model: usedModel,
      payloadBytes,
      responseBytes: streamedBytes,
      status: "canceled",
      cancelReason: "client_disconnected",
    });
    return;
  }

  if (!res.writableEnded) {
    const { code, message } = formatApiError(lastErr);
    logDevDiagnostic({
      endpoint: "/api/ai/chat(sse)",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - tReqStart),
      model: usedModel,
      payloadBytes,
      responseBytes: streamedBytes,
      status: code === "TIMEOUT" ? "timeout" : "error",
      errorType: code,
    });
    writeSse({ type: "error", code, message, model: usedModel });
    res.end();
  }
});

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`OpsPilot AI server listening on port ${PORT}`);
  });
}

startServer();
