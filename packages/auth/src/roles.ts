/**
 * @platform/auth/roles — the pure, framework-free heart of "who can do what".
 *
 * The division of responsibility (the platform's, not the app builder's, decision):
 *   - The APP BUILDER only ever DECLARES roles, each a name plus one plain-English line of
 *     what it can do ("editor: post and edit recipes"). That lives in app.deploy.yaml.
 *   - The PLATFORM owns everything else: real people (verified by Google), named GROUPS the
 *     app owner sorts people into, and the mapping from a group to the roles it grants. None
 *     of that is the app's code; it is machinery the platform ships into every app.
 *
 * A person's roles are resolved LIVE from their group memberships on every request, never
 * baked into their sign-in cookie — so the moment an owner moves someone out of a group, the
 * power is gone, with no re-login. Resolution is fail-closed: a role is granted only if the
 * app actually declared it (the manifest is the fence), so a stale mapping to a deleted role
 * can never grant anything.
 */

/** A role as the app builder declares it: a name and one plain sentence of what it can do. */
export interface RoleSpec {
  name: string;
  /** plain English, reused verbatim on the owner's screen. e.g. "post and edit recipes". */
  can: string;
}

/** How strangers get in. `open`: anyone with Google. `invite`: only the allowlist. */
export type SignupMode = "open" | "invite";

/** The roles the app declared, plus which one everyone who signs in holds by default. */
export interface RolePolicy {
  roles: RoleSpec[];
  /** the role every signed-in person holds. Optional; when unset, default is no role. */
  defaultRole?: string | null;
  signup: SignupMode;
}

export interface ResolveInput {
  /** the app owner (the account that deployed it) holds every declared role, always. */
  isOwner: boolean;
  /** the role every signed-in person holds, if the app declared one. */
  defaultRole?: string | null;
  /** role names granted by the groups this person is in (may contain stale/unknown names). */
  grantedRoles: string[];
  /** every role the app declared: the fence. A role outside this set is never granted. */
  declaredRoles: string[];
}

/**
 * Resolve the exact set of roles a person holds, fail-closed. Owner gets everything declared;
 * everyone else gets the default (if declared) plus whatever their groups map to — but always
 * intersected with the declared set, so nothing outside the fence is ever granted.
 */
export function resolveRoles(input: ResolveInput): string[] {
  const fence = new Set(input.declaredRoles);
  if (fence.size === 0) return [];
  if (input.isOwner) return [...fence].sort();

  const out = new Set<string>();
  if (input.defaultRole && fence.has(input.defaultRole)) out.add(input.defaultRole);
  for (const r of input.grantedRoles) if (fence.has(r)) out.add(r);
  return [...out].sort();
}

/** True if the person holds `role`. Convenience over resolveRoles. */
export function hasRole(role: string, input: ResolveInput): boolean {
  return resolveRoles(input).includes(role);
}

export interface AccessInput {
  /** the verified email from Google. */
  email: string;
  /** the app owner's email (the account that deployed it), or "" if unknown. */
  ownerEmail: string;
  signup: SignupMode;
  /** the allowlist role for this email, if any: "owner" | "member" | null. */
  allowlistRole?: "owner" | "member" | null;
}

/**
 * Decide whether a verified Google identity may sign in, and whether they are the owner.
 * Pure and fail-closed: invite mode admits only the owner or an allowlisted email; open mode
 * admits anyone but still honors an allowlist "owner" marking. Kept separate from the network so
 * the who-gets-in rule is unit-testable without a live Google.
 */
export function decideAccess(input: AccessInput): { allowed: boolean; isOwner: boolean } {
  const email = String(input.email ?? "").trim().toLowerCase();
  const owner = String(input.ownerEmail ?? "").trim().toLowerCase();
  if (!email) return { allowed: false, isOwner: false };
  if (owner && email === owner) return { allowed: true, isOwner: true };
  const markedOwner = input.allowlistRole === "owner";
  if (input.signup === "invite") {
    const listed = input.allowlistRole === "owner" || input.allowlistRole === "member";
    return { allowed: listed, isOwner: markedOwner };
  }
  // open signup: anyone verified gets in; an allowlist "owner" marking still elevates.
  return { allowed: true, isOwner: markedOwner };
}

/* ------------------------------------------------------------------ */
/* The groups store — the platform's people/groups machinery.          */
/* A pluggable interface so the same logic runs against an in-memory    */
/* map (tests) or Postgres (real deploys), mirroring the allowlist.     */
/* ------------------------------------------------------------------ */

