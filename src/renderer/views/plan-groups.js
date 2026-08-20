// views/plan-groups.js — how the Plans list is divided into projects (#449), as pure functions.
//
// WHY THIS IS ITS OWN FILE. The same reason agent-file-filter.js is one: grouping decided inline in the
// view can only be tested by asserting that certain source strings exist, and that is the shape of test
// that once passed while the thing it "covered" was unreachable. These decisions are handed data and
// asked for an answer.
//
// The interesting case is the plan with NO project. It is not a defect and it is not rare — a plan whose
// session has been cleaned off disk can never be attributed again, and Switchboard cannot invent one. So
// it is a group like any other, kept LAST rather than dropped, because a plan the user can see and open
// is worth more than a tidy list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // The key a plan groups under. `projectPath` and nothing else: two projects can carry the same display
  // name, and a project can be renamed while the list is open.
  const UNATTRIBUTED = '__no_project__';

  function planGroupKey(plan) {
    return (plan && plan.projectPath) ? plan.projectPath : UNATTRIBUTED;
  }

  /**
   * The plans grouped by project, newest project first, and the unattributed ones last.
   *
   * "Newest" is the newest plan the group holds, not the project's own activity — the list is about
   * plans, and a project whose plan was touched a minute ago belongs at the top even if nothing else
   * about it has moved in months.
   *
   * Order INSIDE a group is left exactly as it arrived. The caller sorted the plans once, by date, and a
   * second sort here would be a second opinion about the same question.
   */
  function planGroups(plans) {
    const groups = new Map();
    for (const plan of (plans || [])) {
      if (!plan) continue;
      const key = planGroupKey(plan);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          projectPath: key === UNATTRIBUTED ? null : plan.projectPath,
          displayName: plan.displayName || '',
          shortName: plan.shortName || '',
          plans: [],
        });
      }
      groups.get(key).plans.push(plan);
    }

    const newest = (g) => g.plans.reduce((max, p) => {
      const t = new Date(p.modified).getTime();
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);

    const list = [...groups.values()];
    const attributed = list.filter(g => g.key !== UNATTRIBUTED).sort((a, b) => newest(b) - newest(a));
    const orphans = list.filter(g => g.key === UNATTRIBUTED);
    return [...attributed, ...orphans];
  }

  /**
   * What a group's header says.
   *
   * The unattributed group has to state a FACT, not a placeholder: "Unknown project" reads like a bug in
   * the app, when what happened is that the session which wrote the plan is no longer on disk.
   */
  function planGroupLabel(group) {
    if (!group || group.key === UNATTRIBUTED) return 'No session on record';
    return group.displayName || group.shortName || group.projectPath || 'Project';
  }

  return { planGroups, planGroupKey, planGroupLabel, PLAN_GROUP_UNATTRIBUTED: UNATTRIBUTED };
});
