import {
  Employee,
  EmployeeWorkloadSummary,
  MonthlyTrendPoint,
  OperationalMetrics,
  Project,
  ProjectRiskAssessment,
  ProjectStatus,
  RebalanceSuggestion,
  RiskLevel,
  RiskSignal,
  ServiceType,
} from "../types";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function diffDays(fromISO: string, toISO: string): number {
  const from = new Date(`${fromISO}T00:00:00Z`).getTime();
  const to = new Date(`${toISO}T00:00:00Z`).getTime();
  return Math.round((to - from) / MS_PER_DAY);
}

export function getTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export const METRIC_FORMULAS = {
  en: {
    completionRate: "Completed Projects / Total Orders * 100",
    onTimeCompletionRate:
      "Completed Projects finished on or before deadline / Total Completed Projects * 100 (excludes active projects)",
    utilizationPct: "Employee Active Remaining Hours / Weekly Capacity Hours * 100",
    remainingWorkloadHours: "Estimated Workload * ((100 - Progress %) / 100) for non-completed projects; 0 when completed",
    activeProjects: "Total Orders - Completed Projects (includes New, In Progress, Under Review, On Hold)",
    overdueProjects: "Active non-completed projects where deadline < today",
    atRiskProjects: "Active non-completed projects with deterministic riskScore >= 50 (all overdue projects score >= 50)",
    totalDelayedProjects: "Active Overdue Projects + Completed-Late Projects",
  },
  ar: {
    completionRate: "(المشاريع المكتملة ÷ إجمالي الطلبات) × 100",
    onTimeCompletionRate:
      "(المشاريع المكتملة في الموعد أو قبله ÷ إجمالي المشاريع المكتملة) × 100 (يستثني المشاريع النشطة)",
    utilizationPct: "(الساعات النشطة المتبقية للموظف ÷ السعة الأسبوعية) × 100",
    remainingWorkloadHours: "عبء العمل المقدر × ((100 - نسبة الإنجاز) ÷ 100) للمشاريع غير المكتملة؛ و0 عند الاكتمال",
    activeProjects: "إجمالي الطلبات - المشاريع المكتملة (جديد، قيد التنفيذ، قيد المراجعة، معلق)",
    overdueProjects: "المشاريع النشطة غير المكتملة التي تجاوز موعدها النهائي تاريخ اليوم",
    atRiskProjects: "المشاريع النشطة التي تبلغ درجة مخاطرها 50 فأكثر (جميع المشاريع المتأخرة >= 50)",
    totalDelayedProjects: "المشاريع النشطة المتأخرة + المشاريع المكتملة بعد الموعد",
  },
} as const;

export function calcRemainingHours(project: Project): number {
  if (project.status === "completed" || project.progress >= 100) return 0;
  const pctLeft = Math.max(0, 100 - project.progress) / 100;
  return Math.round(project.estimatedWorkload * pctLeft);
}

export function computeTeamWorkload(
  projects: Project[],
  employees: Employee[],
  todayISO = getTodayISO()
): EmployeeWorkloadSummary[] {
  return employees.map((employee) => {
    const assigned = projects.filter((p) => p.assignedEmployeeId === employee.id);
    const active = assigned.filter((p) => p.status !== "completed");
    const completed = assigned.filter((p) => p.status === "completed");
    const overdue = active.filter((p) => diffDays(todayISO, p.deadline) < 0);

    const activeHours = active.reduce((sum, p) => sum + calcRemainingHours(p), 0);

    const utilizationPct =
      employee.weeklyCapacityHours > 0
        ? Math.round((activeHours / employee.weeklyCapacityHours) * 100)
        : 0;

    let capacityStatus: "overloaded" | "optimal" | "available" = "optimal";
    if (utilizationPct >= 105 || active.length >= 4) {
      capacityStatus = "overloaded";
    } else if (utilizationPct <= 65 && active.length <= 2) {
      capacityStatus = "available";
    }

    return {
      employee,
      assignedProjects: assigned,
      activeProjectsCount: active.length,
      completedProjectsCount: completed.length,
      overdueProjectsCount: overdue.length,
      activeWorkloadHours: activeHours,
      utilizationPct,
      capacityStatus,
    };
  });
}