export interface Group {
  id: string;
  name: string;
}

export interface Person {
  email: string;
  name?: string | null;
  picture?: string | null;
  sub?: string | null;
  firstSeen?: string;
  lastSeen?: string;
}

export interface GroupsStore {
  // groups
  listGroups(): Promise<Group[]>;
  createGroup(name: string): Promise<Group>;
  renameGroup(id: string, name: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  // membership (keyed by email so you can add someone before they ever sign in)
  addToGroup(groupId: string, email: string): Promise<void>;
  removeFromGroup(groupId: string, email: string): Promise<void>;
  membersOf(groupId: string): Promise<string[]>;
  groupsForEmail(email: string): Promise<Group[]>;
  // group -> role mapping
  rolesForGroup(groupId: string): Promise<string[]>;
  setGroupRoles(groupId: string, roles: string[]): Promise<void>;
  // the flat set of role names a person is granted via all their groups
  grantedRolesForEmail(email: string): Promise<string[]>;
  // the people directory (who has actually signed in — the "just arrived" list)
  recordPerson(p: Person): Promise<void>;
  listPeople(): Promise<Person[]>;
}

function normalize(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/** A tiny, deterministic id generator injected so the memory store stays pure in tests. */
export type IdGen = () => string;

/** In-memory groups store. Used by contract tests and as a safe default. */
export class MemoryGroupsStore implements GroupsStore {
  private groups = new Map<string, Group>();
  private members = new Map<string, Set<string>>(); // groupId -> emails
  private mappings = new Map<string, Set<string>>(); // groupId -> role names
  private people = new Map<string, Person>();
  private seq = 0;
  constructor(private idGen: IdGen = () => `g${++this.seq}`) {}

  async listGroups(): Promise<Group[]> {
    return [...this.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async createGroup(name: string): Promise<Group> {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("A group needs a name.");
    const existing = [...this.groups.values()].find((g) => g.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const g: Group = { id: this.idGen(), name: clean };
    this.groups.set(g.id, g);
    this.members.set(g.id, new Set());
    this.mappings.set(g.id, new Set());
    return g;
  }
  async renameGroup(id: string, name: string): Promise<void> {
    const g = this.groups.get(id);
    if (g) g.name = String(name ?? "").trim() || g.name;
  }
  async deleteGroup(id: string): Promise<void> {
    this.groups.delete(id);
    this.members.delete(id);
    this.mappings.delete(id);
  }
  async addToGroup(groupId: string, email: string): Promise<void> {
    const set = this.members.get(groupId);
    if (set) set.add(normalize(email));
  }
  async removeFromGroup(groupId: string, email: string): Promise<void> {
    this.members.get(groupId)?.delete(normalize(email));
  }
  async membersOf(groupId: string): Promise<string[]> {
    return [...(this.members.get(groupId) ?? [])].sort();
  }
  async groupsForEmail(email: string): Promise<Group[]> {
    const key = normalize(email);
    const out: Group[] = [];
    for (const [gid, set] of this.members) if (set.has(key)) { const g = this.groups.get(gid); if (g) out.push(g); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async rolesForGroup(groupId: string): Promise<string[]> {
    return [...(this.mappings.get(groupId) ?? [])].sort();
  }
  async setGroupRoles(groupId: string, roles: string[]): Promise<void> {
    if (this.groups.has(groupId)) this.mappings.set(groupId, new Set(roles.map((r) => String(r).trim()).filter(Boolean)));
  }
  async grantedRolesForEmail(email: string): Promise<string[]> {
    const key = normalize(email);
    const out = new Set<string>();
    for (const [gid, set] of this.members) if (set.has(key)) for (const r of this.mappings.get(gid) ?? []) out.add(r);
    return [...out].sort();
  }
  async recordPerson(p: Person): Promise<void> {
    const key = normalize(p.email);
    const prev = this.people.get(key);
    this.people.set(key, {
      email: key,
      name: p.name ?? prev?.name ?? null,
      picture: p.picture ?? prev?.picture ?? null,
      sub: p.sub ?? prev?.sub ?? null,
      firstSeen: prev?.firstSeen ?? "now",
      lastSeen: "now",
    });
  }
  async listPeople(): Promise<Person[]> {
    return [...this.people.values()];
  }
}
