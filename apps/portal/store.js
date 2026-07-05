// The DP central store — the portal owner's groups, people, app registry, and group->role
// mappings, kept on the VM with ZERO dependencies (per SPEC-central-groups.md).
//
// Why JSON, not Supabase/SQLite: the portal is a standalone zero-dep service, and Node 20 on the
// VM rules out node:sqlite (needs 22.5+). One owner with tens-to-hundreds of groups/people/apps
// makes a single in-memory JSON file written atomically entirely adequate. The whole thing lives
// behind this small interface so it can be swapped for SQLite later without touching callers.
//
// Durability: every mutation rewrites the file atomically (write a temp file, then rename over the
// real one, so a crash mid-write can never leave a half-written store), and keeps the last N
// backups so a bad write can never wipe the org graph.
const { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } = require("node:fs");
const { dirname, join, basename } = require("node:path");
const { randomBytes } = require("node:crypto");

const BACKUPS = 5;

function normEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}
function newGroupId() {
  return "g" + randomBytes(9).toString("hex");
}
function nowIso() {
  return new Date().toISOString();
}

// Normalize to scheme://host (no path/trailing slash). Kept in parity with auth-gate.js's
// normalizeOrigin so a registry key always matches the relay allowlist origin exactly.
function normalizeOrigin(raw) {
  try {
    const u = new URL(String(raw || ""));
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) return "";
    return u.origin;
  } catch {
    return "";
  }
}

/**
 * The pure fail-closed role resolver.
 *
 * PARITY REQUIREMENT: this mirrors `resolveRoles` in packages/auth/src/roles.ts. The portal ships
 * as a standalone plain-JS service (no build step, no @platform/auth import), so the logic is
 * duplicated on purpose, exactly like verifyIdToken mirrors oauth.ts's verifier. Any change to the
 * resolution rule in roles.ts MUST be mirrored here. Owner holds every declared role; everyone
 * else gets the default role (if declared) plus their groups' roles, always intersected with the
 * declared set so nothing outside the fence is ever granted.
 */
function resolveRoles({ isOwner, defaultRole, grantedRoles, declaredRoles }) {
  const fence = new Set(declaredRoles);
  if (fence.size === 0) return [];
  if (isOwner) return [...fence].sort();
  const out = new Set();
  if (defaultRole && fence.has(defaultRole)) out.add(defaultRole);
  for (const r of grantedRoles || []) if (fence.has(r)) out.add(r);
  return [...out].sort();
}

function emptyState() {
  return { version: 1, apps: {}, people: {}, groups: {}, members: {}, appRoles: {} };
}

/**
 * Create a store bound to a JSON file. Loads it into memory once; every mutation persists
 * synchronously (atomic rename + backup rotation). Single-process, single-threaded Node means no
 * locking is needed: reads and writes never interleave mid-operation.
 */