export function assessProjectRisks(
  projects: Project[],
  employees: Employee[],
  todayISO = getTodayISO()
): ProjectRiskAssessment[] {
  const workloadMap = new Map(
    computeTeamWorkload(projects, employees, todayISO).map((w) => [w.employee.id, w])
  );
  const employeeMap = new Map(employees.map((e) => [e.id, e]));

  const assessments: ProjectRiskAssessment[] = [];

  for (const project of projects) {
    if (project.status === "completed") continue;

    const owner = employeeMap.get(project.assignedEmployeeId);
    const ownerWorkload = workloadMap.get(project.assignedEmployeeId);
    const daysUntilDeadline = diffDays(todayISO, project.deadline);
    const daysSinceUpdate = Math.max(0, diffDays(project.lastUpdated, todayISO));
    const remainingWorkloadHours = calcRemainingHours(project);
    const signals: RiskSignal[] = [];
    const missingDataEn: string[] = [];
    const missingDataAr: string[] = [];

    if (!project.notes.trim() && !project.notesAr.trim()) {
      missingDataEn.push("No execution notes or blocker details recorded");
      missingDataAr.push("لا توجد ملاحظات تنفيذ أو تفاصيل عوائق مسجلة");
    }
    if (!owner) {
      missingDataEn.push("Assigned employee record not found");
      missingDataAr.push("سجل الموظف المسؤول غير موجود");
    } else if (!owner.skillsVerified) {
      missingDataEn.push(`${owner.name}'s skills are unverified`);
      missingDataAr.push(`مهارات ${owner.nameAr} غير مؤكدة`);
    }

    if (daysUntilDeadline < 0) {
      const daysLate = Math.abs(daysUntilDeadline);
      // Every overdue project receives at least 50 base points so Overdue <= At-Risk is strictly consistent.
      signals.push({
        code: "overdue",
        detailEn: `Overdue by ${daysLate} day(s) with ${project.progress}% progress (${remainingWorkloadHours}h remaining)`,
        detailAr: `متأخر بمقدار ${daysLate} يوم بنسبة إنجاز ${project.progress}% (متبقي ${remainingWorkloadHours} ساعة)`,
        points: Math.min(62, 50 + daysLate * 2),
      });
    } else if (daysUntilDeadline <= 5 && project.progress < 70) {
      signals.push({
        code: "deadline_lag",
        detailEn: `Due in ${daysUntilDeadline} day(s) at ${project.progress}% progress (${remainingWorkloadHours}h remaining)`,
        detailAr: `الموعد النهائي خلال ${daysUntilDeadline} يوم بنسبة إنجاز ${project.progress}% (متبقي ${remainingWorkloadHours} ساعة)`,
        points: 35 + Math.max(0, 5 - daysUntilDeadline) * 4,
      });
    } else if (daysUntilDeadline <= 10 && project.progress < 35) {
      signals.push({
        code: "deadline_lag",
        detailEn: `Only ${project.progress}% complete with ${daysUntilDeadline} days left`,
        detailAr: `الإنجاز ${project.progress}% فقط مع بقاء ${daysUntilDeadline} يوماً`,
        points: 24,
      });
    }

    if (daysSinceUpdate >= 5) {
      signals.push({
        code: "stale_update",
        detailEn: `No status update logged for ${daysSinceUpdate} days (last updated ${project.lastUpdated})`,
        detailAr: `لم يتم تسجيل أي تحديث منذ ${daysSinceUpdate} يوماً (آخر تحديث ${project.lastUpdated})`,
        points: Math.min(20, 10 + (daysSinceUpdate - 4) * 2),
      });
    }

    if (!project.notes.trim() && !project.notesAr.trim()) {
      signals.push({
        code: "missing_notes",
        detailEn: "Missing project scope notes / blocker visibility",
        detailAr: "ملاحظات النطاق أو تفاصيل العوائق غير مسجلة",
        points: 14,
      });
    }

    if (project.status === "on_hold" && daysUntilDeadline <= 10) {
      signals.push({
        code: "on_hold_near_deadline",
        detailEn: `On Hold while deadline is ${daysUntilDeadline < 0 ? "already passed" : `in ${daysUntilDeadline} day(s)`}`,
        detailAr: `المشروع معلق بينما الموعد النهائي ${daysUntilDeadline < 0 ? "قد فات" : `خلال ${daysUntilDeadline} يوم`}`,
        points: 20,
      });
    }

    if (ownerWorkload && ownerWorkload.capacityStatus === "overloaded") {
      signals.push({
        code: "overloaded_owner",
        detailEn: `Owner ${owner?.name ?? ""} is at ${ownerWorkload.utilizationPct}% capacity (${ownerWorkload.activeProjectsCount} active projects)`,
        detailAr: `المسؤول ${owner?.nameAr ?? ""} عند ${ownerWorkload.utilizationPct}% من طاقته (${ownerWorkload.activeProjectsCount} مشاريع نشطة)`,
        points: 16,
      });
    }

    if (remainingWorkloadHours >= 18 && daysUntilDeadline <= 7) {
      signals.push({
        code: "excessive_workload",
        detailEn: `Heavy remaining workload (${remainingWorkloadHours}h remaining of ${project.estimatedWorkload}h) within 7-day window`,
        detailAr: `عبء عمل متبقٍ مرتفع (${remainingWorkloadHours} ساعة من أصل ${project.estimatedWorkload} ساعة) ضمن نافذة ٧ أيام`,
        points: 12,
      });
    }

    const priorityBonus =
      project.priority === "critical" ? 8 : project.priority === "high" ? 4 : 0;
    const rawScore =
      signals.reduce((s, item) => s + item.points, 0) + (signals.length > 0 ? priorityBonus : 0);
    const riskScore = Math.min(100, Math.max(0, rawScore));

    // Strict score-to-label mapping
    let riskLevel: RiskLevel = "low";
    if (riskScore >= 75) riskLevel = "critical";
    else if (riskScore >= 50) riskLevel = "high";
    else if (riskScore >= 25) riskLevel = "medium";

    const primarySignal = signals[0];
    const observationEn = primarySignal
      ? primarySignal.detailEn
      : "Execution is tracking within expected timeline and workload bounds.";
    const observationAr = primarySignal
      ? primarySignal.detailAr
      : "التنفيذ يسير ضمن الجدول الزمني وحدود عبء العمل المتوقعة.";

    const evidenceEn = [
      `Status: ${project.status.replace("_", " ")}`,
      `Progress: ${project.progress}%`,
      `Remaining: ${remainingWorkloadHours}h/${project.estimatedWorkload}h`,
      `Deadline: ${project.deadline}`,
      `Owner load: ${ownerWorkload ? `${ownerWorkload.utilizationPct}%` : "Unassigned"}`,
    ].join(" · ");

    const evidenceAr = [
      `الحالة: ${project.status}`,
      `التقدم: ${project.progress}%`,
      `المتبقي: ${remainingWorkloadHours}س/${project.estimatedWorkload}س`,
      `الموعد: ${project.deadline}`,
      `ضغط المسؤول: ${ownerWorkload ? `${ownerWorkload.utilizationPct}%` : "غير محدد"}`,
    ].join(" · ");

    let impactEn = "Minimal operational exposure under current trajectory.";
    let impactAr = "تعرض تشغيلي محدود وفق المسار الحالي.";
    let recommendedActionEn = "Continue standard weekly progress check-in.";
    let recommendedActionAr = "الاستمرار في المتابعة الأسبوعية المعتادة.";

    if (daysUntilDeadline < 0) {
      impactEn = `Direct delivery delay on ${project.clientName} (${Math.abs(daysUntilDeadline)} day(s) past deadline); ${remainingWorkloadHours}h of work still open.`;
      impactAr = `تأخر مباشر في تسليم ${project.clientName} (متجاوز للموعد بـ ${Math.abs(daysUntilDeadline)} يوم) مع بقاء ${remainingWorkloadHours} ساعة عمل.`;
      recommendedActionEn = `Escalate ${project.id} today: review recorded blockers${!project.notes.trim() ? " (notes currently missing — clarify status first)" : ""} and send client timeline update.`;
      recommendedActionAr = `تصعيد ${project.id} اليوم: مراجعة العوائق${!project.notesAr.trim() ? " (الملاحظات مفقودة حالياً — استوضح الحالة أولاً)" : ""} وإرسال تحديث زمني للعميل.`;
    } else if (riskLevel === "critical" || riskLevel === "high") {
      impactEn = `High risk of missing ${project.deadline} deadline with ${remainingWorkloadHours}h remaining.`;
      impactAr = `خطر مرتفع لتجاوز موعد ${project.deadline} مع بقاء ${remainingWorkloadHours} ساعة عمل.`;
      recommendedActionEn =
        ownerWorkload?.capacityStatus === "overloaded"
          ? `Review ${project.id} blockers and consider shifting secondary tasks off ${owner?.name ?? "assignee"} (${ownerWorkload.utilizationPct}% load).`
          : `Conduct a focused milestone check on ${project.id} before ${project.deadline}.`;
      recommendedActionAr =
        ownerWorkload?.capacityStatus === "overloaded"
          ? `مراجعة عوائق ${project.id} والنظر في تخفيف المهام الثانوية عن ${owner?.nameAr ?? "المسؤول"} (${ownerWorkload.utilizationPct}% إشغال).`
          : `إجراء مراجعة مركزة لمعالم ${project.id} قبل ${project.deadline}.`;
    } else if (signals.some((s) => s.code === "missing_notes")) {
      impactEn = "Missing execution notes reduce visibility into blockers and handoff criteria.";
      impactAr = "نقص ملاحظات التنفيذ يقلل وضوح العوائق ومعايير التسليم.";
      recommendedActionEn = `Add clear scope deliverables and current blocker status to ${project.id}.`;
      recommendedActionAr = `إضافة تفاصيل المخرجات وحالة العوائق الحالية إلى ${project.id}.`;
    }

    assessments.push({
      project,
      owner,
      riskScore,
      riskLevel,
      daysUntilDeadline,
      daysSinceUpdate,
      remainingWorkloadHours,
      signals,
      missingDataEn,
      missingDataAr,
      observationEn,
      observationAr,
      evidenceEn,
      evidenceAr,
      impactEn,
      impactAr,
      recommendedActionEn,
      recommendedActionAr,
    });
  }

  return assessments.sort((a, b) => b.riskScore - a.riskScore);
}

