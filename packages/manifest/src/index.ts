/**
 * @platform/manifest — the bridge contract.
 *
 * Every app that wants to be deployed by the platform ships an `app.deploy.yaml`.
 * It is the single source of truth the deploy engine reads: which blueprint, which
 * slots (database, auth, storage, secrets) the app uses. Keep the keys technical and
 * stable. Human-friendly names live in the CLI's user-facing copy, never here.
 */
import { parse as parseYaml } from "yaml";

export type Blueprint = "static" | "web" | "worker";
export type Profile = "personal" | "org";
export type AuthTier = "none" | "simple" | "proper";
/** How strangers get in. `open`: anyone with a Google account. `invite`: only the allowlist. */
export type SignupMode = "open" | "invite";

/**
 * A role the app declares. The builder gives ONLY this: a name and one plain-English line of
 * what it can do. Mapping groups of people to these roles is the platform's job, not the app's.
 */
export interface RoleDecl {
  /** short slug the code checks: requireRole("editor"). */
  name: string;
  /** plain English, reused verbatim on the owner's "who can do what" screen. */
  can: string;
}

export interface Manifest {
  /** url-safe app name; becomes the slug for the database, project, and live URL */
  name: string;
  blueprint: Blueprint;
  /** which provider binding to deploy onto. Defaults to personal. */
  profile?: Profile;
  /** node runtime version, e.g. "node20". Informational for personal/Vercel. */
  runtime?: string;
  /** build command. Defaults are inferred from the framework. */
  build?: string;
  /** build output directory, when not inferable. */
  output?: string;
  web?: {
    framework: "nextjs" | "vite" | "remix" | "astro";
  };
  database?: {
    engine: "postgres";
    /** directory of ordered .sql migration files, run on every deploy. */
    migrations: string;
  };
  auth?: {
    tier: AuthTier;
    /** initial emails allowed in (simple tier, or `proper` with signup: invite). */
    allowlist?: string[];
    /** how strangers get in. Defaults to `open` (anyone with Google). `invite`: allowlist only. */
    signup?: SignupMode;
    /** roles the app defines. The builder gives only these; the platform maps people to them. */
    roles?: RoleDecl[];
    /** the role every signed-in person holds. Must be one of `roles`. */
    default?: string;
  };
  storage?: {
    /** bucket names the platform creates and the app can read/write. */
    buckets: string[];
  };
  env?: {
    /** secret names the user must supply; deploy refuses without them. */
    required?: string[];
    /** secret names that are nice-to-have; deploy proceeds without them. */
    optional?: string[];
  };
}

export interface ValidationIssue {
  /** dotted path into the manifest, e.g. "database.migrations" */
  path: string;
  /** plain-English description of what is wrong */
  problem: string;
  /** plain-English, copy-pasteable instruction to fix it */
  fix: string;
}

export interface ParseResult {
  manifest: Manifest | null;
  issues: ValidationIssue[];
}

