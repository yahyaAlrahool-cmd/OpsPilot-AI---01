import React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  PauseCircle,
  Sparkles,
  Database,
  Calculator,
  Compass,
} from "lucide-react";
import { PriorityLevel, ProjectStatus, RiskLevel } from "../types";

export function StatusLabel({
  status,
  label,
}: {
  status: ProjectStatus;
  label: string;
}) {
  const styles: Record<ProjectStatus, { color: string; Icon: React.ElementType }> = {
    new: { color: "text-blue-700", Icon: Clock },
    in_progress: { color: "text-slate-800", Icon: Compass },
    under_review: { color: "text-amber-700", Icon: AlertCircle },
    completed: { color: "text-emerald-700", Icon: CheckCircle2 },
    on_hold: { color: "text-slate-500", Icon: PauseCircle },
  };
  const { color, Icon } = styles[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${color}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

export function PriorityLabel({
  priority,
  label,
}: {
  priority: PriorityLevel;
  label: string;
}) {
  const styles: Record<PriorityLevel, { dot: string; text: string }> = {
    low: { dot: "bg-slate-400", text: "text-slate-600" },
    medium: { dot: "bg-blue-600", text: "text-blue-800" },
    high: { dot: "bg-amber-600", text: "text-amber-800" },
    critical: { dot: "bg-red-600", text: "text-red-700 font-semibold" },
  };
  const cfg = styles[priority];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-xs shrink-0 ${cfg.dot}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function RiskLevelLabel({
  level,
  label,
}: {
  level: RiskLevel;
  label: string;
}) {
  const styles: Record<RiskLevel, { text: string; bg: string; Icon: React.ElementType }> = {
    low: { text: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", Icon: CheckCircle2 },
    medium: { text: "text-blue-800", bg: "bg-blue-50 border-blue-200", Icon: Clock },
    high: { text: "text-amber-800", bg: "bg-amber-50 border-amber-200", Icon: AlertTriangle },
    critical: { text: "text-red-800", bg: "bg-red-50 border-red-200", Icon: AlertCircle },
  };
  const { text, bg, Icon } = styles[level];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold rounded border whitespace-nowrap ${bg} ${text}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

export function EpistemicTag({
  kind,
  label,
}: {
  kind: "confirmed" | "calculated" | "prediction" | "recommendation";
  label: string;
}) {
  const map = {
    confirmed: { Icon: Database, cls: "text-slate-600" },
    calculated: { Icon: Calculator, cls: "text-blue-700" },
    prediction: { Icon: Sparkles, cls: "text-indigo-700" },
    recommendation: { Icon: Sparkles, cls: "text-blue-800" },
  };
  const { Icon, cls } = map[kind];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap ${cls}`}>
      <Icon className="w-3 h-3 shrink-0" />
      <span>{label}</span>
    </span>
  );
}
