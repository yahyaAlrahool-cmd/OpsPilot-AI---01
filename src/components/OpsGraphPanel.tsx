import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Building2,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FolderKanban,
  GitBranch,
  Link2Off,
  Loader2,
  Network,
  RotateCcw,
  ShieldAlert,
  Square,
  User,
  X,
} from "lucide-react";
import {
  Employee,
  EmployeeWorkloadSummary,
  Language,
  NavSection,
  NodeImpactReport,
  OperationalIntelligenceReport,
  OperationalMetrics,
  OpsGraphData,
  OpsGraphNode,
  Project,
  ProjectRiskAssessment,
  RebalanceSuggestion,
} from "../types";
import { getCopy } from "../i18n/translations";
import { EpistemicTag, RiskLevelLabel } from "./StatusIndicator";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { computeWhatIfScenario } from "../utils/opsGraph";
import { extractProjectBlocker } from "../utils/analytics";
import { buildTargetedChatContext, classifyChatIntent } from "../services/contextRetriever";
import { resolveAIError, streamOpsPilotChat } from "../services/aiService";

export type OpsGraphPanelTab = "overview" | "relationships" | "impact" | "ai" | "actions";

interface OpsGraphPanelProps {
  language: Language;
  graph: OpsGraphData;
  selectedNode: OpsGraphNode | null;
  impactReport: NodeImpactReport | null;
  traceActive: boolean;
  activeTab: OpsGraphPanelTab;
  onTabChange: (tab: OpsGraphPanelTab) => void;
  onSelectNode: (nodeId: string) => void;
  onToggleTraceImpact: () => void;
  onInspectProject: (project: Project) => void;
  onNavigate: (section: NavSection) => void;
  onCloseMobile?: () => void;
  projects: Project[];
  employees: Employee[];
  metrics: OperationalMetrics;
  workloads: EmployeeWorkloadSummary[];
  risks: ProjectRiskAssessment[];
  rebalanceSuggestions: RebalanceSuggestion[];
  intelligence: OperationalIntelligenceReport;
  projectsSignature: string;
}

