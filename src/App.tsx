import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  FolderKanban,
  Globe,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  Network,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sun,
  Users,
  X,
} from "lucide-react";
import {
  AIRequestState,
  AnalystAIResponse,
  ChatMessage,
  DailyBriefResponse,
  Language,
  NavSection,
  PerformanceAIResponse,
  Project,
  ThemeMode,
} from "./types";
import { INITIAL_EMPLOYEES, createInitialProjects } from "./data/seedData";
import {
  assessProjectRisks,
  computeOperationalIntelligence,
  computeOperationalMetrics,
  computeTeamWorkload,
  generateRebalanceSuggestions,
  getTodayISO,
} from "./utils/analytics";
import { normalizeDailyBriefResponse } from "./utils/aiNormalizers";
import { getCopy } from "./i18n/translations";
import { useTheme } from "./hooks/useTheme";
import {
  buildAnalystContext,
  buildDailyBriefContext,
  buildPerformanceContext,
  fetchAnalystInsights,
  fetchDailyBrief,
  fetchPerformanceInsights,
  resolveAIError,
  streamOpsPilotChat,
} from "./services/aiService";
import {
  buildTargetedChatContext,
  classifyChatIntent,
  clearContextCache,
} from "./services/contextRetriever";
import { DashboardView } from "./views/DashboardView";
import { ProjectsView } from "./views/ProjectsView";
import { AnalystView } from "./views/AnalystView";
import { WorkloadView } from "./views/WorkloadView";
import { PerformanceView } from "./views/PerformanceView";
import { AskOpsPilotView } from "./views/AskOpsPilotView";
import { OpsGraphView } from "./views/OpsGraphView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  DeleteConfirmModal,
  ProjectDetailModal,
  ProjectFormModal,
} from "./components/ProjectModals";

const STORAGE_PROJECTS_KEY = "opspilot_projects_v1";
const STORAGE_LANG_KEY = "opspilot_language_v1";

function createIdleState<T>(): AIRequestState<T> {
  return {
    status: "idle",
    data: null,
    errorKind: null,
    errorMessage: null,
  };
}

function loadInitialProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Fallback to seed data
  }
  return createInitialProjects();
}

function loadInitialLanguage(): Language {
  try {
    const raw = localStorage.getItem(STORAGE_LANG_KEY);
    if (raw === "ar" || raw === "en") return raw;
  } catch {
    // Fallback
  }
  return "en";
}

