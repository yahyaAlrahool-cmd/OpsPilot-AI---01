import {
  AIErrorKind,
  AnalystAIResponse,
  ChatMessage,
  DailyBriefResponse,
  Employee,
  EmployeeWorkloadSummary,
  Language,
  OperationalMetrics,
  PerformanceAIResponse,
  Project,
  ProjectRiskAssessment,
  RebalanceSuggestion,
} from "../types";
import { getCopy } from "../i18n/translations";
import {
  normalizeAnalystResponse,
  normalizeDailyBriefResponse,
  normalizePerformanceResponse,
  safeParseJson,
} from "../utils/aiNormalizers";
import { calcRemainingHours, getTodayISO } from "../utils/analytics";
import { ChatIntent } from "./contextRetriever";

const IS_DEV = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);

export class AIRequestError extends Error {
  readonly kind: AIErrorKind;
  readonly statusCode?: number;

  constructor(kind: AIErrorKind, message: string, statusCode?: number) {
    super(message);
    this.name = "AIRequestError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export function resolveAIError(
  err: unknown,
  language: Language
): { kind: AIErrorKind; message: string } {
  const t = getCopy(language);
  if (err instanceof AIRequestError) {
    if (err.kind === "canceled") {
      return { kind: "canceled", message: t.aiStates.canceledMessage };
    }
    if (err.kind === "timeout") {
      return { kind: "timeout", message: t.aiStates.timeoutMessage };
    }
    if (err.kind === "rate_limit") {
      return { kind: "rate_limit", message: t.aiStates.tempUnavailable };
    }
    return { kind: err.kind, message: t.aiStates.errorMessage };
  }

  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "canceled", message: t.aiStates.canceledMessage };
  }

  return { kind: "server", message: t.aiStates.errorMessage };
}

function logClientDevDiagnostic(diag: {
  endpoint: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  payloadBytes: number;
  responseBytes: number;
  status: "success" | "error" | "canceled" | "timeout";
  errorType?: string;
  cancelReason?: string;
}) {
  if (!IS_DEV) return;
  console.debug("[OpsPilot Client Diagnostics]", diag);
}

