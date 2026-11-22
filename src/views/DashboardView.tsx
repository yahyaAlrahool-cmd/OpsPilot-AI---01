import React from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  FolderKanban,
  Layers,
  RefreshCw,
  Sparkles,
  TimerOff,
  TrendingUp,
  XCircle,
} from "lucide-react";
import {
  AIErrorKind,
  AIRequestStatus,
  DailyBriefResponse,
  EmployeeWorkloadSummary,
  Language,
  NavSection,
  OperationalMetrics,
  Project,
  ProjectRiskAssessment,
} from "../types";
import { getCopy } from "../i18n/translations";
import {
  CompletionTrendChart,
  StatusDistributionChart,
  TeamWorkloadChart,
} from "../components/Charts";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { EpistemicTag, RiskLevelLabel } from "../components/StatusIndicator";
import { METRIC_FORMULAS } from "../utils/analytics";

interface DashboardViewProps {
  language: Language;
  metrics: OperationalMetrics;
  workloads: EmployeeWorkloadSummary[];
  risks: ProjectRiskAssessment[];
  brief: DailyBriefResponse | null;
  briefStatus: AIRequestStatus;
  briefErrorKind: AIErrorKind | null;
  briefError: string | null;
  onRefreshBrief: () => void;
  onCancelBrief: () => void;
  onNavigate: (section: NavSection) => void;
  onInspectProject: (project: Project) => void;
}

