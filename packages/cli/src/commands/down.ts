import { resolve } from "node:path";
import { loadTokens } from "../util/env.ts";
import { readState, writeState, clearState } from "../util/state.ts";
import { Narrator } from "../ui/narrate.ts";
import * as supabase from "../providers/supabase.ts";
import * as vercel from "../providers/vercel.ts";

export interface DownOptions {
  yes?: boolean;
}

export async function runDown(appDirArg: string, opts: DownOptions): Promise<number> {
  const appDir = resolve(appDirArg || ".");
  const state = readState(appDir);
  if (!state) {
    process.stdout.write("There is nothing to take down here. No deploy was recorded for this app.\n");
    return 0;
  }

  if (!opts.yes) {
    process.stdout.write(
      `This will permanently remove "${state.appName}" and everything in it:\n` +
        (state.supabase ? `  - the database and all of its data\n` : "") +
        (state.vercel ? `  - the web home at ${state.url ?? "its address"}\n` : "") +
        `\nThis cannot be undone. Run again with --yes to confirm.\n`,
    );
    return 0;
  }

  const tokens = loadTokens();
  const n = new Narrator();
  let allGone = true;

  if (state.vercel) {
    n.start("Taking down the web home");
    try {
      await vercel.deleteProject(tokens.vercelToken, state.vercel.projectId);
      delete state.vercel;
      writeState(appDir, state);
      n.done("Web home removed");
    } catch (err) {
      allGone = false;
      n.fail(`Could not remove the web home: ${(err as Error).message}`);
    }
  }

  if (state.supabase) {
    n.start("Deleting the database");
    try {
      await supabase.deleteProject(tokens.supabaseAccessToken, state.supabase.ref);
      delete state.supabase;
      writeState(appDir, state);
      n.done("Database deleted");
    } catch (err) {
      allGone = false;
      n.fail(`Could not delete the database: ${(err as Error).message}`);
    }
  }

  if (allGone) {
    clearState(appDir);
    process.stdout.write(`\n"${state.appName}" has been taken down.\n`);
    return 0;
  }

  // Keep the record of whatever is left so a re-run can finish the job.
  process.stdout.write(
    `\nSome of "${state.appName}" could not be removed. The record was kept so you can run this again to finish, or remove the rest from the provider dashboard.\n`,
  );
  return 1;
}