function truncateNote(text: string, maxLen = 120): string {
  const clean = text.trim();
  if (!clean) return "";
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

export interface OperationalContextPayload {
  currentDate: string;
  metricDefinitions: {
    overdueProjects: string;
    completedLateCount: string;
    totalDelayedProjects: string;
    atRiskProjects: string;
  };
  metrics: OperationalMetrics;
  projects: Array<{
    id: string;
    title: string;
    clientName: string;
    serviceType: string;
    ownerName: string;
    status: string;
    priority: string;
    progress: number;
    startDate: string;
    deadline: string;
    completedDate?: string;
    lastUpdated: string;
    estimatedWorkloadHours: number;
    remainingWorkloadHours: number;
    notes: string;
  }>;
  teamWorkload: Array<{
    id: string;
    name: string;
    role: string;
    weeklyCapacityHours: number;
    skills: string[];
    skillsVerified: boolean;
    activeProjectsCount: number;
    completedProjectsCount: number;
    overdueProjectsCount: number;
    activeWorkloadHours: number;
    utilizationPct: number;
    capacityStatus: string;
  }>;
  riskAssessments: Array<{
    projectId: string;
    riskScore: number;
    riskLevel: string;
    daysUntilDeadline: number;
    daysSinceUpdate: number;
    remainingWorkloadHours: number;
    signals: Array<{ detail: string; points: number }>;
    missingData: string[];
  }>;
  rebalanceCandidates: RebalanceSuggestion[];
}

export interface CompactPerformanceContext {
  currentDate: string;
  metrics: OperationalMetrics;
  teamUtilization: Array<{
    name: string;
    utilizationPct: number;
    capacityStatus: string;
    overdueProjectsCount: number;
  }>;
  delayedProjects: Array<{
    id: string;
    title: string;
    serviceType: string;
    owner: string;
    status: string;
    deadline: string;
    completedDate?: string;
    progress: number;
    note?: string;
  }>;
}

export interface CompactDailyBriefContext {
  currentDate: string;
  metrics: {
    totalOrders: number;
    activeProjects: number;
    completedProjects: number;
    overdueProjects: number;
    atRiskProjects: number;
    completionRate: number;
    onTimeCompletionRate: number;
  };
  priorityProjects: Array<{
    id: string;
    title: string;
    client: string;
    owner: string;
    status: string;
    deadline: string;
    progress: number;
    remainingHours: number;
    riskScore: number;
    riskLevel: string;
    daysUntilDeadline: number;
    signals: string[];
    note?: string;
  }>;
  teamWorkload: Array<{
    name: string;
    utilizationPct: number;
    capacityStatus: string;
    activeProjectsCount: number;
    overdueProjectsCount: number;
  }>;
}

export interface CompactAnalystContext {
  currentDate: string;
  metrics: {
    totalOrders: number;
    activeProjects: number;
    overdueProjects: number;
    atRiskProjects: number;
    completionRate: number;
  };
  riskAssessments: Array<{
    projectId: string;
    title: string;
    owner: string;
    status: string;
    deadline: string;
    progress: number;
    riskScore: number;
    riskLevel: string;
    daysUntilDeadline: number;
    daysSinceUpdate: number;
    remainingHours: number;
    signals: string[];
    missingData: string[];
    note?: string;
  }>;
  teamWorkload: Array<{
    name: string;
    weeklyCapacityHours: number;
    activeWorkloadHours: number;
    utilizationPct: number;
    capacityStatus: string;
    skills: string[];
    skillsVerified: boolean;
    overdueProjectsCount: number;
  }>;
  rebalanceCandidates: Array<{
    projectId: string;
    from: string;
    to: string;
    hoursMoved: number;
    skillMatch: boolean;
    requiresManagerVerification: boolean;
  }>;
}

export function buildPerformanceContext(
  projects: Project[],
  employees: Employee[],
  metrics: OperationalMetrics,
  workloads: EmployeeWorkloadSummary[],
  language: Language
): CompactPerformanceContext {
  const todayISO = getTodayISO();
  const empMap = new Map(employees.map((e) => [e.id, e]));

  const delayedProjects = projects
    .filter((p) => {
      if (p.status === "completed") {
        const doneDate = p.completedDate ?? p.lastUpdated;
        return doneDate > p.deadline;
      }
      return p.deadline < todayISO;
    })
    .map((p) => {
      const emp = empMap.get(p.assignedEmployeeId);
      const rawNote = language === "ar" ? p.notesAr || p.notes : p.notes;
      return {
        id: p.id,
        title: language === "ar" ? p.titleAr || p.title : p.title,
        serviceType: p.serviceType,
        owner: emp ? (language === "ar" ? emp.nameAr : emp.name) : "Unassigned",
        status: p.status,
        deadline: p.deadline,
        completedDate: p.completedDate,
        progress: p.progress,
        note: truncateNote(rawNote, 120) || undefined,
      };
    });

  return {
    currentDate: todayISO,
    metrics,
    teamUtilization: workloads.map((w) => ({
      name: language === "ar" ? w.employee.nameAr : w.employee.name,
      utilizationPct: w.utilizationPct,
      capacityStatus: w.capacityStatus,
      overdueProjectsCount: w.overdueProjectsCount,
    })),
    delayedProjects,
  };
}

export function buildDailyBriefContext(
  employees: Employee[],
  metrics: OperationalMetrics,
  risks: ProjectRiskAssessment[],
  workloads: EmployeeWorkloadSummary[],
  language: Language
): CompactDailyBriefContext {
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return {
    currentDate: getTodayISO(),
    metrics: {
      totalOrders: metrics.totalOrders,
      activeProjects: metrics.activeProjects,
      completedProjects: metrics.completedProjects,
      overdueProjects: metrics.overdueProjects,
      atRiskProjects: metrics.atRiskProjects,
      completionRate: metrics.completionRate,
      onTimeCompletionRate: metrics.onTimeCompletionRate,
    },
    priorityProjects: risks.slice(0, 8).map((r) => {
      const emp = empMap.get(r.project.assignedEmployeeId);
      const rawNote = language === "ar" ? r.project.notesAr || r.project.notes : r.project.notes;
      return {
        id: r.project.id,
        title: language === "ar" ? r.project.titleAr || r.project.title : r.project.title,
        client: language === "ar" ? r.project.clientNameAr || r.project.clientName : r.project.clientName,
        owner: emp ? (language === "ar" ? emp.nameAr : emp.name) : "Unassigned",
        status: r.project.status,
        deadline: r.project.deadline,
        progress: r.project.progress,
        remainingHours: r.remainingWorkloadHours,
        riskScore: r.riskScore,
        riskLevel: r.riskLevel,
        daysUntilDeadline: r.daysUntilDeadline,
        signals: r.signals.slice(0, 3).map((s) => (language === "ar" ? s.detailAr : s.detailEn)),
        note: truncateNote(rawNote, 100) || undefined,
      };
    }),
    teamWorkload: workloads.map((w) => ({
      name: language === "ar" ? w.employee.nameAr : w.employee.name,
      utilizationPct: w.utilizationPct,
      capacityStatus: w.capacityStatus,
      activeProjectsCount: w.activeProjectsCount,
      overdueProjectsCount: w.overdueProjectsCount,
    })),
  };
}

export function buildAnalystContext(
  employees: Employee[],
  metrics: OperationalMetrics,
  risks: ProjectRiskAssessment[],
  workloads: EmployeeWorkloadSummary[],
  rebalanceCandidates: RebalanceSuggestion[],
  language: Language
): CompactAnalystContext {
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return {
    currentDate: getTodayISO(),
    metrics: {
      totalOrders: metrics.totalOrders,
      activeProjects: metrics.activeProjects,
      overdueProjects: metrics.overdueProjects,
      atRiskProjects: metrics.atRiskProjects,
      completionRate: metrics.completionRate,
    },
    riskAssessments: risks.map((r) => {
      const emp = empMap.get(r.project.assignedEmployeeId);
      const rawNote = language === "ar" ? r.project.notesAr || r.project.notes : r.project.notes;
      return {
        projectId: r.project.id,
        title: language === "ar" ? r.project.titleAr || r.project.title : r.project.title,
        owner: emp ? (language === "ar" ? emp.nameAr : emp.name) : "Unassigned",
        status: r.project.status,
        deadline: r.project.deadline,
        progress: r.project.progress,
        riskScore: r.riskScore,
        riskLevel: r.riskLevel,
        daysUntilDeadline: r.daysUntilDeadline,
        daysSinceUpdate: r.daysSinceUpdate,
        remainingHours: r.remainingWorkloadHours,
        signals: r.signals.map((s) => (language === "ar" ? s.detailAr : s.detailEn)),
        missingData: language === "ar" ? r.missingDataAr : r.missingDataEn,
        note: truncateNote(rawNote, 100) || undefined,
      };
    }),
    teamWorkload: workloads.map((w) => ({
      name: language === "ar" ? w.employee.nameAr : w.employee.name,
      weeklyCapacityHours: w.employee.weeklyCapacityHours,
      activeWorkloadHours: w.activeWorkloadHours,
      utilizationPct: w.utilizationPct,
      capacityStatus: w.capacityStatus,
      skills: w.employee.skills,
      skillsVerified: w.employee.skillsVerified,
      overdueProjectsCount: w.overdueProjectsCount,
    })),
    rebalanceCandidates: rebalanceCandidates.map((r) => ({
      projectId: r.projectId,
      from: language === "ar" ? r.fromEmployeeNameAr : r.fromEmployeeName,
      to: language === "ar" ? r.toEmployeeNameAr : r.toEmployeeName,
      hoursMoved: r.hoursMoved,
      skillMatch: r.skillMatch,
      requiresManagerVerification: r.requiresManagerVerification,
    })),
  };
}

export function buildOperationalContext(
  projects: Project[],
  employees: Employee[],
  metrics: OperationalMetrics,
  risks: ProjectRiskAssessment[],
  workloads: EmployeeWorkloadSummary[],
  rebalanceCandidates: RebalanceSuggestion[],
  language: Language
): OperationalContextPayload {
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return {
    currentDate: getTodayISO(),
    metricDefinitions: {
      overdueProjects: "Active non-completed projects whose deadline is earlier than currentDate",
      completedLateCount: "Completed projects whose completedDate was after deadline",
      totalDelayedProjects: "overdueProjects + completedLateCount",
      atRiskProjects: "Active projects with riskScore >= 50 (high or critical risk)",
    },
    metrics,
    projects: projects.map((p) => {
      const emp = empMap.get(p.assignedEmployeeId);
      const rawNotes = language === "ar" ? p.notesAr || p.notes : p.notes;
      return {
        id: p.id,
        title: language === "ar" ? p.titleAr || p.title : p.title,
        clientName: language === "ar" ? p.clientNameAr || p.clientName : p.clientName,
        serviceType: p.serviceType,
        ownerName: emp ? (language === "ar" ? emp.nameAr : emp.name) : "Unassigned",
        status: p.status,
        priority: p.priority,
        progress: p.progress,
        startDate: p.startDate,
        deadline: p.deadline,
        completedDate: p.completedDate,
        lastUpdated: p.lastUpdated,
        estimatedWorkloadHours: p.estimatedWorkload,
        remainingWorkloadHours: calcRemainingHours(p),
        notes: rawNotes || "[No execution notes or blocker recorded]",
      };
    }),
    teamWorkload: workloads.map((w) => ({
      id: w.employee.id,
      name: language === "ar" ? w.employee.nameAr : w.employee.name,
      role: language === "ar" ? w.employee.roleAr : w.employee.role,
      weeklyCapacityHours: w.employee.weeklyCapacityHours,
      skills: w.employee.skills,
      skillsVerified: w.employee.skillsVerified,
      activeProjectsCount: w.activeProjectsCount,
      completedProjectsCount: w.completedProjectsCount,
      overdueProjectsCount: w.overdueProjectsCount,
      activeWorkloadHours: w.activeWorkloadHours,
      utilizationPct: w.utilizationPct,
      capacityStatus: w.capacityStatus,
    })),
    riskAssessments: risks.map((r) => ({
      projectId: r.project.id,
      riskScore: r.riskScore,
      riskLevel: r.riskLevel,
      daysUntilDeadline: r.daysUntilDeadline,
      daysSinceUpdate: r.daysSinceUpdate,
      remainingWorkloadHours: r.remainingWorkloadHours,
      signals: r.signals.map((s) => ({
        detail: language === "ar" ? s.detailAr : s.detailEn,
        points: s.points,
      })),
      missingData: language === "ar" ? r.missingDataAr : r.missingDataEn,
    })),
    rebalanceCandidates,
  };
}

interface PostJsonOptions<T> {
  timeoutMs?: number;
  signal?: AbortSignal;
  validate?: (raw: unknown) => T | null;
}

async function postJson<T>(
  url: string,
  body: unknown,
  options: PostJsonOptions<T> = {}
): Promise<T> {
  const { timeoutMs = 35_000, signal: externalSignal, validate } = options;

  if (externalSignal?.aborted) {
    throw new AIRequestError("canceled", "Request canceled.");
  }

  const startTime = new Date().toISOString();
  const t0 = performance.now();
  const serializedBody = JSON.stringify(body);
  const payloadBytes = new TextEncoder().encode(serializedBody).length;

  const controller = new AbortController();
  let timedOut = false;
  let externalCanceled = false;

  const onExternalAbort = () => {
    externalCanceled = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let responseBytes = 0;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializedBody,
      signal: controller.signal,
    });

    const rawText = await res.text();
    responseBytes = new TextEncoder().encode(rawText).length;
    const parsed = safeParseJson(rawText);

    if (!res.ok) {
      const serverErr =
        parsed.ok && typeof (parsed.data as { error?: unknown })?.error === "string"
          ? (parsed.data as { error: string }).error
          : `Request failed with status ${res.status}`;
      const kind: AIErrorKind =
        res.status === 429
          ? "rate_limit"
          : res.status === 504
          ? "timeout"
          : "server";
      throw new AIRequestError(kind, serverErr, res.status);
    }

    if (!parsed.ok) {
      throw new AIRequestError("invalid_response", "Invalid JSON returned from AI endpoint.");
    }

    const validated = validate ? validate(parsed.data) : (parsed.data as T);
    if (validated === null) {
      throw new AIRequestError("invalid_response", "Incomplete AI response schema.");
    }

    logClientDevDiagnostic({
      endpoint: url,
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      payloadBytes,
      responseBytes,
      status: "success",
    });

    return validated;
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const endTime = new Date().toISOString();

    if (externalCanceled || externalSignal?.aborted) {
      logClientDevDiagnostic({
        endpoint: url,
        startTime,
        endTime,
        durationMs,
        payloadBytes,
        responseBytes,
        status: "canceled",
        errorType: "AbortError",
        cancelReason: "user_or_unmount",
      });
      throw new AIRequestError("canceled", "Request canceled.");
    }

    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      logClientDevDiagnostic({
        endpoint: url,
        startTime,
        endTime,
        durationMs,
        payloadBytes,
        responseBytes,
        status: "timeout",
        errorType: "TimeoutError",
        cancelReason: `client_timeout_${timeoutMs}ms`,
      });
      throw new AIRequestError("timeout", "Request timed out.");
    }

    const aiErr =
      err instanceof AIRequestError
        ? err
        : new AIRequestError(
            "network",
            err instanceof Error ? err.message : "Network request failed."
          );

    logClientDevDiagnostic({
      endpoint: url,
      startTime,
      endTime,
      durationMs,
      payloadBytes,
      responseBytes,
      status: aiErr.kind === "timeout" ? "timeout" : "error",
      errorType: aiErr.kind,
    });

    throw aiErr;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export function fetchDailyBrief(
  language: Language,
  context: CompactDailyBriefContext | OperationalContextPayload,
  options?: { signal?: AbortSignal }
): Promise<DailyBriefResponse> {
  return postJson<DailyBriefResponse>(
    "/api/ai/daily-brief",
    { language, context },
    {
      timeoutMs: 35_000,
      signal: options?.signal,
      validate: normalizeDailyBriefResponse,
    }
  );
}