export function DashboardView({
  language,
  metrics,
  workloads,
  risks,
  brief,
  briefStatus,
  briefErrorKind,
  briefError,
  onRefreshBrief,
  onCancelBrief,
  onNavigate,
  onInspectProject,
}: DashboardViewProps) {
  const t = getCopy(language);
  const formulas = METRIC_FORMULAS[language];
  const topAlerts = risks.filter((r) => r.riskScore >= 25).slice(0, 5);
  const isAnalyzing = briefStatus === "analyzing";

  const kpiCards = [
    {
      label: t.dashboard.kpi.totalOrders,
      value: metrics.totalOrders,
      Icon: Layers,
      accent: "text-[#0F294A]",
      sub: t.epistemic.confirmedData,
      formula: "",
    },
    {
      label: t.dashboard.kpi.activeProjects,
      value: metrics.activeProjects,
      Icon: FolderKanban,
      accent: "text-blue-700",
      sub: t.epistemic.calculatedMetric,
      formula: formulas.activeProjects,
    },
    {
      label: t.dashboard.kpi.completedProjects,
      value: metrics.completedProjects,
      Icon: CheckCircle2,
      accent: "text-emerald-700",
      sub: t.epistemic.confirmedData,
      formula: "",
    },
    {
      label: t.dashboard.kpi.overdueProjects,
      value: metrics.overdueProjects,
      Icon: TimerOff,
      accent: metrics.overdueProjects > 0 ? "text-red-700" : "text-slate-700",
      sub: t.epistemic.calculatedMetric,
      formula: formulas.overdueProjects,
    },
    {
      label: t.dashboard.kpi.atRiskProjects,
      value: metrics.atRiskProjects,
      Icon: AlertTriangle,
      accent: metrics.atRiskProjects > 0 ? "text-amber-700" : "text-slate-700",
      sub: t.epistemic.calculatedMetric,
      formula: formulas.atRiskProjects,
    },
    {
      label: t.dashboard.kpi.completionRate,
      value: `${metrics.completionRate}%`,
      Icon: TrendingUp,
      accent: "text-blue-800",
      sub: `${metrics.completedProjects}/${metrics.totalOrders}`,
      formula: formulas.completionRate,
    },
  ];

  const attentionList = Array.isArray(brief?.attentionToday) ? brief.attentionToday : [];
  const prioritiesList = Array.isArray(brief?.recommendedPriorities)
    ? brief.recommendedPriorities
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0F294A]">{t.dashboard.title}</h1>
          <p className="text-sm text-slate-500 mt-1">{t.dashboard.subtitle}</p>
        </div>
      </div>

      {/* KPI Grid */}
      <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {kpiCards.map((kpi) => (
          <div
            key={kpi.label}
            title={kpi.formula || undefined}
            className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500 leading-snug">{kpi.label}</span>
              <kpi.Icon className={`w-4 h-4 shrink-0 ${kpi.accent}`} />
            </div>
            <div>
              <div className={`text-2xl font-bold font-mono-num ${kpi.accent}`}>{kpi.value}</div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono-num">{kpi.sub}</div>
            </div>
          </div>
        ))}
      </section>

      {/* AI Daily Brief */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 bg-[#0F294A] text-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-4 h-4 text-blue-300 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">{t.dashboard.brief.title}</h2>
              <p className="text-xs text-slate-300">{t.dashboard.brief.subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isAnalyzing && (
              <button
                type="button"
                onClick={onCancelBrief}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600 transition-colors whitespace-nowrap cursor-pointer"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>{t.aiStates.cancel}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onRefreshBrief}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isAnalyzing ? "animate-spin" : ""}`} />
              <span>{brief ? t.dashboard.brief.refresh : t.dashboard.brief.generate}</span>
            </button>
          </div>
        </div>

        <div className="p-6">
          <ErrorBoundary variant="panel" language={language} onRetry={onRefreshBrief}>
            {briefStatus === "analyzing" ? (
              <div className="space-y-4 animate-pulse">
                <div className="h-4 bg-slate-100 rounded w-3/4" />
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
                  <div className="h-24 bg-slate-100 rounded-lg" />
                  <div className="h-24 bg-slate-100 rounded-lg" />
                  <div className="h-24 bg-slate-100 rounded-lg" />
                </div>
                <p className="text-xs text-slate-500">{t.dashboard.brief.generating}</p>
              </div>
            ) : briefStatus === "canceled" ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4">
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{briefError || t.aiStates.canceledMessage}</span>
                </div>
                <button
                  type="button"
                  onClick={onRefreshBrief}
                  className="px-3 py-1.5 text-xs font-medium bg-white border border-amber-300 rounded-md text-amber-800 hover:bg-amber-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {t.aiStates.retry}
                </button>
              </div>
            ) : briefStatus === "error" ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-4">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    {briefError ||
                      (briefErrorKind === "timeout"
                        ? t.aiStates.timeoutMessage
                        : t.aiStates.errorMessage)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onRefreshBrief}
                  className="px-3 py-1.5 text-xs font-medium bg-white border border-red-200 rounded-md text-red-700 hover:bg-red-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {t.aiStates.retry}
                </button>
              </div>
            ) : brief ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 divide-y lg:divide-y-0 lg:divide-x lg:rtl:divide-x-reverse divide-slate-100">
                  <div className="space-y-1.5 pt-2 lg:pt-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500">
                        {t.dashboard.brief.overallStatus}
                      </span>
                      <EpistemicTag kind="calculated" label={t.epistemic.aiSynthesis} />
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed">{brief.overallStatus}</p>
                  </div>

                  <div className="space-y-1.5 pt-4 lg:pt-0 lg:ps-6">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-red-700">
                        {t.dashboard.brief.mostUrgent}
                      </span>
                      <EpistemicTag kind="confirmed" label={t.epistemic.confirmedData} />
                    </div>
                    <p className="text-sm text-slate-900 font-medium leading-relaxed">
                      {brief.mostUrgentIssue}
                    </p>
                  </div>

                  <div className="space-y-1.5 pt-4 lg:pt-0 lg:ps-6">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500">
                        {t.dashboard.brief.workloadConcerns}
                      </span>
                      <EpistemicTag kind="calculated" label={t.epistemic.calculatedMetric} />
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed">{brief.workloadConcerns}</p>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold text-[#0F294A]">
                      {t.dashboard.brief.attentionToday}
                    </h3>
                    <div className="divide-y divide-slate-100">
                      {attentionList.map((item, idx) => (
                        <div
                          key={`${item.projectId}-${idx}`}
                          className="py-2.5 flex items-start justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                              <span className="font-mono-num text-xs text-blue-700">
                                {item.projectId}
                              </span>
                              <span className="truncate">{item.projectTitle}</span>
                            </div>
                            <p className="text-xs text-slate-600 mt-0.5">{item.reason}</p>
                          </div>
                          <span className="text-xs font-mono-num text-slate-500 whitespace-nowrap shrink-0">
                            {item.deadline}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-[#0F294A]">
                        {t.dashboard.brief.prioritiesToday}
                      </h3>
                      <EpistemicTag kind="recommendation" label={t.epistemic.aiRecommendation} />
                    </div>
                    <div className="divide-y divide-slate-100">
                      {prioritiesList.map((rec, i) => (
                        <div key={i} className="py-2.5 space-y-1 text-xs">
                          <div className="font-semibold text-slate-900">{rec.action}</div>
                          <div className="text-slate-600">
                            <span className="font-medium text-slate-700">
                              {t.dashboard.brief.observation}:
                            </span>{" "}
                            {rec.observation}
                          </div>
                          <div className="text-slate-500">
                            <span className="font-medium text-slate-700">
                              {t.dashboard.brief.evidence}:
                            </span>{" "}
                            {rec.evidence} ·{" "}
                            <span className="font-medium text-slate-700">
                              {t.dashboard.brief.impact}:
                            </span>{" "}
                            {rec.impact}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </ErrorBoundary>
        </div>
      </section>

      {/* Dashboard Charts */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#0F294A]">
              {t.dashboard.charts.ordersByStatus}
            </h2>
            <EpistemicTag kind="confirmed" label={t.epistemic.confirmedData} />
          </div>
          <StatusDistributionChart
            statusCounts={metrics.statusCounts}
            total={metrics.totalOrders}
            language={language}
          />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#0F294A]">
              {t.dashboard.charts.completedOverTime}
            </h2>
            <EpistemicTag kind="confirmed" label={t.epistemic.confirmedData} />
          </div>
          <CompletionTrendChart data={metrics.monthlyTrends} language={language} />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#0F294A]">
              {t.dashboard.charts.teamWorkloadDist}
            </h2>
            <EpistemicTag kind="calculated" label={t.epistemic.calculatedMetric} />
          </div>
          <TeamWorkloadChart workloads={workloads} language={language} />
        </div>
      </section>

      {/* Prioritized Operational Alerts */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#0F294A]">{t.dashboard.alerts.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{t.dashboard.alerts.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("analyst")}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap cursor-pointer"
          >
            <span>{t.dashboard.alerts.viewAll}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {topAlerts.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {t.dashboard.alerts.noAlerts}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {topAlerts.map((alert) => {
              const title = language === "ar" ? alert.project.titleAr : alert.project.title;
              const obs = language === "ar" ? alert.observationAr : alert.observationEn;
              const rec = language === "ar" ? alert.recommendedActionAr : alert.recommendedActionEn;
              return (
                <div
                  key={alert.project.id}
                  className="px-6 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <RiskLevelLabel
                        level={alert.riskLevel}
                        label={`${t.riskLevels[alert.riskLevel]} (${alert.riskScore})`}
                      />
                      <button
                        type="button"
                        onClick={() => onInspectProject(alert.project)}
                        className="text-sm font-semibold text-[#0F294A] hover:text-blue-700 text-start cursor-pointer"
                      >
                        <span className="font-mono-num text-blue-700 me-1.5">
                          {alert.project.id}
                        </span>
                        {title}
                      </button>
                    </div>
                    <p className="text-xs text-slate-700">{obs}</p>
                    <p className="text-xs text-slate-500">
                      <span className="font-medium text-slate-700">
                        {t.dashboard.alerts.recommended}:
                      </span>{" "}
                      {rec}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-end">
                      <div className="text-[11px] text-slate-400">{t.dashboard.alerts.deadline}</div>
                      <div
                        className={`text-xs font-mono-num font-semibold ${
                          alert.daysUntilDeadline < 0 ? "text-red-700" : "text-slate-800"
                        }`}
                      >
                        {alert.project.deadline}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