export function generateRebalanceSuggestions(
  projects: Project[],
  employees: Employee[],
  todayISO = getTodayISO()
): RebalanceSuggestion[] {
  const workloads = computeTeamWorkload(projects, employees, todayISO);
  const overloaded = workloads.filter((w) => w.capacityStatus === "overloaded");
  const available = workloads
    .filter((w) => w.capacityStatus === "available" || w.utilizationPct < 75)
    .sort((a, b) => a.utilizationPct - b.utilizationPct);

  const suggestions: RebalanceSuggestion[] = [];

  for (const source of overloaded) {
    const candidates = source.assignedProjects
      .filter(
        (p) =>
          p.status !== "completed" &&
          (p.status === "new" || p.status === "on_hold" || p.progress < 50)
      )
      .sort((a, b) => a.progress - b.progress);

    for (const proj of candidates) {
      if (suggestions.length >= 4) break;
      const skillMatchTarget = available.find(
        (t) =>
          t.employee.id !== source.employee.id &&
          t.employee.skills.includes(proj.serviceType)
      );
      const fallbackTarget = available.find((t) => t.employee.id !== source.employee.id);
      const chosen = skillMatchTarget ?? fallbackTarget;

      if (!chosen) continue;

      const hasVerifiedSkill =
        chosen.employee.skillsVerified && chosen.employee.skills.includes(proj.serviceType);

      const hoursMoved = calcRemainingHours(proj);

      suggestions.push({
        projectId: proj.id,
        projectTitle: proj.title,
        projectTitleAr: proj.titleAr,
        fromEmployeeId: source.employee.id,
        fromEmployeeName: source.employee.name,
        fromEmployeeNameAr: source.employee.nameAr,
        toEmployeeId: chosen.employee.id,
        toEmployeeName: chosen.employee.name,
        toEmployeeNameAr: chosen.employee.nameAr,
        hoursMoved,
        skillMatch: hasVerifiedSkill,
        requiresManagerVerification: !hasVerifiedSkill,
        reasonEn: hasVerifiedSkill
          ? `${source.employee.name} is at ${source.utilizationPct}% capacity; ${chosen.employee.name} is at ${chosen.utilizationPct}% with verified ${proj.serviceType.replace("_", " ")} skill.`
          : `${source.employee.name} is at ${source.utilizationPct}% capacity and ${chosen.employee.name} has capacity (${chosen.utilizationPct}%), but skills for ${proj.serviceType.replace("_", " ")} are unverified — manager verification required before reassignment.`,
        reasonAr: hasVerifiedSkill
          ? `${source.employee.nameAr} عند ${source.utilizationPct}% من الطاقة؛ ${chosen.employee.nameAr} عند ${chosen.utilizationPct}% ويمتلك المهارة المؤكدة المطلوبة.`
          : `${source.employee.nameAr} عند ${source.utilizationPct}% من الطاقة و${chosen.employee.nameAr} لديه سعة متاحة (${chosen.utilizationPct}%)، لكن المهارة المطلوبة غير مؤكدة — يتطلب تحقق المدير قبل إعادة التوزيع.`,
      });
    }
  }

  return suggestions;
}