export function fetchAnalystInsights(
  language: Language,
  context: CompactAnalystContext | OperationalContextPayload,
  options?: { signal?: AbortSignal }
): Promise<AnalystAIResponse> {
  return postJson<AnalystAIResponse>(
    "/api/ai/analyst",
    { language, context },
    {
      timeoutMs: 35_000,
      signal: options?.signal,
      validate: normalizeAnalystResponse,
    }
  );
}

export function fetchPerformanceInsights(
  language: Language,
  context: CompactPerformanceContext | OperationalContextPayload,
  options?: { signal?: AbortSignal }
): Promise<PerformanceAIResponse> {
  return postJson<PerformanceAIResponse>(
    "/api/ai/performance-insights",
    { language, context },
    {
      timeoutMs: 35_000,
      signal: options?.signal,
      validate: normalizePerformanceResponse,
    }
  );
}

export function sendOpsPilotChat(
  language: Language,
  messages: Pick<ChatMessage, "role" | "content">[],
  context: Record<string, unknown> | null,
  intent: ChatIntent = "complex_analysis",
  options?: { signal?: AbortSignal }
): Promise<{ reply: string; intent: ChatIntent; model?: string; totalMs?: number }> {
  return postJson<{ reply: string; intent: ChatIntent; model?: string; totalMs?: number }>(
    "/api/ai/chat",
    {
      language,
      messages,
      context,
      intent,
      stream: false,
    },
    {
      timeoutMs: 30_000,
      signal: options?.signal,
    }
  );
}

