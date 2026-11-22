import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  Employee,
  Language,
  PriorityLevel,
  Project,
  ProjectRiskAssessment,
  ProjectStatus,
  ServiceType,
} from "../types";
import { getCopy } from "../i18n/translations";
import { PriorityLabel, RiskLevelLabel, StatusLabel } from "./StatusIndicator";
import { getTodayISO } from "../utils/analytics";

interface ProjectFormModalProps {
  open: boolean;
  language: Language;
  employees: Employee[];
  initialProject: Project | null;
  onClose: () => void;
  onSave: (projectData: Omit<Project, "id" | "lastUpdated">, existingId?: string) => void;
}

const SERVICE_TYPES: ServiceType[] = [
  "research_reports",
  "presentations",
  "graphic_design",
  "website_development",
  "business_services",
];

const STATUSES: ProjectStatus[] = [
  "new",
  "in_progress",
  "under_review",
  "completed",
  "on_hold",
];

const PRIORITIES: PriorityLevel[] = ["low", "medium", "high", "critical"];

export function ProjectFormModal({
  open,
  language,
  employees,
  initialProject,
  onClose,
  onSave,
}: ProjectFormModalProps) {
  const t = getCopy(language);
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [serviceType, setServiceType] = useState<ServiceType>("business_services");
  const [assignedEmployeeId, setAssignedEmployeeId] = useState(employees[0]?.id ?? "EMP-01");
  const [startDate, setStartDate] = useState(getTodayISO());
  const [deadline, setDeadline] = useState(getTodayISO());
  const [status, setStatus] = useState<ProjectStatus>("new");
  const [progress, setProgress] = useState(0);
  const [priority, setPriority] = useState<PriorityLevel>("medium");
  const [estimatedWorkload, setEstimatedWorkload] = useState(16);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    if (initialProject) {
      setTitle(language === "ar" ? initialProject.titleAr : initialProject.title);
      setClientName(language === "ar" ? initialProject.clientNameAr : initialProject.clientName);
      setServiceType(initialProject.serviceType);
      setAssignedEmployeeId(initialProject.assignedEmployeeId);
      setStartDate(initialProject.startDate);
      setDeadline(initialProject.deadline);
      setStatus(initialProject.status);
      setProgress(initialProject.progress);
      setPriority(initialProject.priority);
      setEstimatedWorkload(initialProject.estimatedWorkload);
      setNotes(language === "ar" ? initialProject.notesAr : initialProject.notes);
    } else {
      const today = getTodayISO();
      const plusTen = new Date();
      plusTen.setDate(plusTen.getDate() + 10);
      setTitle("");
      setClientName("");
      setServiceType("business_services");
      setAssignedEmployeeId(employees[0]?.id ?? "EMP-01");
      setStartDate(today);
      setDeadline(plusTen.toISOString().slice(0, 10));
      setStatus("new");
      setProgress(0);
      setPriority("medium");
      setEstimatedWorkload(16);
      setNotes("");
    }
  }, [open, initialProject, employees, language]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !clientName.trim()) return;
    const finalProgress = status === "completed" ? 100 : Math.min(100, Math.max(0, progress));
    const completedDate =
      status === "completed" ? initialProject?.completedDate ?? getTodayISO() : undefined;

    onSave(
      {
        title: language === "en" ? title.trim() : initialProject?.title || title.trim(),
        titleAr: language === "ar" ? title.trim() : initialProject?.titleAr || title.trim(),
        clientName:
          language === "en" ? clientName.trim() : initialProject?.clientName || clientName.trim(),
        clientNameAr:
          language === "ar"
            ? clientName.trim()
            : initialProject?.clientNameAr || clientName.trim(),
        serviceType,
        assignedEmployeeId,
        startDate,
        deadline,
        completedDate,
        status,
        progress: finalProgress,
        priority,
        estimatedWorkload: Math.max(1, Number(estimatedWorkload) || 1),
        notes: language === "en" ? notes.trim() : initialProject?.notes || notes.trim(),
        notesAr: language === "ar" ? notes.trim() : initialProject?.notesAr || notes.trim(),
      },
      initialProject?.id
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-bold text-[#0F294A]">
            {initialProject ? t.projects.editTitle : t.projects.createTitle}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.title} *</span>
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.client} *</span>
              <input
                required
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.service}</span>
              <select
                value={serviceType}
                onChange={(e) => setServiceType(e.target.value as ServiceType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {SERVICE_TYPES.map((st) => (
                  <option key={st} value={st}>
                    {t.services[st]}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.owner}</span>
              <select
                value={assignedEmployeeId}
                onChange={(e) => setAssignedEmployeeId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {language === "ar" ? emp.nameAr : emp.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.startDate}</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono-num focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.deadline}</span>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono-num focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.workload}</span>
              <input
                type="number"
                min={1}
                max={300}
                value={estimatedWorkload}
                onChange={(e) => setEstimatedWorkload(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono-num focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.status}</span>
              <select
                value={status}
                onChange={(e) => {
                  const next = e.target.value as ProjectStatus;
                  setStatus(next);
                  if (next === "completed") setProgress(100);
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t.statuses[s]}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">{t.projects.form.priority}</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as PriorityLevel)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t.priorities[p]}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 block">
              <span className="text-xs font-medium text-slate-700">
                {t.projects.form.progress} ({progress}%)
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={progress}
                onChange={(e) => setProgress(Number(e.target.value))}
                className="w-full mt-2 accent-blue-600"
              />
            </label>
          </div>

          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-slate-700">{t.projects.form.notes}</span>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </label>

          <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              {t.projects.form.cancel}
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
            >
              {initialProject ? t.projects.form.save : t.projects.form.create}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ProjectDetailModal({
  project,
  assessment,
  owner,
  language,
  onClose,
  onEdit,
}: {
  project: Project | null;
  assessment?: ProjectRiskAssessment;
  owner?: Employee;
  language: Language;
  onClose: () => void;
  onEdit: (p: Project) => void;
}) {
  const t = getCopy(language);
  if (!project) return null;

  const title = language === "ar" ? project.titleAr : project.title;
  const client = language === "ar" ? project.clientNameAr : project.clientName;
  const notes = language === "ar" ? project.notesAr : project.notes;
  const ownerName = owner ? (language === "ar" ? owner.nameAr : owner.name) : "—";

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl shadow-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <span className="text-xs font-mono-num text-blue-700 font-semibold">{project.id}</span>
            <h2 className="text-base font-bold text-[#0F294A] mt-0.5">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 text-sm">
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <div className="text-slate-400">{t.projects.form.client}</div>
              <div className="font-semibold text-slate-900 mt-0.5">{client}</div>
            </div>
            <div>
              <div className="text-slate-400">{t.projects.form.service}</div>
              <div className="font-semibold text-slate-900 mt-0.5">
                {t.services[project.serviceType]}
              </div>
            </div>
            <div>
              <div className="text-slate-400">{t.projects.form.owner}</div>
              <div className="font-semibold text-slate-900 mt-0.5">{ownerName}</div>
            </div>
            <div>
              <div className="text-slate-400">{t.projects.form.workload}</div>
              <div className="font-mono-num font-semibold text-slate-900 mt-0.5">
                {project.estimatedWorkload} {t.projects.hoursSuffix}
              </div>
            </div>
            <div>
              <div className="text-slate-400">{t.projects.form.startDate}</div>
              <div className="font-mono-num text-slate-800 mt-0.5">{project.startDate}</div>
            </div>
            <div>
              <div className="text-slate-400">{t.projects.form.deadline}</div>
              <div className="font-mono-num font-semibold text-slate-900 mt-0.5">
                {project.deadline}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-slate-100">
            <StatusLabel status={project.status} label={t.statuses[project.status]} />
            <PriorityLabel priority={project.priority} label={t.priorities[project.priority]} />
            <span className="font-mono-num text-xs font-semibold text-slate-800">
              {project.progress}%
            </span>
            {assessment && (
              <RiskLevelLabel
                level={assessment.riskLevel}
                label={`${t.riskLevels[assessment.riskLevel]} (${assessment.riskScore}/100)`}
              />
            )}
          </div>

          <div className="space-y-1.5 pt-2 border-t border-slate-100">
            <div className="text-xs font-semibold text-slate-600">{t.projects.form.notes}</div>
            <p className="text-xs text-slate-700 leading-relaxed">
              {notes || t.projects.noNotes}
            </p>
          </div>

          {assessment && assessment.signals.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-slate-100">
              <div className="text-xs font-semibold text-[#0F294A]">
                {t.analyst.recommendedAction}
              </div>
              <p className="text-xs text-slate-700">
                {language === "ar"
                  ? assessment.recommendedActionAr
                  : assessment.recommendedActionEn}
              </p>
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              {t.projects.form.close}
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit(project);
              }}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
            >
              {t.projects.editTitle}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DeleteConfirmModal({
  project,
  language,
  onCancel,
  onConfirm,
}: {
  project: Project | null;
  language: Language;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = getCopy(language);
  if (!project) return null;
  const title = language === "ar" ? project.titleAr : project.title;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-xl">
        <h2 className="text-base font-bold text-[#0F294A]">{t.projects.deleteTitle}</h2>
        <p className="text-sm text-slate-600">
          {t.projects.deleteConfirm}{" "}
          <span className="font-semibold text-slate-900">
            ({project.id} — {title})
          </span>
        </p>
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            {t.projects.form.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
          >
            {t.projects.form.delete}
          </button>
        </div>
      </div>
    </div>
  );
}
