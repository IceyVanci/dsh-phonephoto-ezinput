// phone-shoot — 会话选择器（纯函数，便于用伪造数据做单测）

export function normalizeRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.sessions)) return raw.sessions;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  return [];
}

export function rowFromSummary(summary, titleOf) {
  const id = summary.sessionId || summary.id;
  const projectionTitle = summary.projections && summary.projections.values ? summary.projections.values.title : undefined;
  const title = (typeof projectionTitle === "string" && projectionTitle) || titleOf(id, summary) || "未命名会话";
  return {
    sessionId: id,
    title,
    updatedAt: Number(summary.updatedAt || summary.createdAt || 0),
    running: summary.running === true,
    blank: summary.blank === true,
    cwd: summary.cwd || null,
    parentSessionId: summary.parentSessionId || null
  };
}

export function buildSessionList(options) {
  const now = options.now != null ? options.now : Date.now();
  const windowMs = options.recentWindowMs != null ? options.recentWindowMs : 600000;
  const stamps = options.stamps || new Map();
  const archived = options.archived || new Set();
  const workspaces = options.workspaces || [];
  const rows = options.rows || [];

  const ownerOf = new Map();
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds || []) {
      if (!ownerOf.has(id)) ownerOf.set(id, workspace);
    }
  }

  const visible = [];
  for (const row of rows) {
    if (!row || !row.sessionId) continue;
    if (row.parentSessionId) continue;
    if (archived.has(row.sessionId)) continue;
    const owner = ownerOf.get(row.sessionId) || null;
    visible.push({
      sessionId: row.sessionId,
      title: row.title,
      workspace: owner ? owner.title : null,
      workspaceId: owner ? owner.id : null,
      activity: Math.max(row.updatedAt || 0, stamps.get(row.sessionId) || 0),
      running: row.running === true,
      blank: row.blank === true
    });
  }

  const byRecency = (a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (b.activity !== a.activity) return b.activity - a.activity;
    return String(a.sessionId).localeCompare(String(b.sessionId));
  };

  const recent = visible.filter((row) => row.running || now - row.activity <= windowMs).sort(byRecency);
  const recentIds = new Set(recent.map((row) => row.sessionId));
  const rest = visible.filter((row) => !recentIds.has(row.sessionId));

  const groups = [];
  const seen = new Set();
  for (const workspace of workspaces) {
    const sessions = rest.filter((row) => row.workspaceId === workspace.id).sort(byRecency);
    if (!sessions.length) continue;
    seen.add(workspace.id);
    groups.push({
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      missing: workspace.missing === true,
      sessions
    });
  }
  const loose = rest.filter((row) => !row.workspaceId).sort(byRecency);
  if (loose.length) groups.push({ workspaceId: "", title: "未分组", path: "", missing: false, sessions: loose });

  return { recent, groups, total: visible.length, now, windowMs };
}

export function toWireRow(row) {
  return { sessionId: row.sessionId, title: row.title, workspace: row.workspace, activity: row.activity, running: row.running, blank: row.blank };
}

export function toWire(list) {
  return {
    recent: list.recent.map(toWireRow),
    groups: list.groups.map((group) => ({
      workspaceId: group.workspaceId,
      title: group.title,
      path: group.path,
      missing: group.missing,
      sessions: group.sessions.map(toWireRow)
    })),
    total: list.total
  };
}