export interface StreamChatCallbacks {
  onChunk: (fullText: string, delta: string) => void;
  onMeta?: (meta: { intent: ChatIntent; model?: string; contextBytes?: number }) => void;
  onDone?: (metrics: { ttftMs?: number; totalMs?: number; model?: string }) => void;
  signal?: AbortSignal;
}

export async function streamOpsPilotChat(
  language: Language,
  messages: Pick<ChatMessage, "role" | "content">[],
  context: Record<string, unknown> | null,
  intent: ChatIntent,
  callbacks: StreamChatCallbacks
): Promise<{ reply: string; ttftMs?: number; totalMs?: number; model?: string }> {
  if (callbacks.signal?.aborted) {
    throw new AIRequestError("canceled", "Request canceled.");
  }

  const startTime = new Date().toISOString();
  const t0 = performance.now();
  const controller = new AbortController();
  const timeoutMs = intent === "greeting" ? 15_000 : 35_000;
  let timedOut = false;
  let externalCanceled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => {
    externalCanceled = true;
    controller.abort();
  };
  callbacks.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const serializedBody = JSON.stringify({
    language,
    messages,
    context,
    intent,
    stream: true,
  });
  const payloadBytes = new TextEncoder().encode(serializedBody).length;
  let responseBytes = 0;

  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: serializedBody,
      signal: controller.signal,
    });

    if (!res.ok) {
      let errMsg = `Request failed with status ${res.status}`;
      try {
        const rawErr = await res.text();
        responseBytes = new TextEncoder().encode(rawErr).length;
        const parsed = safeParseJson(rawErr);
        if (parsed.ok && typeof (parsed.data as { error?: unknown })?.error === "string") {
          errMsg = (parsed.data as { error: string }).error;
        }
      } catch {
        // ignore parse errors
      }
      const kind: AIErrorKind =
        res.status === 429 ? "rate_limit" : res.status === 504 ? "timeout" : "server";
      throw new AIRequestError(kind, errMsg, res.status);
    }

    if (!res.body) {
      throw new AIRequestError("invalid_response", "Streaming response body is unavailable.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    const MAX_STREAM_CHARS = 40_000;
    let finalMeta: { ttftMs?: number; totalMs?: number; model?: string } = {};

    const processSseBlock = (block: string) => {
      const lines = block.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const rawJson = line.slice(5).trim();
        if (!rawJson) continue;
        const parsedEvt = safeParseJson(rawJson);
        if (!parsedEvt.ok || typeof parsedEvt.data !== "object" || parsedEvt.data === null) {
          continue;
        }
        const evt = parsedEvt.data as {
          type?: string;
          text?: string;
          intent?: ChatIntent;
          model?: string;
          contextBytes?: number;
          ttftMs?: number;
          totalMs?: number;
          message?: string;
          code?: string;
        };

        if (evt.type === "meta") {
          callbacks.onMeta?.({
            intent: evt.intent ?? intent,
            model: evt.model,
            contextBytes: evt.contextBytes,
          });
        } else if (evt.type === "chunk" && typeof evt.text === "string") {
          if (fullText.length < MAX_STREAM_CHARS) {
            const remaining = MAX_STREAM_CHARS - fullText.length;
            const safeDelta = evt.text.slice(0, remaining);
            fullText += safeDelta;
            callbacks.onChunk(fullText, safeDelta);
          }
        } else if (evt.type === "done") {
          finalMeta = {
            ttftMs: evt.ttftMs,
            totalMs: evt.totalMs,
            model: evt.model,
          };
          callbacks.onDone?.(finalMeta);
        } else if (evt.type === "error") {
          const kind: AIErrorKind =
            evt.code === "RATE_LIMIT"
              ? "rate_limit"
              : evt.code === "TIMEOUT"
              ? "timeout"
              : "server";
          throw new AIRequestError(
            kind,
            evt.message || "Unable to complete AI request right now."
          );
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) responseBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";

      for (const block of parts) {
        processSseBlock(block);
      }
    }

    if (buffer.trim()) {
      processSseBlock(buffer);
    }

    logClientDevDiagnostic({
      endpoint: "/api/ai/chat",
      startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      payloadBytes,
      responseBytes,
      status: "success",
    });

    return { reply: fullText, ...finalMeta };
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const endTime = new Date().toISOString();

    if (externalCanceled || callbacks.signal?.aborted) {
      logClientDevDiagnostic({
        endpoint: "/api/ai/chat",
        startTime,
        endTime,
        durationMs,
        payloadBytes,
        responseBytes,
        status: "canceled",
        errorType: "AbortError",
        cancelReason: "user_or_unmount",
      });
      throw new AIRequestError("canceled", "Request canceled.");
    }

    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      logClientDevDiagnostic({
        endpoint: "/api/ai/chat",
        startTime,
        endTime,
        durationMs,
        payloadBytes,
        responseBytes,
        status: "timeout",
        errorType: "TimeoutError",
        cancelReason: `client_timeout_${timeoutMs}ms`,
      });
      throw new AIRequestError("timeout", "Request timed out.");
    }

    const aiErr =
      err instanceof AIRequestError
        ? err
        : new AIRequestError(
            "network",
            err instanceof Error ? err.message : "Network request failed."
          );

    logClientDevDiagnostic({
      endpoint: "/api/ai/chat",
      startTime,
      endTime,
      durationMs,
      payloadBytes,
      responseBytes,
      status: aiErr.kind === "timeout" ? "timeout" : "error",
      errorType: aiErr.kind,
    });

    throw aiErr;
  } finally {
    clearTimeout(timer);
    callbacks.signal?.removeEventListener("abort", onExternalAbort);
  }
}