function createStore(filePath) {
  const file = filePath || "/var/lib/dp-relay/store.json";
  let state = emptyState();

  function load() {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        state = { ...emptyState(), ...parsed };
        // Defend against a truncated/legacy file missing a top-level key.
        for (const k of ["apps", "people", "groups", "members", "appRoles"]) {
          if (!state[k] || typeof state[k] !== "object") state[k] = {};
        }
      }
    } catch {
      // A corrupt file must not crash the portal on boot. Start empty; the corrupt file stays on
      // disk (we never overwrite it until the next successful mutation, which also backs it up).
      state = emptyState();
    }
  }

  function rotateBackups() {
    if (!existsSync(file)) return;
    try {
      // Shift .bak.(n-1) -> .bak.n, then copy current -> .bak.1. Oldest falls off the end.
      for (let i = BACKUPS - 1; i >= 1; i--) {
        const from = `${file}.bak.${i}`;
        const to = `${file}.bak.${i + 1}`;
        if (existsSync(from)) copyFileSync(from, to);
      }
      copyFileSync(file, `${file}.bak.1`);
    } catch {
      // A backup failure must never block the primary write; durability of the latest state wins.
    }
  }

  // backup=true rotates a backup before writing (the default, for structural org-graph edits).
  // The high-frequency recordPerson path passes false: a sign-in only bumps lastSeen, so backing
  // up on every sign-in would burn all N backup slots on same-moment copies and shrink the
  // point-in-time recovery window that protects the groups/mappings graph. The write itself stays
  // atomic (temp + rename) either way, so durability is never traded away.
  function save(backup = true) {
    const dir = dirname(file);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort: the dir usually exists (provisioned by portal-bootstrap.sh) */
    }
    if (backup) rotateBackups();
    const tmp = join(dirname(file), `.${basename(file)}.tmp-${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file); // atomic on the same filesystem
  }

  load();

  /* ---------------- apps registry (populated at deploy) ---------------- */

  function registerApp(rawOrigin, info) {
    const origin = normalizeOrigin(rawOrigin);
    if (!origin) return null;
    const prev = state.apps[origin] || {};
    const declaredRoles = Array.isArray(info && info.declaredRoles)
      ? info.declaredRoles
          .filter((r) => r && typeof r.name === "string")
          .map((r) => ({ name: String(r.name), can: typeof r.can === "string" ? r.can : "" }))
      : prev.declaredRoles || [];
    const app = {
      origin,
      declaredRoles,
      defaultRole:
        info && "defaultRole" in info ? (info.defaultRole ? String(info.defaultRole) : null) : prev.defaultRole ?? null,
      ownerEmail: info && info.ownerEmail ? normEmail(info.ownerEmail) : prev.ownerEmail || "",
      registeredAt: prev.registeredAt || nowIso(),
      lastSeen: nowIso(),
    };
    state.apps[origin] = app;
    if (!state.appRoles[origin]) state.appRoles[origin] = {};
    save();
    return app;
  }
  function listApps() {
    return Object.values(state.apps).sort((a, b) => a.origin.localeCompare(b.origin));
  }
  function getApp(rawOrigin) {
    return state.apps[normalizeOrigin(rawOrigin)] || null;
  }

  /* ---------------- groups ---------------- */

  function listGroups() {
    return Object.values(state.groups).sort((a, b) => a.name.localeCompare(b.name));
  }
  function createGroup(name) {
    const clean = String(name ?? "").trim();
    if (!clean) return null;
    // Idempotent on name (case-insensitive), mirroring the pg/memory stores.
    const existing = Object.values(state.groups).find((g) => g.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const g = { id: newGroupId(), name: clean, createdAt: nowIso() };
    state.groups[g.id] = g;
    state.members[g.id] = [];
    save();
    return g;
  }
  function renameGroup(id, name) {
    const g = state.groups[id];
    const clean = String(name ?? "").trim();
    if (g && clean) {
      g.name = clean;
      save();
    }
  }
  function deleteGroup(id) {
    if (!state.groups[id]) return;
    delete state.groups[id];
    delete state.members[id];
    // Cascade: drop this group's mappings in every app.
    for (const origin of Object.keys(state.appRoles)) delete state.appRoles[origin][id];
    save();
  }

  /* ---------------- membership (keyed by email; add before first sign-in) ---------------- */

  function addMember(groupId, email) {
    const e = normEmail(email);
    if (!state.groups[groupId] || !e) return;
    const set = state.members[groupId] || (state.members[groupId] = []);
    if (!set.includes(e)) {
      set.push(e);
      set.sort();
      save();
    }
  }
  function removeMember(groupId, email) {
    const e = normEmail(email);
    const set = state.members[groupId];
    if (!set) return;
    const i = set.indexOf(e);
    if (i >= 0) {
      set.splice(i, 1);
      save();
    }
  }
  function membersOf(groupId) {
    return [...(state.members[groupId] || [])].sort();
  }
  function groupsForEmail(email) {
    const e = normEmail(email);
    return Object.values(state.groups)
      .filter((g) => (state.members[g.id] || []).includes(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ---------------- group -> role mapping, per app (fail-closed to declared) ---------------- */

  function rolesForGroupInApp(rawOrigin, groupId) {
    const origin = normalizeOrigin(rawOrigin);
    return [...((state.appRoles[origin] && state.appRoles[origin][groupId]) || [])].sort();
  }
  function setGroupRolesForApp(rawOrigin, groupId, roles) {
    const origin = normalizeOrigin(rawOrigin);
    const app = state.apps[origin];
    if (!app || !state.groups[groupId]) return;
    // Fail-closed: only roles the app actually declared are accepted; a stale/undeclared role is
    // silently dropped and can never grant anything.
    const declared = new Set((app.declaredRoles || []).map((r) => r.name));
    const clean = [...new Set((roles || []).map((r) => String(r).trim()).filter(Boolean))].filter((r) => declared.has(r));
    if (!state.appRoles[origin]) state.appRoles[origin] = {};
    if (clean.length) state.appRoles[origin][groupId] = clean;
    else delete state.appRoles[origin][groupId];
    save();
  }

  /* ---------------- people directory ("just arrived") ---------------- */

  function recordPerson(p) {
    const email = normEmail(p && p.email);
    if (!email) return;
    const prev = state.people[email];
    state.people[email] = {
      email,
      name: (p && p.name) || (prev && prev.name) || "",
      picture: (p && p.picture) || (prev && prev.picture) || "",
      sub: (p && p.sub) || (prev && prev.sub) || "",
      firstSeen: (prev && prev.firstSeen) || nowIso(),
      lastSeen: nowIso(),
    };
    save(false); // frequent, low-value write: skip the backup rotation (see save()).
  }
  function listPeople() {
    return Object.values(state.people).sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
  }

  /* ---------------- resolution (the heart: which roles for (email, app)) ---------------- */

  function grantedRolesForEmailInApp(rawOrigin, email) {
    const origin = normalizeOrigin(rawOrigin);
    const e = normEmail(email);
    const perGroup = state.appRoles[origin] || {};
    const out = new Set();
    for (const g of Object.values(state.groups)) {
      if (!(state.members[g.id] || []).includes(e)) continue;
      for (const role of perGroup[g.id] || []) out.add(role);
    }
    return [...out];
  }

  /** The exact roles (email) holds in (appOrigin), fail-closed against the app's declared set. */
  function resolve(email, rawOrigin) {
    const app = getApp(rawOrigin);
    if (!app) return []; // unknown app grants nothing
    const e = normEmail(email);
    const isOwner = !!app.ownerEmail && app.ownerEmail === e;
    return resolveRoles({
      isOwner,
      defaultRole: app.defaultRole,
      grantedRoles: grantedRolesForEmailInApp(rawOrigin, e),
      declaredRoles: (app.declaredRoles || []).map((r) => r.name),
    });
  }

  return {
    // apps
    registerApp,
    listApps,
    getApp,
    // groups
    listGroups,
    createGroup,
    renameGroup,
    deleteGroup,
    // membership
    addMember,
    removeMember,
    membersOf,
    groupsForEmail,
    // mappings
    rolesForGroupInApp,
    setGroupRolesForApp,
    // people
    recordPerson,
    listPeople,
    // resolution
    resolve,
    grantedRolesForEmailInApp,
    // test / introspection helpers
    _file: file,
    _reload: load,
  };
}

module.exports = { createStore, resolveRoles, normalizeOrigin };