export function computeOperationalMetrics(
  projects: Project[],
  employees: Employee[],
  todayISO = getTodayISO()
): OperationalMetrics {
  const statusCounts: Record<ProjectStatus, number> = {
    new: 0,
    in_progress: 0,
    under_review: 0,
    completed: 0,
    on_hold: 0,
  };

  const categoryCounts: Record<
    ServiceType,
    { total: number; delayed: number; completed: number }
  > = {
    research_reports: { total: 0, delayed: 0, completed: 0 },
    presentations: { total: 0, delayed: 0, completed: 0 },
    graphic_design: { total: 0, delayed: 0, completed: 0 },
    website_development: { total: 0, delayed: 0, completed: 0 },
    business_services: { total: 0, delayed: 0, completed: 0 },
  };

  let overdueProjects = 0;
  let completedOnTimeCount = 0;
  let completedLateCount = 0;
  let completionDaysSum = 0;
  let completionDaysCount = 0;

  for (const p of projects) {
    statusCounts[p.status] += 1;
    categoryCounts[p.serviceType].total += 1;

    if (p.status === "completed") {
      categoryCounts[p.serviceType].completed += 1;
      const doneDate = p.completedDate ?? p.lastUpdated;
      const lateDays = diffDays(p.deadline, doneDate);
      if (lateDays <= 0) {
        completedOnTimeCount += 1;
      } else {
        completedLateCount += 1;
        categoryCounts[p.serviceType].delayed += 1;
      }
      const duration = Math.max(1, diffDays(p.startDate, doneDate));
      completionDaysSum += duration;
      completionDaysCount += 1;
    } else if (diffDays(todayISO, p.deadline) < 0) {
      overdueProjects += 1;
      categoryCounts[p.serviceType].delayed += 1;
    }
  }

  const risks = assessProjectRisks(projects, employees, todayISO);
  const atRiskProjects = risks.filter(
    (r) => r.riskLevel === "high" || r.riskLevel === "critical"
  ).length;

  const totalOrders = projects.length;
  const completedProjects = statusCounts.completed;
  const activeProjects = totalOrders - completedProjects;
  const totalDelayedProjects = overdueProjects + completedLateCount;
  const completionRate = totalOrders > 0 ? Math.round((completedProjects / totalOrders) * 100) : 0;
  const onTimeCompletionRate =
    completedProjects > 0 ? Math.round((completedOnTimeCount / completedProjects) * 100) : 0;
  const avgCompletionDays =
    completionDaysCount > 0 ? Math.round(completionDaysSum / completionDaysCount) : 0;

  // Build 6-month series ending at current month
  const refDate = new Date(`${todayISO}T00:00:00Z`);
  const monthlyTrends: MonthlyTrendPoint[] = [];
  const enMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const arMonths = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const labelEn = enMonths[d.getUTCMonth()];
    const labelAr = arMonths[d.getUTCMonth()];

    const monthCompleted = projects.filter((p) => {
      if (p.status !== "completed") return false;
      const done = p.completedDate ?? p.lastUpdated;
      return done.startsWith(key);
    });

    const onTimeCount = monthCompleted.filter(
      (p) => diffDays(p.deadline, p.completedDate ?? p.lastUpdated) <= 0
    ).length;

    const delayedInMonth = projects.filter((p) => {
      if (p.status === "completed") {
        const done = p.completedDate ?? p.lastUpdated;
        return done.startsWith(key) && diffDays(p.deadline, done) > 0;
      }
      return p.deadline.startsWith(key) && diffDays(todayISO, p.deadline) < 0;
    }).length;

    const totalHours = projects
      .filter((p) => p.startDate.startsWith(key) || (p.completedDate ?? "").startsWith(key))
      .reduce((s, p) => s + p.estimatedWorkload, 0);

    monthlyTrends.push({
      monthKey: key,
      labelEn,
      labelAr,
      completedCount: monthCompleted.length,
      onTimeCount,
      delayedCount: delayedInMonth,
      totalHours,
    });
  }

  return {
    totalOrders,
    activeProjects,
    completedProjects,
    completedOnTimeCount,
    completedLateCount,
    overdueProjects,
    totalDelayedProjects,
    atRiskProjects,
    completionRate,
    onTimeCompletionRate,
    avgCompletionDays,
    statusCounts,
    categoryCounts,
    monthlyTrends,
  };
}
