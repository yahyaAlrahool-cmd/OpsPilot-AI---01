import React from "react";
import { AlertCircle, RefreshCw, Sparkles, XCircle } from "lucide-react";
import {
  AIErrorKind,
  AIRequestStatus,
  Language,
  OperationalMetrics,
  PerformanceAIResponse,
} from "../types";
import { getCopy } from "../i18n/translations";
import { CategoryBreakdownChart, DelayAndWorkloadTrendChart } from "../components/Charts";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { EpistemicTag } from "../components/StatusIndicator";
import { METRIC_FORMULAS } from "../utils/analytics";

interface PerformanceViewProps {
  language: Language;
  metrics: OperationalMetrics;
  insights: PerformanceAIResponse | null;
  status: AIRequestStatus;
  errorKind: AIErrorKind | null;
  error: string | null;
  onGenerateInsights: () => void;
  onCancelInsights: () => void;
}

export function PerformanceView({
  language,
  metrics,
  insights,
  status,
  errorKind,
  error,
  onGenerateInsights,
  onCancelInsights,
}: PerformanceViewProps) {
  const t = getCopy(language);
  const formulas = METRIC_FORMULAS[language];
  const isAnalyzing = status === "analyzing";

  const kpis = [
    {
      label: t.performance.kpi.onTimeRate,
      value: `${metrics.onTimeCompletionRate}%`,
      sub:
        language === "ar"
          ? `${metrics.completedOnTimeCount} من أصل ${metrics.completedProjects} مكتملة`
          : `${metrics.completedOnTimeCount} / ${metrics.completedProjects} completed`,
      formula: formulas.onTimeCompletionRate,
      tone: metrics.onTimeCompletionRate >= 75 ? "text-emerald-700" : "text-amber-700",
    },
    {
      label: t.performance.kpi.avgTime,
      value: `${metrics.avgCompletionDays} ${t.performance.daysUnit}`,
      sub:
        language === "ar"
          ? `${metrics.completedProjects} مشروع مكتمل`
          : `${metrics.completedProjects} completed`,
      formula: "",
      tone: "text-[#0F294A]",
    },
    {
      label: t.performance.kpi.volume,
      value: metrics.totalOrders,
      sub:
        language === "ar"
          ? `${metrics.activeProjects} نشط · ${metrics.completedProjects} مكتمل`
          : `${metrics.activeProjects} active · ${metrics.completedProjects} done`,
      formula: formulas.activeProjects,
      tone: "text-blue-800",
    },
    {
      label: t.performance.kpi.completed,
      value: metrics.completedProjects,
      sub: `${metrics.completionRate}% ${t.dashboard.kpi.completionRate}`,
      formula: formulas.completionRate,
      tone: "text-emerald-700",
    },
    {
      label: t.performance.kpi.delayed,
      value: metrics.totalDelayedProjects,
      sub:
        language === "ar"
          ? `${metrics.overdueProjects} متأخر نشط + ${metrics.completedLateCount} متأخر مكتمل`
          : `${metrics.overdueProjects} active + ${metrics.completedLateCount} late done`,
      formula: formulas.totalDelayedProjects,
      tone: metrics.totalDelayedProjects > 0 ? "text-red-700" : "text-slate-700",
    },
  ];

  const improvingList = Array.isArray(insights?.whatsImproving) ? insights.whatsImproving : [];
  const worseningList = Array.isArray(insights?.whatsGettingWorse) ? insights.whatsGettingWorse : [];
  const delayPatternsList = Array.isArray(insights?.delayPatterns) ? insights.delayPatterns : [];
  const actionsList = Array.isArray(insights?.improvementActions) ? insights.improvementActions : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0F294A]">
            {t.performance.title}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t.performance.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isAnalyzing && (
            <button
              type="button"
              onClick={onCancelInsights}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <XCircle className="w-3.5 h-3.5 text-slate-500" />
              <span>{t.aiStates.cancel}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onGenerateInsights}
            disabled={isAnalyzing}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isAnalyzing ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span>{t.performance.generateInsights}</span>
          </button>
        </div>
      </div>

      {/* Factual Metrics Section — always renders deterministically */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-500">{t.performance.factualHeader}</h2>
          <EpistemicTag kind="confirmed" label={t.epistemic.confirmedData} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {kpis.map((k) => (
            <div
              key={k.label}
              title={k.formula || undefined}
              className="bg-white border border-slate-200 rounded-xl p-4"
            >
              <div className="text-xs text-slate-500">{k.label}</div>
              <div className={`text-2xl font-bold font-mono-num mt-2 ${k.tone}`}>{k.value}</div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono-num">{k.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Deterministic Charts — always render cleanly */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-[#0F294A]">{t.performance.charts.byCategory}</h3>
          <CategoryBreakdownChart categoryCounts={metrics.categoryCounts} language={language} />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-[#0F294A]">
            {t.performance.charts.delayTrends}
          </h3>
          <DelayAndWorkloadTrendChart
            data={metrics.monthlyTrends}
            mode="delays"
            language={language}
          />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-[#0F294A]">
            {t.performance.charts.workloadTrends}
          </h3>
          <DelayAndWorkloadTrendChart
            data={metrics.monthlyTrends}
            mode="workload"
            language={language}
          />
        </div>
      </section>

      {/* AI Interpretation Section — Failure-safe & isolated */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-[#0F294A]">{t.performance.aiHeader}</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-slate-500">
              {t.aiStates.statusLabels[status]}
            </span>
            <EpistemicTag kind="prediction" label={t.epistemic.aiPrediction} />
          </div>
        </div>

        <div className="p-6">
          <ErrorBoundary variant="panel" language={language} onRetry={onGenerateInsights}>
            {status === "analyzing" ? (
              <div className="space-y-3 animate-pulse">
                <div className="h-4 bg-slate-100 rounded w-1/2" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="h-28 bg-slate-100 rounded-lg" />
                  <div className="h-28 bg-slate-100 rounded-lg" />
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <p className="text-xs text-slate-500">{t.performance.generating}</p>
                  <button
                    type="button"
                    onClick={onCancelInsights}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                  >
                    {t.aiStates.cancel}
                  </button>
                </div>
              </div>
            ) : status === "canceled" ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{error || t.aiStates.canceledMessage}</span>
                </div>
                <button
                  type="button"
                  onClick={onGenerateInsights}
                  className="px-3 py-1.5 bg-white border border-amber-300 rounded font-medium text-amber-800 hover:bg-amber-100 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {t.aiStates.retry}
                </button>
              </div>
            ) : status === "error" ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    {error ||
                      (errorKind === "timeout"
                        ? t.aiStates.timeoutMessage
                        : t.aiStates.errorMessage)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onGenerateInsights}
                  className="px-3 py-1.5 bg-white border border-red-200 rounded font-medium text-red-700 hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {t.aiStates.retry}
                </button>
              </div>
            ) : status === "success" && insights ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-emerald-700">
                    {t.performance.insights.improving}
                  </h3>
                  <div className="divide-y divide-slate-100">
                    {improvingList.map((item, i) => (
                      <div key={i} className="py-2.5 text-xs space-y-1">
                        <div className="font-semibold text-slate-900">{item.observation}</div>
                        <div className="text-slate-500">{item.evidence}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-red-700">
                    {t.performance.insights.worsening}
                  </h3>
                  <div className="divide-y divide-slate-100">
                    {worseningList.map((item, i) => (
                      <div key={i} className="py-2.5 text-xs space-y-1">
                        <div className="font-semibold text-slate-900">{item.observation}</div>
                        <div className="text-slate-500">{item.evidence}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 pt-4 border-t border-slate-100">
                  <h3 className="text-xs font-semibold text-[#0F294A]">
                    {t.performance.insights.patterns}
                  </h3>
                  <div className="divide-y divide-slate-100">
                    {delayPatternsList.map((item, i) => (
                      <div key={i} className="py-2.5 text-xs space-y-1">
                        <div className="font-semibold text-slate-900">{item.pattern}</div>
                        <div className="text-slate-500">{item.evidence}</div>
                        <div className="text-amber-800">{item.impact}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 pt-4 border-t border-slate-100">
                  <h3 className="text-xs font-semibold text-blue-800">
                    {t.performance.insights.actions}
                  </h3>
                  <div className="divide-y divide-slate-100">
                    {actionsList.map((item, i) => (
                      <div key={i} className="py-2.5 text-xs space-y-1">
                        <div className="font-semibold text-slate-900">{item.action}</div>
                        <div className="text-slate-500">{item.evidence}</div>
                        <div className="text-blue-700 font-medium">{item.expectedImpact}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <p className="text-xs text-slate-600 max-w-2xl">{t.performance.insights.promptCta}</p>
                <button
                  type="button"
                  onClick={onGenerateInsights}
                  disabled={isAnalyzing}
                  className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-60 border border-blue-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {t.performance.generateInsights}
                </button>
              </div>
            )}
          </ErrorBoundary>
        </div>
      </section>
    </div>
  );
}
