/**
 * Supabase provider — the database, auth store, and storage for the personal profile.
 * Talks to the Supabase Management API. All of this is hidden from the non-engineer; the
 * platform makes every call on their behalf.
 */
const API = "https://api.supabase.com/v1";

export interface ProjectKeys {
  anon: string;
  serviceRole: string;
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function firstOrgId(token: string): Promise<string> {
  const res = await api(token, "/organizations");
  if (!res.ok) throw new Error(`Could not read Supabase organizations (${res.status}). Check the access token.`);
  const orgs = (await res.json()) as Array<{ id: string }>;
  if (!orgs.length) throw new Error("No Supabase organization is available for this account.");
  return orgs[0].id;
}

export interface ExistingProject {
  id: string;
  name: string;
  region: string;
  status: string;
}

export async function listProjects(token: string): Promise<ExistingProject[]> {
  const res = await api(token, "/projects");
  if (!res.ok) throw new Error(`Could not list Supabase projects (${res.status}).`);
  return (await res.json()) as ExistingProject[];
}

export interface CreatedProject {
  ref: string;
  region: string;
}

export async function createProject(
  token: string,
  opts: { name: string; orgId: string; region: string; dbPass: string },
): Promise<CreatedProject> {
  const res = await api(token, "/projects", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      organization_id: opts.orgId,
      region: opts.region,
      db_pass: opts.dbPass,
      plan: "free",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the free-plan limit as a human message the caller can show as-is.
    if (/limit|maximum|free plan|quota/i.test(text)) {
      throw new Error(
        `Supabase will not create another database: ${trimApi(text)} The free plan allows two active databases per account. Pause one you are not using in the Supabase dashboard, then run this again.`,
      );
    }
    throw new Error(`Supabase could not create the database (${res.status}): ${trimApi(text)}`);
  }
  const json = JSON.parse(text) as { id: string; region?: string };
  return { ref: json.id, region: json.region ?? opts.region };
}

export async function getProjectStatus(token: string, ref: string): Promise<string> {
  const res = await api(token, `/projects/${ref}`);
  if (!res.ok) return "UNKNOWN";
  const json = (await res.json()) as { status: string };
  return json.status;
}

/** Poll until the project is ready to accept connections. */
export async function waitHealthy(
  token: string,
  ref: string,
  onTick: (status: string) => void,
  timeoutMs = 6 * 60 * 1000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const status = await getProjectStatus(token, ref);
    onTick(status);
    if (status === "ACTIVE_HEALTHY") return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`The database did not come online in time (last status: ${status}).`);
    }
    await sleep(6000);
  }
}

export async function getKeys(token: string, ref: string): Promise<ProjectKeys> {
  // reveal=true is required by the newer key system to return the actual secret value.
  const res = await api(token, `/projects/${ref}/api-keys?reveal=true`);
  if (!res.ok) throw new Error(`Could not read the database keys (${res.status}).`);
  const keys = (await res.json()) as Array<{ name: string; api_key: string }>;
  const anon = keys.find((k) => k.name === "anon")?.api_key ?? "";
  const serviceRole = keys.find((k) => k.name === "service_role")?.api_key ?? "";
  if (!anon || !serviceRole) {
    throw new Error(
      "The database came online but its access keys came back empty. This is usually temporary; wait a minute and run this again.",
    );
  }
  return { anon, serviceRole };
}

export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

/**
 * Build the candidate pooler connection strings. Vercel's serverless functions reach
 * Postgres over IPv4, which the pooler supports (the direct db host is IPv6-only). Session
 * mode (5432) keeps `pg`'s prepared statements working.
 *
 * Supabase assigns each project to a specific pooler cluster (aws-0, aws-1, ...). Both
 * hostnames resolve in DNS regardless of which one actually hosts the project, so DNS
 * cannot tell them apart. The caller picks the right one by actually trying to connect.
 */
export function poolerCandidates(
  ref: string,
  region: string,
  dbPass: string,
): Array<{ url: string; host: string }> {
  const pass = encodeURIComponent(dbPass);
  return ["aws-0", "aws-1"].map((cluster) => {
    const host = `${cluster}-${region}.pooler.supabase.com`;
    return { host, url: `postgresql://postgres.${ref}:${pass}@${host}:5432/postgres` };
  });
}

export async function ensurePublicBucket(
  projectUrlStr: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<void> {
  const res = await fetch(`${projectUrlStr}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: bucket, name: bucket, public: true }),
  });
  // 200 = created, 409 = already exists. Both are fine.
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    if (!/already exists/i.test(text)) {
      throw new Error(`Could not create the storage area "${bucket}" (${res.status}): ${trimApi(text)}`);
    }
  }
}

export async function deleteProject(token: string, ref: string): Promise<void> {
  const res = await api(token, `/projects/${ref}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Could not delete the database (${res.status}).`);
  }
}

function trimApi(text: string): string {
  try {
    const j = JSON.parse(text);
    return (j.message || j.error || text).toString().slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