const BLUEPRINTS: Blueprint[] = ["static", "web", "worker"];
const PROFILES: Profile[] = ["personal", "org"];
const AUTH_TIERS: AuthTier[] = ["none", "simple", "proper"];
const SIGNUP_MODES: SignupMode[] = ["open", "invite"];
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,29}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse raw YAML text and validate it against the contract. Never throws. */
export function parseManifest(text: string): ParseResult {
  const issues: ValidationIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      manifest: null,
      issues: [
        {
          path: "(file)",
          problem: `The deploy file is not valid YAML: ${(err as Error).message}`,
          fix: "Open app.deploy.yaml and fix the formatting. YAML uses two-space indentation and 'key: value' pairs.",
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifest: null,
      issues: [
        {
          path: "(file)",
          problem: "The deploy file is empty or is not a set of settings.",
          fix: "app.deploy.yaml should start with 'name:' and 'blueprint:' on their own lines.",
        },
      ],
    };
  }

  // name
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    issues.push({
      path: "name",
      problem: "Your app has no name.",
      fix: 'Add a line like `name: my-app` using lowercase letters, numbers, and dashes.',
    });
  } else if (!NAME_RE.test(raw.name)) {
    issues.push({
      path: "name",
      problem: `"${raw.name}" is not a usable app name.`,
      fix: "Use 3 to 40 lowercase letters, numbers, or dashes, starting and ending with a letter or number. For example: budget-tracker.",
    });
  }

  // blueprint
  if (!BLUEPRINTS.includes(raw.blueprint as Blueprint)) {
    issues.push({
      path: "blueprint",
      problem: `blueprint is missing or not one we support${raw.blueprint ? ` (got "${raw.blueprint}")` : ""}.`,
      fix: `Set 'blueprint:' to one of: ${BLUEPRINTS.join(", ")}. A normal app with a login and saved data is 'web'.`,
    });
  }

  if (raw.profile !== undefined && !PROFILES.includes(raw.profile as Profile)) {
    issues.push({
      path: "profile",
      problem: `profile "${raw.profile}" is not recognized.`,
      fix: `Set 'profile:' to one of: ${PROFILES.join(", ")}, or remove the line to use personal.`,
    });
  }

  const blueprint = raw.blueprint as Blueprint;

  // database
  if (raw.database !== undefined) {
    const db = raw.database;
    if (!isObject(db)) {
      issues.push({ path: "database", problem: "database should be a set of settings.", fix: "Use 'database:' followed by indented 'engine:' and 'migrations:' lines." });
    } else {
      if (db.engine !== "postgres") {
        issues.push({ path: "database.engine", problem: "Only postgres databases are supported right now.", fix: "Set 'engine: postgres'." });
      }
      if (typeof db.migrations !== "string") {
        issues.push({ path: "database.migrations", problem: "database is declared but no migrations folder is named.", fix: "Add 'migrations: ./migrations' and put your .sql files there." });
      }
    }
  }

  // auth
  if (raw.auth !== undefined) {
    const auth = raw.auth;
    if (!isObject(auth)) {
      issues.push({ path: "auth", problem: "auth should be a set of settings.", fix: "Use 'auth:' followed by an indented 'tier:' line." });
    } else {
      if (!AUTH_TIERS.includes(auth.tier as AuthTier)) {
        issues.push({ path: "auth.tier", problem: `auth.tier is missing or invalid${auth.tier ? ` (got "${auth.tier}")` : ""}.`, fix: `Set 'tier:' to one of: ${AUTH_TIERS.join(", ")}. 'proper' is Google sign-in; 'simple' is an email list.` });
      }
      if (auth.allowlist !== undefined && !(Array.isArray(auth.allowlist) && auth.allowlist.every((e) => typeof e === "string"))) {
        issues.push({ path: "auth.allowlist", problem: "allowlist should be a list of email addresses.", fix: "Write each email on its own '- name@example.com' line under 'allowlist:'." });
      }

      // signup mode
      if (auth.signup !== undefined && !SIGNUP_MODES.includes(auth.signup as SignupMode)) {
        issues.push({ path: "auth.signup", problem: `auth.signup "${auth.signup}" is not recognized.`, fix: `Set 'signup:' to 'open' (anyone can sign in) or 'invite' (only people on your list), or remove the line to use open.` });
      }

      // roles: a list of { name, can }
      const roleNames = new Set<string>();
      if (auth.roles !== undefined) {
        if (!Array.isArray(auth.roles)) {
          issues.push({ path: "auth.roles", problem: "roles should be a list.", fix: "Under 'roles:', put one '- name:' / '  can:' pair per role." });
        } else {
          auth.roles.forEach((r, i) => {
            if (!isObject(r) || typeof r.name !== "string" || typeof r.can !== "string") {
              issues.push({ path: `auth.roles[${i}]`, problem: "each role needs a name and a plain-English 'can' line.", fix: "Write '- name: editor' then '  can: post and edit'." });
              return;
            }
            if (!ROLE_NAME_RE.test(r.name)) {
              issues.push({ path: `auth.roles[${i}].name`, problem: `role name "${r.name}" is not usable.`, fix: "Use a short lowercase word: letters, numbers, dashes, starting with a letter. For example: editor." });
            } else if (roleNames.has(r.name)) {
              issues.push({ path: `auth.roles[${i}].name`, problem: `role "${r.name}" is listed twice.`, fix: "Give each role a unique name." });
            } else {
              roleNames.add(r.name);
            }
            if (!r.can.trim()) {
              issues.push({ path: `auth.roles[${i}].can`, problem: `role "${r.name}" has no description.`, fix: "Add a 'can:' line in plain English, e.g. 'can: only read'. The owner sees this exact sentence." });
            }
          });
        }
      }

      // default role must be one of the declared roles
      if (auth.default !== undefined) {
        if (typeof auth.default !== "string" || !roleNames.has(auth.default)) {
          issues.push({ path: "auth.default", problem: `the default role "${auth.default}" is not one of the roles you listed.`, fix: `Set 'default:' to one of your role names (${[...roleNames].join(", ") || "define roles first"}), or remove it.` });
        }
      }

      // roles/signup need a sign-in to mean anything
      if (auth.tier === "none" && (auth.roles !== undefined || auth.signup !== undefined || auth.default !== undefined)) {
        issues.push({ path: "auth", problem: "roles, signup, and default only work when the app has a sign-in.", fix: "Set 'tier: proper' (Google sign-in) to use roles, or remove them." });
      }
    }
  }

  // storage
  if (raw.storage !== undefined) {
    const st = raw.storage;
    if (!isObject(st) || !Array.isArray(st.buckets) || !st.buckets.every((b) => typeof b === "string")) {
      issues.push({ path: "storage.buckets", problem: "storage should list one or more bucket names.", fix: "Use 'storage:' then 'buckets:' with each name on a '- name' line." });
    }
  }

  // env
  if (raw.env !== undefined) {
    const env = raw.env;
    if (!isObject(env)) {
      issues.push({ path: "env", problem: "env should be a set of settings.", fix: "Use 'env:' followed by 'required:' and/or 'optional:' lists." });
    } else {
      for (const key of ["required", "optional"] as const) {
        if (env[key] !== undefined && !(Array.isArray(env[key]) && (env[key] as unknown[]).every((k) => typeof k === "string"))) {
          issues.push({ path: `env.${key}`, problem: `env.${key} should be a list of secret names.`, fix: `Write each name on its own '- NAME' line under '${key}:'.` });
        }
      }
    }
  }

  // web blueprint coherence
  if (blueprint === "web" && raw.web !== undefined && !isObject(raw.web)) {
    issues.push({ path: "web", problem: "web should name the framework.", fix: "Use 'web:' then 'framework: nextjs'." });
  }

  if (issues.length > 0) return { manifest: null, issues };
  return { manifest: raw as unknown as Manifest, issues: [] };
}

/** Convenience: returns the manifest or throws a combined human-readable error. */
export function loadManifestStrict(text: string): Manifest {
  const { manifest, issues } = parseManifest(text);
  if (manifest) return manifest;
  const lines = issues.map((i) => `  - ${i.path}: ${i.problem} ${i.fix}`).join("\n");
  throw new Error(`This app's deploy file has problems:\n${lines}`);
}