export const OpsGraphPanel = React.memo(function OpsGraphPanel({
  language,
  graph,
  selectedNode,
  impactReport,
  traceActive,
  activeTab,
  onTabChange,
  onSelectNode,
  onToggleTraceImpact,
  onInspectProject,
  onNavigate,
  onCloseMobile,
  projects,
  employees,
  metrics,
  workloads,
  risks,
  rebalanceSuggestions,
  intelligence,
  projectsSignature,
}: OpsGraphPanelProps) {
  const t = getCopy(language);
  const og = t.opsgraph;

  // Isolated What-If simulation state (never mutates live projects)
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status !== "completed"),
    [projects]
  );

  const defaultSimProjectId = useMemo(() => {
    if (selectedNode?.projectId) return selectedNode.projectId;
    if (selectedNode?.employeeId) {
      const empProj = activeProjects.find((p) => p.assignedEmployeeId === selectedNode.employeeId);
      if (empProj) return empProj.id;
    }
    return rebalanceSuggestions[0]?.projectId ?? activeProjects[0]?.id ?? "";
  }, [selectedNode, activeProjects, rebalanceSuggestions]);

  const [simProjectId, setSimProjectId] = useState<string>(defaultSimProjectId);
  const [simToEmployeeId, setSimToEmployeeId] = useState<string>("");

  const resolveDefaultTargetEmployee = (projId: string): string => {
    const suggestion = rebalanceSuggestions.find((r) => r.projectId === projId);
    if (suggestion) return suggestion.toEmployeeId;
    const proj = activeProjects.find((p) => p.id === projId);
    const avail = workloads
      .filter((w) => w.employee.id !== proj?.assignedEmployeeId)
      .sort((a, b) => a.utilizationPct - b.utilizationPct)[0];
    return avail?.employee.id ?? "";
  };

  const handleSimProjectChange = (nextProjectId: string) => {
    setSimProjectId(nextProjectId);
    const nextProj = activeProjects.find((p) => p.id === nextProjectId);
    if (!simToEmployeeId || simToEmployeeId === nextProj?.assignedEmployeeId) {
      setSimToEmployeeId(resolveDefaultTargetEmployee(nextProjectId));
    }
  };

  useEffect(() => {
    setSimProjectId(defaultSimProjectId);
    setSimToEmployeeId(resolveDefaultTargetEmployee(defaultSimProjectId));
  }, [defaultSimProjectId, activeProjects, workloads, rebalanceSuggestions]);

  const scenarioResult = useMemo(() => {
    if (!simProjectId || !simToEmployeeId) return null;
    return computeWhatIfScenario(projects, employees, simProjectId, simToEmployeeId);
  }, [projects, employees, simProjectId, simToEmployeeId]);

  // Grounded OpsPilot AI panel state (reuses streamOpsPilotChat + AbortController guards)
  const [aiContent, setAiContent] = useState<string>("");
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiStage, setAiStage] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPromptTitle, setAiPromptTitle] = useState<string>("");

  const mountedRef = useRef(true);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      aiAbortRef.current?.abort();
    };
  }, []);

  // Reset AI pane output smoothly when switching to another node (never auto-fires API calls)
  useEffect(() => {
    aiAbortRef.current?.abort();
    aiInFlightRef.current = false;
    setAiLoading(false);
    setAiStage(null);
    setAiError(null);
    setAiContent("");
    setAiPromptTitle("");
  }, [selectedNode?.id, language]);

  const handleStopAi = () => {
    aiAbortRef.current?.abort();
    aiInFlightRef.current = false;
    setAiLoading(false);
    setAiStage(null);
  };

  const handleAskEntityAI = async (promptId: string, promptLabel: string) => {
    if (!selectedNode || aiInFlightRef.current) return;
    if (promptId === "trace" && !traceActive) {
      onToggleTraceImpact();
    }

    aiInFlightRef.current = true;
    const controller = new AbortController();
    aiAbortRef.current = controller;

    const entityLabel = language === "ar" ? selectedNode.labelAr : selectedNode.labelEn;
    const entityType = og.nodeSingular[selectedNode.type];
    const queryMapEn: Record<string, string> = {
      explain: `Explain the operational risk for ${entityType} "${entityLabel}" (${selectedNode.id}) using strictly confirmed workspace data.`,
      why: `Why does ${entityType} "${entityLabel}" (${selectedNode.id}) matter operationally right now?`,
      bottleneck: `What is causing the bottleneck around ${entityType} "${entityLabel}" (${selectedNode.id})? Cite recorded blockers, capacity utilization, and missing data if any.`,
      affected: `List all affected projects and downstream operational impacts connected to ${entityType} "${entityLabel}" (${selectedNode.id}).`,
      prioritize: `What should operations prioritize regarding ${entityType} "${entityLabel}" (${selectedNode.id}), and why?`,
      trace: `Trace the causal impact path (Employee -> Project -> Blocker -> Deadline -> Risk) for ${entityType} "${entityLabel}" (${selectedNode.id}).`,
    };
    const queryMapAr: Record<string, string> = {
      explain: `اشرح المخاطر التشغيلية المرتبطة بـ ${entityType} "${entityLabel}" (${selectedNode.id}) بالاعتماد حصرياً على بيانات مساحة العمل المؤكدة.`,
      why: `لماذا يهم ${entityType} "${entityLabel}" (${selectedNode.id}) تشغيلياً في الوقت الحالي؟`,
      bottleneck: `ما سبب الاختناق المرتبط بـ ${entityType} "${entityLabel}" (${selectedNode.id})؟ اذكر العوائق المسجلة وضغط الإشغال وأي نقص في البيانات.`,
      affected: `اعرض جميع المشاريع المتأثرة والنتائج التشغيلية المرتبطة بـ ${entityType} "${entityLabel}" (${selectedNode.id}).`,
      prioritize: `ما الإجراءات التي يجب إعطاؤها الأولوية بخصوص ${entityType} "${entityLabel}" (${selectedNode.id}) ولماذا؟`,
      trace: `تتبع مسار الأثر السببي (المسؤول -> المشروع -> العائق -> الموعد -> المخاطر) للكيان ${entityType} "${entityLabel}" (${selectedNode.id}).`,
    };

    const promptText =
      (language === "ar" ? queryMapAr[promptId] : queryMapEn[promptId]) ?? promptLabel;

    const intent = classifyChatIntent(promptText, []);
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

    const enrichedContext = {
      ...(context ?? {}),
      opsGraphFocus: {
        nodeId: selectedNode.id,
        nodeType: selectedNode.type,
        label: entityLabel,
        summary: language === "ar" ? selectedNode.subtitleAr : selectedNode.subtitleEn,
        impactSummary: impactReport
          ? language === "ar"
            ? impactReport.summaryAr
            : impactReport.summaryEn
          : undefined,
        affectedProjectIds: impactReport?.affectedProjects.map((a) => a.project.id) ?? [],
      },
    };

    setAiPromptTitle(promptLabel);
    setAiLoading(true);
    setAiStage(t.ask.stages[intent]);
    setAiError(null);
    setAiContent("");

    let settled = false;

    try {
      await streamOpsPilotChat(
        language,
        [{ role: "user", content: promptText }],
        enrichedContext,
        intent,
        {
          signal: controller.signal,
          onMeta: () => {
            if (settled || !mountedRef.current || controller.signal.aborted) return;
            setAiStage(t.ask.stages.preparing);
          },
          onChunk: (fullText) => {
            if (settled || !mountedRef.current || controller.signal.aborted) return;
            setAiStage(null);
            setAiContent(fullText);
          },
        }
      );
      settled = true;
    } catch (err) {
      settled = true;
      if (!mountedRef.current) return;
      const { kind, message } = resolveAIError(err, language);
      if (kind !== "canceled") {
        setAiError(message);
      }
    } finally {
      settled = true;
      aiInFlightRef.current = false;
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      if (mountedRef.current) {
        setAiLoading(false);
        setAiStage(null);
      }
    }
  };

  if (!selectedNode) {
    return (
      <aside className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col items-center justify-center text-center min-h-[340px]">
        <Network className="w-8 h-8 text-blue-600 dark:text-blue-400 mb-3" />
        <p className="text-sm font-semibold text-[#0F294A] dark:text-slate-100">
          {og.title}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">
          {og.subtitle}
        </p>
      </aside>
    );
  }

  // Resolve exact grounded records for selected node
  const selectedProject = selectedNode.projectId
    ? projects.find((p) => p.id === selectedNode.projectId)
    : undefined;
  const selectedRisk = selectedProject
    ? risks.find((r) => r.project.id === selectedProject.id)
    : undefined;
  const selectedEmployee = selectedNode.employeeId
    ? employees.find((e) => e.id === selectedNode.employeeId)
    : selectedProject
    ? employees.find((e) => e.id === selectedProject.assignedEmployeeId)
    : undefined;
  const selectedOwnerLoad = selectedEmployee
    ? workloads.find((w) => w.employee.id === selectedEmployee.id)
    : undefined;
  const selectedBlocker = selectedProject ? extractProjectBlocker(selectedProject) : null;

  // Connected nodes grouped for Relationships tab
  const neighborNodes = Array.from(graph.adjacency.get(selectedNode.id) ?? [])
    .map((id) => graph.nodeMap.get(id))
    .filter((n): n is OpsGraphNode => Boolean(n));

  const relatedPatterns = intelligence.proactiveInsights.filter((ins) => {
    const scopeText = `${ins.evidenceEn} ${ins.detailEn}`.toLowerCase();
    if (selectedProject && scopeText.includes(selectedProject.id.toLowerCase())) return true;
    if (selectedEmployee && scopeText.includes(selectedEmployee.name.toLowerCase())) return true;
    if (selectedNode.type === "deadline" && ins.kind === "deadline_collision") return true;
    if (selectedNode.type === "blocker" && ins.kind === "blockers") return true;
    if (selectedNode.type === "risk" && ins.kind === "concentration") return true;
    return false;
  });

  // Grounded Action Cards for Actions Tab
  const actionCards = (() => {
    const cards: Array<{
      id: string;
      priority: string;
      priorityLevel: "critical" | "high" | "medium" | "low";
      action: string;
      reason: string;
      affected: Array<{ id: string; label: string }>;
      expectedImpact: string;
      isAIRecommendation: boolean;
    }> = [];

    if (selectedRisk && selectedProject) {
      const matchingRebalance = rebalanceSuggestions.find(
        (r) => r.projectId === selectedProject.id
      );
      cards.push({
        id: `act-${selectedProject.id}`,
        priority: t.riskLevels[selectedRisk.riskLevel],
        priorityLevel: selectedRisk.riskLevel,
        action:
          language === "ar"
            ? selectedRisk.recommendedActionAr
            : selectedRisk.recommendedActionEn,
        reason:
          language === "ar" ? selectedRisk.observationAr : selectedRisk.observationEn,
        affected: [
          { id: selectedProject.id, label: selectedProject.id },
          ...(selectedEmployee
            ? [
                {
                  id: `emp:${selectedEmployee.id}`,
                  label: language === "ar" ? selectedEmployee.nameAr : selectedEmployee.name,
                },
              ]
            : []),
        ],
        expectedImpact:
          language === "ar" ? selectedRisk.impactAr : selectedRisk.impactEn,
        isAIRecommendation: true,
      });

      if (matchingRebalance) {
        cards.push({
          id: `reb-${matchingRebalance.projectId}`,
          priority: t.riskLevels.high,
          priorityLevel: "high",
          action:
            language === "ar"
              ? `إعادة إسناد ${matchingRebalance.projectId} إلى ${matchingRebalance.toEmployeeNameAr}`
              : `Reassign ${matchingRebalance.projectId} to ${matchingRebalance.toEmployeeName}`,
          reason:
            language === "ar" ? matchingRebalance.reasonAr : matchingRebalance.reasonEn,
          affected: [
            { id: matchingRebalance.projectId, label: matchingRebalance.projectId },
            {
              id: `emp:${matchingRebalance.fromEmployeeId}`,
              label:
                language === "ar"
                  ? matchingRebalance.fromEmployeeNameAr
                  : matchingRebalance.fromEmployeeName,
            },
          ],
          expectedImpact:
            language === "ar"
              ? `نقل ${matchingRebalance.hoursMoved} ساعة عمل متبقية لتخفيف الضغط`
              : `Shifts ${matchingRebalance.hoursMoved}h of remaining workload to reduce overload`,
          isAIRecommendation: true,
        });
      }
    } else if (impactReport && impactReport.affectedProjects.length > 0) {
      for (const ap of impactReport.affectedProjects.slice(0, 3)) {
        const r = risks.find((rk) => rk.project.id === ap.project.id);
        if (!r) continue;
        cards.push({
          id: `act-imp-${ap.project.id}`,
          priority: t.riskLevels[r.riskLevel],
          priorityLevel: r.riskLevel,
          action: language === "ar" ? r.recommendedActionAr : r.recommendedActionEn,
          reason: language === "ar" ? r.observationAr : r.observationEn,
          affected: [{ id: ap.project.id, label: ap.project.id }],
          expectedImpact: language === "ar" ? r.impactAr : r.impactEn,
          isAIRecommendation: true,
        });
      }
    }

    return cards;
  })();

  const tabs: Array<{ id: OpsGraphPanelTab; label: string }> = [
    { id: "overview", label: og.tabs.overview },
    { id: "relationships", label: og.tabs.relationships },
    { id: "impact", label: og.tabs.impact },
    { id: "ai", label: og.tabs.ai },
    { id: "actions", label: og.tabs.actions },
  ];

  const formatDeadlineText = (days: number) => {
    if (days < 0) return `${Math.abs(days)} ${og.labels.daysOverdue}`;
    if (days === 0) return og.labels.dueToday;
    return `${days} ${og.labels.daysRemaining}`;
  };

  return (
    <aside className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col overflow-hidden h-full">
      {/* Panel Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{og.nodeSingular[selectedNode.type]}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num">{selectedNode.id}</span>
            </div>
            <h2 className="text-base font-bold text-[#0F294A] dark:text-slate-100 mt-0.5 truncate">
              {selectedProject
                ? `${selectedProject.id} · ${
                    language === "ar"
                      ? selectedProject.titleAr || selectedProject.title
                      : selectedProject.title
                  }`
                : language === "ar"
                ? selectedNode.labelAr
                : selectedNode.labelEn}
            </h2>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {selectedRisk && (
              <RiskLevelLabel
                level={selectedRisk.riskLevel}
                label={t.riskLevels[selectedRisk.riskLevel]}
              />
            )}
            {onCloseMobile && (
              <button
                type="button"
                onClick={onCloseMobile}
                className="lg:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label={og.actions.closePanel}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Action Bar: Trace Impact & Full Inspect */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggleTraceImpact}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              traceActive
                ? "bg-blue-600 text-white"
                : "bg-[#0F294A] dark:bg-blue-600/90 text-white hover:bg-[#173964] dark:hover:bg-blue-500"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{traceActive ? og.actions.clearTrace : og.actions.traceImpact}</span>
          </button>

          {selectedProject && (
            <button
              type="button"
              onClick={() => onInspectProject(selectedProject)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors whitespace-nowrap cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>{og.actions.inspectProject}</span>
            </button>
          )}
        </div>

        {/* 5 Tabs */}
        <div
          role="tablist"
          aria-label={og.title}
          className="grid grid-cols-5 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80"
        >
          {tabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => onTabChange(tab.id)}
                className={`px-1.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors truncate cursor-pointer ${
                  active
                    ? "bg-white dark:bg-[#162033] text-[#0F294A] dark:text-slate-100 shadow-xs border border-slate-200/80 dark:border-slate-700"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* TAB 1: OVERVIEW */}
        {activeTab === "overview" && (
          <div className="space-y-4">
            {selectedProject && selectedRisk ? (
              <>
                {/* Calculated Risk Gauge Summary */}
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#162033]">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {og.labels.riskScore}
                    </span>
                    <EpistemicTag kind="calculated" label={t.epistemic.calculatedMetric} />
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono-num text-[#0F294A] dark:text-slate-100">
                      {selectedRisk.riskScore}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">/ 100</span>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      — {t.riskLevels[selectedRisk.riskLevel]}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        selectedRisk.riskLevel === "critical"
                          ? "bg-red-600"
                          : selectedRisk.riskLevel === "high"
                          ? "bg-amber-500"
                          : "bg-blue-600"
                      }`}
                      style={{ width: `${selectedRisk.riskScore}%` }}
                    />
                  </div>
                </div>

                {/* Confirmed Record Fields */}
                <div className="space-y-2">
                  <EpistemicTag kind="confirmed" label={t.epistemic.confirmedData} />
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() =>
                        selectedEmployee && onSelectNode(`emp:${selectedEmployee.id}`)
                      }
                      className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60 text-start hover:border-blue-400 cursor-pointer"
                    >
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {og.labels.owner}
                      </div>
                      <div className="text-xs font-semibold text-[#0F294A] dark:text-slate-100 mt-0.5 truncate">
                        {selectedEmployee
                          ? language === "ar"
                            ? selectedEmployee.nameAr
                            : selectedEmployee.name
                          : "—"}
                      </div>
                    </button>

                    <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {og.labels.utilization}
                      </div>
                      <div
                        className={`text-xs font-bold font-mono-num mt-0.5 ${
                          (selectedOwnerLoad?.utilizationPct ?? 0) >= 105
                            ? "text-red-700 dark:text-red-400"
                            : "text-[#0F294A] dark:text-slate-100"
                        }`}
                      >
                        {selectedOwnerLoad ? `${selectedOwnerLoad.utilizationPct}%` : "—"}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onSelectNode(`cust:${selectedProject.clientName}`)}
                      className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60 text-start hover:border-blue-400 cursor-pointer"
                    >
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {og.labels.customer}
                      </div>
                      <div className="text-xs font-semibold text-[#0F294A] dark:text-slate-100 mt-0.5 truncate">
                        {language === "ar"
                          ? selectedProject.clientNameAr || selectedProject.clientName
                          : selectedProject.clientName}
                      </div>
                    </button>

                    <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {og.labels.deadline}
                      </div>
                      <div
                        className={`text-xs font-semibold font-mono-num mt-0.5 ${
                          selectedRisk.daysUntilDeadline < 0
                            ? "text-red-700 dark:text-red-400"
                            : selectedRisk.daysUntilDeadline <= 5
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-[#0F294A] dark:text-slate-100"
                        }`}
                      >
                        {formatDeadlineText(selectedRisk.daysUntilDeadline)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Primary Blocker */}
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60 space-y-1">
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    {og.labels.primaryBlocker}
                  </div>
                  <p
                    className={`text-xs leading-relaxed ${
                      selectedBlocker?.hasRecordedBlocker
                        ? "text-slate-800 dark:text-slate-200"
                        : "text-amber-700 dark:text-amber-300 font-medium"
                    }`}
                  >
                    {selectedBlocker?.hasRecordedBlocker
                      ? language === "ar"
                        ? selectedBlocker.ar
                        : selectedBlocker.en
                      : og.labels.visibilityGap}
                  </p>
                </div>

                {/* Why is this critical? (strictly grounded explanation + clearly labeled recommendation) */}
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#162033] space-y-2.5">
                  <div className="text-xs font-bold text-[#0F294A] dark:text-slate-100">
                    {og.labels.whyCritical}
                  </div>
                  <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                    {impactReport
                      ? language === "ar"
                        ? impactReport.summaryAr
                        : impactReport.summaryEn
                      : language === "ar"
                      ? selectedRisk.observationAr
                      : selectedRisk.observationEn}
                  </p>
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700/80 space-y-1">
                    <EpistemicTag kind="recommendation" label={t.epistemic.aiRecommendation} />
                    <p className="text-xs text-[#0F294A] dark:text-blue-200 leading-relaxed">
                      {language === "ar"
                        ? selectedRisk.recommendedActionAr
                        : selectedRisk.recommendedActionEn}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              /* Non-project entity Overview (Employee, Customer, Blocker, Deadline, Risk) */
              <div className="space-y-4">
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#162033] space-y-2">
                  <EpistemicTag kind="calculated" label={t.epistemic.calculatedMetric} />
                  <div className="text-sm font-semibold text-[#0F294A] dark:text-slate-100">
                    {language === "ar" ? selectedNode.subtitleAr : selectedNode.subtitleEn}
                  </div>
                  {impactReport && (
                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                      {language === "ar" ? impactReport.summaryAr : impactReport.summaryEn}
                    </p>
                  )}
                </div>

                {selectedEmployee && selectedOwnerLoad && (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {og.labels.utilization}
                      </div>
                      <div className="text-sm font-bold font-mono-num text-[#0F294A] dark:text-slate-100 mt-0.5">
                        {selectedOwnerLoad.utilizationPct}%
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {t.workload.activeHours}
                      </div>
                      <div className="text-sm font-bold font-mono-num text-[#0F294A] dark:text-slate-100 mt-0.5">
                        {selectedOwnerLoad.activeWorkloadHours}h /{" "}
                        {selectedEmployee.weeklyCapacityHours}h
                      </div>
                    </div>
                  </div>
                )}

                {impactReport && impactReport.affectedProjects.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#0F294A] dark:text-slate-100">
                        {og.labels.affectedProjects}
                      </span>
                      <EpistemicTag kind="confirmed" label={t.epistemic.confirmedData} />
                    </div>
                    <div className="space-y-1.5">
                      {impactReport.affectedProjects.map((ap) => (
                        <button
                          key={ap.project.id}
                          type="button"
                          onClick={() => onSelectNode(ap.project.id)}
                          className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/60 hover:border-blue-400 text-start flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-[#0F294A] dark:text-slate-100 truncate">
                              {ap.project.id} ·{" "}
                              {language === "ar"
                                ? ap.project.titleAr || ap.project.title
                                : ap.project.title}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-num mt-0.5">
                              {formatDeadlineText(ap.daysUntilDeadline)} · {ap.remainingHours}
                              {og.labels.hoursRemaining}
                            </div>
                          </div>
                          <RiskLevelLabel
                            level={ap.riskLevel}
                            label={`${ap.riskScore}`}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: RELATIONSHIPS (Visual Branched Relationship Tree) */}
        {activeTab === "relationships" && (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-semibold text-[#0F294A] dark:text-slate-100 mb-2">
                {og.labels.connectedEntities}
              </div>

              {/* Visual Root Node */}
              <div className="p-2.5 rounded-lg border border-blue-500/60 bg-blue-50/70 dark:bg-[#162033] text-xs font-bold text-[#0F294A] dark:text-slate-100 flex items-center justify-between">
                <span className="truncate">
                  {language === "ar" ? selectedNode.labelAr : selectedNode.labelEn}
                </span>
                <span className="text-[11px] font-mono-num text-blue-700 dark:text-blue-300">
                  {neighborNodes.length} {og.labels.edgesCount}
                </span>
              </div>

              {/* Visual Tree Branches */}
              <div className="ms-3 ps-3.5 border-s border-slate-300 dark:border-slate-700 mt-2 space-y-2">
                {neighborNodes.map((nbr) => {
                  const isMissing = nbr.hasVisibilityGap;
                  const NbrIcon =
                    nbr.type === "employee"
                      ? User
                      : nbr.type === "customer"
                      ? Building2
                      : nbr.type === "blocker"
                      ? Link2Off
                      : nbr.type === "deadline"
                      ? CalendarClock
                      : nbr.type === "risk"
                      ? AlertTriangle
                      : FolderKanban;

                  return (
                    <div key={nbr.id} className="relative">
                      <span
                        aria-hidden="true"
                        className="absolute -start-3.5 top-4 w-3 h-px bg-slate-300 dark:bg-slate-700"
                      />
                      <button
                        type="button"
                        onClick={() => onSelectNode(nbr.id)}
                        className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/70 hover:border-blue-500/70 text-start transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <NbrIcon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                            <span className="text-xs font-semibold text-[#0F294A] dark:text-slate-100 truncate">
                              {language === "ar" ? nbr.labelAr : nbr.labelEn}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 shrink-0">
                            {og.nodeSingular[nbr.type]}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 font-mono-num truncate">
                          {language === "ar" ? nbr.subtitleAr : nbr.subtitleEn}
                        </div>
                        {isMissing && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
                            {og.labels.visibilityGap}
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}

                {/* Explicit visibility-gap branch for projects missing blocker notes */}
                {selectedProject && selectedBlocker && !selectedBlocker.hasRecordedBlocker && (
                  <div className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -start-3.5 top-4 w-3 h-px bg-slate-300 dark:bg-slate-700"
                    />
                    <div className="p-2.5 rounded-lg border border-amber-300/70 dark:border-amber-800/70 bg-amber-50/50 dark:bg-amber-950/25 text-xs">
                      <div className="font-semibold text-amber-800 dark:text-amber-300">
                        {og.labels.primaryBlocker}
                      </div>
                      <div className="text-[11px] text-amber-700 dark:text-amber-200 mt-0.5">
                        {og.labels.visibilityGap}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Related Operational Patterns */}
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <div className="text-xs font-semibold text-[#0F294A] dark:text-slate-100">
                {og.labels.operationalPatterns}
              </div>
              {relatedPatterns.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {og.labels.noRecordedPatterns}
                </p>
              ) : (
                relatedPatterns.map((pat) => (
                  <div
                    key={pat.id}
                    className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#162033] space-y-1"
                  >
                    <div className="text-xs font-semibold text-[#0F294A] dark:text-slate-100">
                      {language === "ar" ? pat.titleAr : pat.titleEn}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                      {language === "ar" ? pat.detailAr : pat.detailEn}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TAB 3: IMPACT ANALYSIS + ISOLATED WHAT-IF SCENARIO */}
        {activeTab === "impact" && (
          <div className="space-y-4">
            {impactReport && (
              <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#162033] space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[#0F294A] dark:text-slate-100">
                    {og.labels.operationalImpact}
                  </span>
                  <EpistemicTag kind="calculated" label={t.epistemic.calculatedMetric} />
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {language === "ar" ? impactReport.summaryAr : impactReport.summaryEn}
                </p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded bg-white dark:bg-[#0B1120]/70 border border-slate-200 dark:border-slate-800">
                    <div className="text-sm font-bold font-mono-num text-[#0F294A] dark:text-slate-100">
                      {impactReport.affectedProjects.length}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      {og.nodeTypes.project}
                    </div>
                  </div>
                  <div className="p-2 rounded bg-white dark:bg-[#0B1120]/70 border border-slate-200 dark:border-slate-800">
                    <div className="text-sm font-bold font-mono-num text-red-700 dark:text-red-400">
                      {impactReport.highOrCriticalCount}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      {t.riskLevels.critical}/{t.riskLevels.high}
                    </div>
                  </div>
                  <div className="p-2 rounded bg-white dark:bg-[#0B1120]/70 border border-slate-200 dark:border-slate-800">
                    <div className="text-sm font-bold font-mono-num text-[#0F294A] dark:text-slate-100">
                      {impactReport.totalRemainingHours}h
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      {t.workload.activeHours}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* What-If Scenario Simulation (Isolated, Never Mutates Live Projects) */}
            <div className="p-3.5 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-white dark:bg-[#0B1120]/60 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold text-[#0F294A] dark:text-slate-100">
                  {og.labels.whatIfTitle}
                </div>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                  {og.labels.scenarioBadge}
                </span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                {og.labels.scenarioHint}
              </p>

              <div className="grid grid-cols-1 gap-2">
                <label className="block text-[11px] text-slate-600 dark:text-slate-300">
                  <span className="font-medium block mb-1">{og.labels.selectProjectToMove}</span>
                  <select
                    value={simProjectId}
                    onChange={(e) => handleSimProjectChange(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#111827] text-xs text-slate-900 dark:text-slate-100"
                  >
                    {activeProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} — {language === "ar" ? p.titleAr || p.title : p.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-[11px] text-slate-600 dark:text-slate-300">
                  <span className="font-medium block mb-1">{og.labels.selectTargetOwner}</span>
                  <select
                    value={simToEmployeeId}
                    onChange={(e) => setSimToEmployeeId(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#111827] text-xs text-slate-900 dark:text-slate-100"
                  >
                    {workloads
                      .filter(
                        (w) =>
                          w.employee.id !==
                          activeProjects.find((p) => p.id === simProjectId)?.assignedEmployeeId
                      )
                      .map((w) => (
                        <option key={w.employee.id} value={w.employee.id}>
                          {language === "ar" ? w.employee.nameAr : w.employee.name} (
                          {w.utilizationPct}%)
                        </option>
                      ))}
                  </select>
                </label>
              </div>

              {scenarioResult && (
                <div className="space-y-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827]">
                      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                        {og.labels.currentState}
                      </div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 mt-1">
                        {language === "ar"
                          ? scenarioResult.fromEmployeeNameAr
                          : scenarioResult.fromEmployeeName}
                        :{" "}
                        <span className="font-mono-num text-red-700 dark:text-red-400">
                          {scenarioResult.before.fromUtilizationPct}%
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-400 font-mono-num mt-0.5">
                        {og.labels.riskScore}: {scenarioResult.before.projectRiskScore}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/40 dark:bg-emerald-950/25">
                      <div className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        {og.labels.simulatedState}
                      </div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 mt-1">
                        {language === "ar"
                          ? scenarioResult.fromEmployeeNameAr
                          : scenarioResult.fromEmployeeName}
                        :{" "}
                        <span className="font-mono-num text-emerald-700 dark:text-emerald-300">
                          {scenarioResult.after.fromUtilizationPct}%
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-700 dark:text-slate-300 font-mono-num mt-0.5">
                        {og.labels.riskScore}: {scenarioResult.after.projectRiskScore} (
                        {language === "ar"
                          ? scenarioResult.toEmployeeNameAr
                          : scenarioResult.toEmployeeName}
                        : {scenarioResult.after.toUtilizationPct}%)
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span
                      className={
                        scenarioResult.skillMatch
                          ? "text-emerald-700 dark:text-emerald-300 font-medium"
                          : "text-amber-700 dark:text-amber-300 font-medium"
                      }
                    >
                      {scenarioResult.skillMatch
                        ? og.labels.verifiedSkill
                        : og.labels.unverifiedSkill}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSimProjectId(defaultSimProjectId);
                        setSimToEmployeeId(resolveDefaultTargetEmployee(defaultSimProjectId));
                      }}
                      className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>{og.labels.resetScenario}</span>
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {og.labels.noMutationNote}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: AI ANALYSIS (Uses Existing OpsPilot AI Streaming & Grounded Context) */}
        {activeTab === "ai" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-[#0F294A] dark:text-slate-100">
                {og.labels.askPromptLabel}
              </div>
              <EpistemicTag kind="prediction" label={t.epistemic.aiSynthesis} />
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {og.aiPrompts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={aiLoading}
                  onClick={() => handleAskEntityAI(p.id, p.label)}
                  className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#162033] hover:border-blue-500/70 text-[11px] font-medium text-[#0F294A] dark:text-slate-200 text-start disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {aiLoading && (
              <div className="p-3 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50/60 dark:bg-blue-950/30 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-blue-800 dark:text-blue-200">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>{aiStage ?? t.ask.thinking}</span>
                </div>
                <button
                  type="button"
                  onClick={handleStopAi}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 cursor-pointer"
                >
                  <Square className="w-3 h-3" />
                  <span>{og.labels.stopAi}</span>
                </button>
              </div>
            )}

            {aiError && (
              <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/30 text-xs text-red-800 dark:text-red-300 space-y-2">
                <p>{aiError}</p>
                <button
                  type="button"
                  onClick={() => handleAskEntityAI("explain", og.aiPrompts[0].label)}
                  className="px-2.5 py-1 rounded bg-white dark:bg-slate-800 border border-red-200 dark:border-red-800 text-xs font-semibold cursor-pointer"
                >
                  {og.labels.retryAi}
                </button>
              </div>
            )}

            {aiContent && (
              <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]/70 space-y-2">
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                  <span className="text-[11px] font-semibold text-[#0F294A] dark:text-slate-200 flex items-center gap-1.5">
                    <Bot className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>{aiPromptTitle || og.tabs.ai}</span>
                  </span>
                  <EpistemicTag kind="recommendation" label={t.epistemic.aiRecommendation} />
                </div>
                <MarkdownRenderer content={aiContent} />
              </div>
            )}
          </div>
        )}

        {/* TAB 5: ACTIONS */}
        {activeTab === "actions" && (
          <div className="space-y-3">
            {actionCards.length === 0 ? (
              <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#162033] text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>{t.dashboard.alerts.noAlerts}</span>
              </div>
            ) : (
              actionCards.map((card) => (
                <div
                  key={card.id}
                  className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#162033] space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <EpistemicTag kind="recommendation" label={t.epistemic.aiRecommendation} />
                    <RiskLevelLabel
                      level={card.priorityLevel}
                      label={`${og.labels.priorityLabel}: ${card.priority}`}
                    />
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {og.labels.recommendedAction}
                    </div>
                    <p className="text-xs font-semibold text-[#0F294A] dark:text-slate-100 mt-0.5 leading-relaxed">
                      {card.action}
                    </p>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {og.labels.reasonLabel}
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 leading-relaxed">
                      {card.reason}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {og.labels.affectedEntitiesLabel}:
                    </span>
                    {card.affected.map((aff) => (
                      <button
                        key={aff.id}
                        type="button"
                        onClick={() => onSelectNode(aff.id)}
                        className="text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:underline cursor-pointer"
                      >
                        {aff.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-800">
                    <span className="font-medium">{og.labels.expectedImpactLabel}: </span>
                    {card.expectedImpact}
                  </div>
                </div>
              ))
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => onNavigate("workload")}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B1120] hover:border-blue-500 text-xs font-medium text-[#0F294A] dark:text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>{og.actions.openWorkload}</span>
                <ArrowRight className="w-3.5 h-3.5 rtl:rotate-180" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate("analyst")}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B1120] hover:border-blue-500 text-xs font-medium text-[#0F294A] dark:text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>{og.actions.openAnalyst}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
});
