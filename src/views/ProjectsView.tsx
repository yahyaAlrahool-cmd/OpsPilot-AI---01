import React, { useMemo, useState } from "react";
import {
  ArrowUpDown,
  Eye,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  Employee,
  Language,
  PriorityLevel,
  Project,
  ProjectStatus,
} from "../types";
import { getCopy } from "../i18n/translations";
import { PriorityLabel, StatusLabel } from "../components/StatusIndicator";
import { diffDays, getTodayISO } from "../utils/analytics";

interface ProjectsViewProps {
  language: Language;
  projects: Project[];
  employees: Employee[];
  onAddNew: () => void;
  onEdit: (project: Project) => void;
  onInspect: (project: Project) => void;
  onRequestDelete: (project: Project) => void;
  onQuickUpdate: (id: string, patch: Partial<Project>) => void;
}

type SortField = "id" | "deadline" | "progress" | "priority" | "estimatedWorkload";

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const ALL_STATUSES: ProjectStatus[] = [
  "new",
  "in_progress",
  "under_review",
  "completed",
  "on_hold",
];

const ALL_PRIORITIES: PriorityLevel[] = ["low", "medium", "high", "critical"];

export function ProjectsView({
  language,
  projects,
  employees,
  onAddNew,
  onEdit,
  onInspect,
  onRequestDelete,
  onQuickUpdate,
}: ProjectsViewProps) {
  const t = getCopy(language);
  const todayISO = getTodayISO();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("deadline");
  const [sortAsc, setSortAsc] = useState(true);

  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (statusFilter !== "all" && p.status !== statusFilter) return false;
        if (priorityFilter !== "all" && p.priority !== priorityFilter) return false;
        if (employeeFilter !== "all" && p.assignedEmployeeId !== employeeFilter) return false;
        if (q) {
          const hay = [
            p.id,
            p.title,
            p.titleAr,
            p.clientName,
            p.clientNameAr,
          ]
            .join(" ")
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        let cmp = 0;
        if (sortField === "id") cmp = a.id.localeCompare(b.id);
        else if (sortField === "deadline") cmp = a.deadline.localeCompare(b.deadline);
        else if (sortField === "progress") cmp = a.progress - b.progress;
        else if (sortField === "estimatedWorkload") cmp = a.estimatedWorkload - b.estimatedWorkload;
        else if (sortField === "priority") cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        return sortAsc ? cmp : -cmp;
      });
  }, [projects, search, statusFilter, priorityFilter, employeeFilter, sortField, sortAsc]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const hasFilters =
    search !== "" || statusFilter !== "all" || priorityFilter !== "all" || employeeFilter !== "all";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0F294A]">{t.projects.title}</h1>
          <p className="text-sm text-slate-500 mt-1">{t.projects.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onAddNew}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t.topbar.addProject}</span>
        </button>
      </div>

      {/* Filters Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.projects.searchPlaceholder}
            className="w-full ps-9 pe-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">{t.projects.allStatuses}</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t.statuses[s]}
            </option>
          ))}
        </select>

        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">{t.projects.allPriorities}</option>
          {ALL_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t.priorities[p]}
            </option>
          ))}
        </select>

        <select
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
        >
          <option value="all">{t.projects.allEmployees}</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {language === "ar" ? e.nameAr : e.name}
            </option>
          ))}
        </select>

        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
              setPriorityFilter("all");
              setEmployeeFilter("all");
            }}
            className="px-3 py-2 text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap cursor-pointer"
          >
            {t.projects.clearFilters}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="text-sm font-semibold text-slate-900">{t.projects.emptyTitle}</div>
            <p className="text-xs text-slate-500">{t.projects.emptyDesc}</p>
            <button
              type="button"
              onClick={onAddNew}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.topbar.addProject}</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort("id")}
                      className="inline-flex items-center gap-1 hover:text-slate-800 cursor-pointer"
                    >
                      <span>{t.projects.columns.id}</span>
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-3 px-4 text-start">{t.projects.columns.projectClient}</th>
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    {t.projects.columns.service}
                  </th>
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    {t.projects.columns.owner}
                  </th>
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort("deadline")}
                      className="inline-flex items-center gap-1 hover:text-slate-800 cursor-pointer"
                    >
                      <span>{t.projects.columns.dates}</span>
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    {t.projects.columns.status}
                  </th>
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort("progress")}
                      className="inline-flex items-center gap-1 hover:text-slate-800 cursor-pointer"
                    >
                      <span>{t.projects.columns.progress}</span>
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-3 px-4 text-start whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort("priority")}
                      className="inline-flex items-center gap-1 hover:text-slate-800 cursor-pointer"
                    >
                      <span>{t.projects.columns.priority}</span>
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-3 px-4 text-end whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort("estimatedWorkload")}
                      className="inline-flex items-center gap-1 hover:text-slate-800 cursor-pointer"
                    >
                      <span>{t.projects.columns.workload}</span>
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-3 px-4 text-end whitespace-nowrap">
                    {t.projects.columns.actions}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filtered.map((project) => {
                  const owner = empMap.get(project.assignedEmployeeId);
                  const title = language === "ar" ? project.titleAr : project.title;
                  const client = language === "ar" ? project.clientNameAr : project.clientName;
                  const ownerName = owner ? (language === "ar" ? owner.nameAr : owner.name) : "—";
                  const isOverdue =
                    project.status !== "completed" && diffDays(todayISO, project.deadline) < 0;

                  return (
                    <tr key={project.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4 font-mono-num font-semibold text-blue-700 whitespace-nowrap">
                        {project.id}
                      </td>
                      <td className="py-3 px-4 min-w-[200px] max-w-[260px]">
                        <button
                          type="button"
                          onClick={() => onInspect(project)}
                          className="font-semibold text-slate-900 hover:text-blue-700 text-start block truncate w-full cursor-pointer"
                        >
                          {title}
                        </button>
                        <div className="text-[11px] text-slate-500 truncate mt-0.5">{client}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                        {t.services[project.serviceType]}
                      </td>
                      <td className="py-3 px-4 text-slate-800 whitespace-nowrap">{ownerName}</td>
                      <td className="py-3 px-4 whitespace-nowrap font-mono-num">
                        <div className={isOverdue ? "text-red-700 font-semibold" : "text-slate-800"}>
                          {project.deadline}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {t.projects.started}: {project.startDate}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <select
                          aria-label={t.projects.columns.status}
                          value={project.status}
                          onChange={(e) => {
                            const nextStatus = e.target.value as ProjectStatus;
                            onQuickUpdate(project.id, {
                              status: nextStatus,
                              progress: nextStatus === "completed" ? 100 : project.progress,
                              completedDate:
                                nextStatus === "completed" ? getTodayISO() : undefined,
                            });
                          }}
                          className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
                        >
                          {ALL_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {t.statuses[s]}
                            </option>
                          ))}
                        </select>
                        <div className="mt-1">
                          <StatusLabel status={project.status} label={t.statuses[project.status]} />
                        </div>
                      </td>
                      <td className="py-3 px-4 min-w-[130px]">
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            aria-label={t.projects.columns.progress}
                            value={project.progress}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              onQuickUpdate(project.id, {
                                progress: val,
                                status: val === 100 ? "completed" : project.status,
                                completedDate: val === 100 ? getTodayISO() : project.completedDate,
                              });
                            }}
                            className="w-20 accent-blue-600 cursor-pointer"
                          />
                          <span className="font-mono-num font-semibold text-slate-800 w-9 text-end">
                            {project.progress}%
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <PriorityLabel
                          priority={project.priority}
                          label={t.priorities[project.priority]}
                        />
                      </td>
                      <td className="py-3 px-4 text-end font-mono-num text-slate-700 whitespace-nowrap">
                        {project.estimatedWorkload}
                        {t.projects.hoursSuffix}
                      </td>
                      <td className="py-3 px-4 text-end whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onInspect(project)}
                            title={t.projects.detailsTitle}
                            className="p-1.5 text-slate-500 hover:text-blue-700 rounded hover:bg-slate-100 cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onEdit(project)}
                            title={t.projects.editTitle}
                            className="p-1.5 text-slate-500 hover:text-blue-700 rounded hover:bg-slate-100 cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onRequestDelete(project)}
                            title={t.projects.deleteTitle}
                            className="p-1.5 text-slate-500 hover:text-red-600 rounded hover:bg-red-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