export default function App() {
  const [language, setLanguage] = useState<Language>(loadInitialLanguage);
  const { themeMode, setThemeMode } = useTheme();
  const [activeSection, setActiveSection] = useState<NavSection>("dashboard");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [projects, setProjects] = useState<Project[]>(loadInitialProjects);
  const employees = INITIAL_EMPLOYEES;

  // Modals
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [inspectingProject, setInspectingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);

  // Explicit AI Lifecycle States
  const [briefState, setBriefState] = useState<AIRequestState<DailyBriefResponse>>(createIdleState);
  const [analystState, setAnalystState] =
    useState<AIRequestState<AnalystAIResponse>>(createIdleState);
  const [perfState, setPerfState] =
    useState<AIRequestState<PerformanceAIResponse>>(createIdleState);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStage, setChatStage] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  // Concurrency & Abort Guards
  const mountedRef = useRef(true);
  const briefInFlightRef = useRef(false);
  const briefAbortRef = useRef<AbortController | null>(null);
  const analystInFlightRef = useRef(false);
  const analystAbortRef = useRef<AbortController | null>(null);
  const perfInFlightRef = useRef(false);
  const perfAbortRef = useRef<AbortController | null>(null);
  const chatInFlightRef = useRef(false);
  const chatAbortRef = useRef<AbortController | null>(null);
  const msgSeqRef = useRef(0);

  const t = getCopy(language);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      briefAbortRef.current?.abort();
      analystAbortRef.current?.abort();
      perfAbortRef.current?.abort();
      chatAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = language;
    try {
      localStorage.setItem(STORAGE_LANG_KEY, language);
    } catch {
      // ignore storage errors
    }
  }, [language]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      // ignore storage errors
    }
  }, [projects]);

  const metrics = useMemo(
    () => computeOperationalMetrics(projects, employees),
    [projects, employees]
  );
  const workloads = useMemo(
    () => computeTeamWorkload(projects, employees),
    [projects, employees]
  );
  const risks = useMemo(
    () => assessProjectRisks(projects, employees),
    [projects, employees]
  );
  const rebalanceSuggestions = useMemo(
    () => generateRebalanceSuggestions(projects, employees),
    [projects, employees]
  );
  const intelligence = useMemo(
    () => computeOperationalIntelligence(projects, employees, metrics, workloads, risks),
    [projects, employees, metrics, workloads, risks]
  );

  const projectsSignature = useMemo(
    () =>
      projects
        .map(
          (p) =>
            `${p.id}:${p.status}:${p.progress}:${p.deadline}:${p.assignedEmployeeId}:${p.lastUpdated}`
        )
        .join("|"),
    [projects]
  );

  // Compact pre-calculated context builders per AI endpoint
  const dailyBriefContext = useMemo(
    () => buildDailyBriefContext(employees, metrics, risks, workloads, language, intelligence),
    [employees, metrics, risks, workloads, language, intelligence]
  );

  const analystContext = useMemo(
    () =>
      buildAnalystContext(
        employees,
        metrics,
        risks,
        workloads,
        rebalanceSuggestions,
        language,
        intelligence
      ),
    [employees, metrics, risks, workloads, rebalanceSuggestions, language, intelligence]
  );

  const perfContext = useMemo(
    () => buildPerformanceContext(projects, employees, metrics, workloads, language, intelligence),
    [projects, employees, metrics, workloads, language, intelligence]
  );

  // Latest refs for stable loadBrief callback (prevents effect re-trigger loops)
  const latestBriefParamsRef = useRef({
    language,
    projectsSignature,
    dailyBriefContext,
  });
  latestBriefParamsRef.current = { language, projectsSignature, dailyBriefContext };

  const loadBrief = useCallback(async (forceRefresh = false) => {
    const {
      language: curLang,
      projectsSignature: curSig,
      dailyBriefContext: curContext,
    } = latestBriefParamsRef.current;
    const cacheKey = `opspilot_brief_v2_${curLang}_${curSig}`;

    if (!forceRefresh) {
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
          const parsed = normalizeDailyBriefResponse(JSON.parse(cached));
          if (parsed) {
            setBriefState({
              status: "success",
              data: parsed,
              errorKind: null,
              errorMessage: null,
            });
            return;
          }
        }
      } catch {
        // ignore cache parse errors
      }
    }

    if (briefInFlightRef.current) return;
    briefInFlightRef.current = true;
    const controller = new AbortController();
    briefAbortRef.current = controller;

    setBriefState((prev) => ({
      status: "analyzing",
      data: prev.data,
      errorKind: null,
      errorMessage: null,
    }));

    try {
      const data = await fetchDailyBrief(curLang, curContext, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;

      setBriefState({
        status: "success",
        data,
        errorKind: null,
        errorMessage: null,
      });
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(data));
      } catch {
        // ignore storage quota errors
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const { kind, message } = resolveAIError(err, curLang);
      setBriefState((prev) => ({
        status: kind === "canceled" ? "canceled" : "error",
        data: prev.data,
        errorKind: kind,
        errorMessage: message,
      }));
    } finally {
      briefInFlightRef.current = false;
      if (briefAbortRef.current === controller) {
        briefAbortRef.current = null;
      }
    }
  }, []);

  const handleCancelBrief = useCallback(() => {
    briefAbortRef.current?.abort();
  }, []);

  const initialBriefFetched = useRef(false);
  const prevLangRef = useRef<Language>(language);
  const prevSigRef = useRef<string>(projectsSignature);

  useEffect(() => {
    if (!initialBriefFetched.current) {
      initialBriefFetched.current = true;
      loadBrief(false);
      return;
    }

    if (prevLangRef.current !== language) {
      prevLangRef.current = language;
      briefAbortRef.current?.abort();
      briefInFlightRef.current = false;
      analystAbortRef.current?.abort();
      analystInFlightRef.current = false;
      perfAbortRef.current?.abort();
      perfInFlightRef.current = false;
      chatAbortRef.current?.abort();
      chatInFlightRef.current = false;
      setAnalystState(createIdleState());
      setPerfState(createIdleState());
      loadBrief(false);
      return;
    }

    if (prevSigRef.current !== projectsSignature) {
      prevSigRef.current = projectsSignature;
      clearContextCache();
      analystAbortRef.current?.abort();
      analystInFlightRef.current = false;
      perfAbortRef.current?.abort();
      perfInFlightRef.current = false;
      setAnalystState(createIdleState());
      setPerfState(createIdleState());
    }
  }, [language, projectsSignature, loadBrief]);

  const handleRunAnalyst = async () => {
    if (analystInFlightRef.current) return;
    analystInFlightRef.current = true;
    const controller = new AbortController();
    analystAbortRef.current = controller;

    setAnalystState((prev) => ({
      status: "analyzing",
      data: prev.data,
      errorKind: null,
      errorMessage: null,
    }));

    try {
      const data = await fetchAnalystInsights(language, analystContext, {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;

      setAnalystState({
        status: "success",
        data,
        errorKind: null,
        errorMessage: null,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const { kind, message } = resolveAIError(err, language);
      setAnalystState((prev) => ({
        status: kind === "canceled" ? "canceled" : "error",
        data: prev.data,
        errorKind: kind,
        errorMessage: message,
      }));
    } finally {
      analystInFlightRef.current = false;
      if (analystAbortRef.current === controller) {
        analystAbortRef.current = null;
      }
    }
  };

  const handleCancelAnalyst = () => {
    analystAbortRef.current?.abort();
  };

  const handleGeneratePerfInsights = async () => {
    if (perfInFlightRef.current) return;
    perfInFlightRef.current = true;
    const controller = new AbortController();
    perfAbortRef.current = controller;

    setPerfState((prev) => ({
      status: "analyzing",
      data: prev.data,
      errorKind: null,
      errorMessage: null,
    }));

    try {
      const data = await fetchPerformanceInsights(language, perfContext, {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;

      setPerfState({
        status: "success",
        data,
        errorKind: null,
        errorMessage: null,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const { kind, message } = resolveAIError(err, language);
      setPerfState((prev) => ({
        status: kind === "canceled" ? "canceled" : "error",
        data: prev.data,
        errorKind: kind,
        errorMessage: message,
      }));
    } finally {
      perfInFlightRef.current = false;
      if (perfAbortRef.current === controller) {
        perfAbortRef.current = null;
      }
    }
  };

  const handleCancelPerfInsights = () => {
    perfAbortRef.current?.abort();
  };

  const handleStopChat = () => {
    chatAbortRef.current?.abort();
    chatInFlightRef.current = false;
    setChatLoading(false);
    setChatStage(null);
  };

  const handleSendChat = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatInFlightRef.current) return;

    chatInFlightRef.current = true;
    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    const prevUserTexts = chatMessages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    const intent = classifyChatIntent(trimmed, prevUserTexts);
    const { context } = buildTargetedChatContext(
      intent,
      {
        projects,
        employees,
        metrics,
        risks,
        workloads,
        rebalanceSuggestions,
        intelligence,
        signature: projectsSignature,
      },
      language
    );

    const seq = ++msgSeqRef.current;
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-${seq}-u`,
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    const assistantId = `msg-${Date.now()}-${seq}-a`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };

    const historyForApi = [...chatMessages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setChatMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
    setChatLoading(true);
    setChatStage(t.ask.stages[intent]);
    setChatError(null);

    let requestSettled = false;

    try {
      await streamOpsPilotChat(language, historyForApi, context, intent, {
        signal: abortController.signal,
        onMeta: () => {
          if (requestSettled || !mountedRef.current || abortController.signal.aborted) return;
          setChatStage(t.ask.stages.preparing);
        },
        onChunk: (fullText) => {
          if (requestSettled || !mountedRef.current || abortController.signal.aborted) return;
          setChatStage(null);
          setChatMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: fullText } : m))
          );
        },
      });
      requestSettled = true;
    } catch (err) {
      requestSettled = true;
      if (!mountedRef.current) return;
      const { kind, message } = resolveAIError(err, language);
      if (kind !== "canceled") {
        setChatError(message);
      }
      setChatMessages((prev) => prev.filter((m) => !(m.id === assistantId && !m.content)));
    } finally {
      requestSettled = true;
      chatInFlightRef.current = false;
      if (chatAbortRef.current === abortController) {
        chatAbortRef.current = null;
      }
      if (mountedRef.current) {
        setChatLoading(false);
        setChatStage(null);
      }
    }
  };

  const handleSaveProject = (
    projectData: Omit<Project, "id" | "lastUpdated">,
    existingId?: string
  ) => {
    const today = getTodayISO();
    if (existingId) {
      setProjects((prev) =>
        prev.map((p) => (p.id === existingId ? { ...p, ...projectData, lastUpdated: today } : p))
      );
    } else {
      const maxNum = projects.reduce((max, p) => {
        const n = Number(p.id.replace(/\D/g, ""));
        return Number.isFinite(n) ? Math.max(max, n) : max;
      }, 1050);
      const newProject: Project = {
        ...projectData,
        id: `OP-${maxNum + 1}`,
        lastUpdated: today,
      };
      setProjects((prev) => [newProject, ...prev]);
    }
    setFormModalOpen(false);
    setEditingProject(null);
  };

  const handleQuickUpdate = (id: string, patch: Partial<Project>) => {
    const today = getTodayISO();
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch, lastUpdated: today } : p))
    );
  };

  const handleConfirmDelete = () => {
    if (!deletingProject) return;
    setProjects((prev) => prev.filter((p) => p.id !== deletingProject.id));
    setDeletingProject(null);
  };

  const handleReassignProject = (projectId: string, toEmployeeId: string) => {
    handleQuickUpdate(projectId, { assignedEmployeeId: toEmployeeId });
  };

  const handleResetDemo = () => {
    briefAbortRef.current?.abort();
    analystAbortRef.current?.abort();
    perfAbortRef.current?.abort();
    chatAbortRef.current?.abort();
    const fresh = createInitialProjects();
    setProjects(fresh);
    setAnalystState(createIdleState());
    setPerfState(createIdleState());
    setChatMessages([]);
    setChatError(null);
  };

  const navItems: Array<{ id: NavSection; label: string; Icon: React.ElementType }> = [
    { id: "dashboard", label: t.nav.dashboard, Icon: LayoutDashboard },
    { id: "projects", label: t.nav.projects, Icon: FolderKanban },
    { id: "analyst", label: t.nav.analyst, Icon: ShieldAlert },
    { id: "workload", label: t.nav.workload, Icon: Users },
    { id: "performance", label: t.nav.performance, Icon: BarChart3 },
    { id: "ask", label: t.nav.ask, Icon: Bot },
    { id: "opsgraph", label: t.nav.opsgraph, Icon: Network },
  ];

  const themeOptions: Array<{ id: ThemeMode; label: string; Icon: React.ElementType }> = [
    { id: "light", label: t.topbar.themeModes.light, Icon: Sun },
    { id: "dark", label: t.topbar.themeModes.dark, Icon: Moon },
    { id: "system", label: t.topbar.themeModes.system, Icon: Monitor },
  ];

  const inspectedAssessment = inspectingProject
    ? risks.find((r) => r.project.id === inspectingProject.id)
    : undefined;
  const inspectedOwner = inspectingProject
    ? employees.find((e) => e.id === inspectingProject.assignedEmployeeId)
    : undefined;

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#0B1120] text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:shrink-0 bg-white dark:bg-[#111827] border-e border-slate-200 dark:border-slate-800">
        <div className="h-16 px-5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#0F294A] dark:bg-blue-600 text-white flex items-center justify-center shrink-0">
            <Activity className="w-4 h-4 text-blue-300 dark:text-white" />
          </div>
          <span className="text-base font-bold tracking-tight text-[#0F294A] dark:text-slate-100 whitespace-nowrap">
            {t.brand}
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? "bg-[#0F294A] dark:bg-blue-600 text-white"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
                }`}
              >
                <item.Icon
                  className={`w-4 h-4 shrink-0 ${
                    active ? "text-blue-300 dark:text-blue-100" : "text-slate-400 dark:text-slate-500"
                  }`}
                />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
          <div
            role="group"
            aria-label={t.topbar.themeLabel}
            className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80"
          >
            {themeOptions.map((opt) => {
              const selected = themeMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setThemeMode(opt.id)}
                  aria-pressed={selected}
                  className={`inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    selected
                      ? "bg-white dark:bg-[#162033] text-[#0F294A] dark:text-slate-100 shadow-xs border border-slate-200/80 dark:border-slate-700"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                  }`}
                >
                  <opt.Icon className="w-3 h-3 shrink-0" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setLanguage((prev) => (prev === "en" ? "ar" : "en"))}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-[#0F294A] dark:text-slate-200 bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
            <span>{t.topbar.languageSwitch}</span>
          </button>
          <button
            type="button"
            onClick={handleResetDemo}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t.topbar.resetDemo}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50 dark:bg-black/65"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] bg-white dark:bg-[#111827] h-full flex flex-col border-e border-slate-200 dark:border-slate-800 z-10">
            <div className="h-16 px-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-[#0F294A] dark:bg-blue-600 text-white flex items-center justify-center">
                  <Activity className="w-4 h-4 text-blue-300 dark:text-white" />
                </div>
                <span className="text-base font-bold text-[#0F294A] dark:text-slate-100">
                  {t.brand}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems.map((item) => {
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveSection(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium cursor-pointer ${
                      active
                        ? "bg-[#0F294A] dark:bg-blue-600 text-white"
                        : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
                    }`}
                  >
                    <item.Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
              <div
                role="group"
                aria-label={t.topbar.themeLabel}
                className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80"
              >
                {themeOptions.map((opt) => {
                  const selected = themeMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setThemeMode(opt.id)}
                      aria-pressed={selected}
                      className={`inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                        selected
                          ? "bg-white dark:bg-[#162033] text-[#0F294A] dark:text-slate-100 border border-slate-200/80 dark:border-slate-700"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                      }`}
                    >
                      <opt.Icon className="w-3 h-3 shrink-0" />
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => setLanguage((prev) => (prev === "en" ? "ar" : "en"))}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-[#0F294A] dark:text-slate-200 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                <Globe className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
                <span>{t.topbar.languageSwitch}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  handleResetDemo();
                  setMobileMenuOpen(false);
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t.topbar.resetDemo}</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white dark:bg-[#111827] border-b border-slate-200 dark:border-slate-800 px-4 sm:px-8 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ms-2 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-lg cursor-pointer"
              aria-label="Menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap truncate">
              <span className="font-semibold text-[#0F294A] dark:text-slate-200">{t.brand}</span>
              <span aria-hidden="true">/</span>
              <span className="text-slate-700 dark:text-slate-300 font-medium">
                {navItems.find((n) => n.id === activeSection)?.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div
              role="group"
              aria-label={t.topbar.themeLabel}
              className="hidden md:inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700"
            >
              {themeOptions.map((opt) => {
                const selected = themeMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setThemeMode(opt.id)}
                    aria-pressed={selected}
                    aria-label={`${t.topbar.themeLabel}: ${opt.label}`}
                    title={opt.label}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      selected
                        ? "bg-white dark:bg-[#162033] text-[#0F294A] dark:text-slate-100 shadow-xs border border-slate-200/80 dark:border-slate-700"
                        : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                    }`}
                  >
                    <opt.Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden xl:inline">{opt.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setLanguage((prev) => (prev === "en" ? "ar" : "en"))}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0F294A] dark:text-slate-200 bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
              <span>{t.topbar.languageSwitch}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingProject(null);
                setFormModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.topbar.addProject}</span>
            </button>
          </div>
        </header>

        <main
          className={`flex-1 w-full mx-auto ${
            activeSection === "opsgraph"
              ? "p-3 sm:p-5 max-w-[1680px]"
              : "p-4 sm:p-8 max-w-[1440px]"
          }`}
        >
          {activeSection === "dashboard" && (
            <DashboardView
              language={language}
              metrics={metrics}
              workloads={workloads}
              intelligence={intelligence}
              brief={briefState.data}
              briefStatus={briefState.status}
              briefErrorKind={briefState.errorKind}
              briefError={briefState.errorMessage}
              onRefreshBrief={() => loadBrief(true)}
              onCancelBrief={handleCancelBrief}
              onNavigate={setActiveSection}
              onInspectProject={setInspectingProject}
            />
          )}

          {activeSection === "projects" && (
            <ProjectsView
              language={language}
              projects={projects}
              employees={employees}
              onAddNew={() => {
                setEditingProject(null);
                setFormModalOpen(true);
              }}
              onEdit={(p) => {
                setEditingProject(p);
                setFormModalOpen(true);
              }}
              onInspect={setInspectingProject}
              onRequestDelete={setDeletingProject}
              onQuickUpdate={handleQuickUpdate}
            />
          )}

          {activeSection === "analyst" && (
            <AnalystView
              language={language}
              risks={risks}
              aiAnalysis={analystState.data}
              aiStatus={analystState.status}
              aiErrorKind={analystState.errorKind}
              aiError={analystState.errorMessage}
              onRunAnalysis={handleRunAnalyst}
              onCancelAnalysis={handleCancelAnalyst}
              onInspectProject={setInspectingProject}
            />
          )}

          {activeSection === "workload" && (
            <WorkloadView
              language={language}
              workloads={workloads}
              suggestions={rebalanceSuggestions}
              intelligence={intelligence}
              onReassignProject={handleReassignProject}
              onInspectProject={setInspectingProject}
            />
          )}

          {activeSection === "performance" && (
            <PerformanceView
              language={language}
              metrics={metrics}
              insights={perfState.data}
              status={perfState.status}
              errorKind={perfState.errorKind}
              error={perfState.errorMessage}
              onGenerateInsights={handleGeneratePerfInsights}
              onCancelInsights={handleCancelPerfInsights}
            />
          )}

          {activeSection === "ask" && (
            <AskOpsPilotView
              language={language}
              messages={chatMessages}
              loading={chatLoading}
              loadingStage={chatStage}
              error={chatError}
              onSendMessage={handleSendChat}
              onStopStreaming={handleStopChat}
              onClearChat={() => {
                handleStopChat();
                setChatMessages([]);
                setChatError(null);
              }}
            />
          )}

          {activeSection === "opsgraph" && (
            <ErrorBoundary
              variant="panel"
              language={language}
              fallbackTitle={t.opsgraph.errorState.title}
              fallbackDescription={t.opsgraph.errorState.description}
              fallbackRetryLabel={t.opsgraph.errorState.retry}
            >
              <OpsGraphView
                language={language}
                themeMode={themeMode}
                onSetThemeMode={setThemeMode}
                projects={projects}
                employees={employees}
                metrics={metrics}
                workloads={workloads}
                risks={risks}
                rebalanceSuggestions={rebalanceSuggestions}
                intelligence={intelligence}
                projectsSignature={projectsSignature}
                onInspectProject={setInspectingProject}
                onNavigate={setActiveSection}
              />
            </ErrorBoundary>
          )}
        </main>
      </div>

      {/* Modals */}
      <ProjectFormModal
        open={formModalOpen}
        language={language}
        employees={employees}
        initialProject={editingProject}
        onClose={() => {
          setFormModalOpen(false);
          setEditingProject(null);
        }}
        onSave={handleSaveProject}
      />

      <ProjectDetailModal
        project={inspectingProject}
        assessment={inspectedAssessment}
        owner={inspectedOwner}
        language={language}
        onClose={() => setInspectingProject(null)}
        onEdit={(p) => {
          setEditingProject(p);
          setFormModalOpen(true);
        }}
      />

      <DeleteConfirmModal
        project={deletingProject}
        language={language}
        onCancel={() => setDeletingProject(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
