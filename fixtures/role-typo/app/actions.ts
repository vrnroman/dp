import { requireRole } from "@platform/auth/next";

// The manifest declares "viewer" and "editor". This checks "editer" — a typo. The role
// checker must catch it: that door would never open for anyone.
export async function deleteEverything() {
  await requireRole("editer");
}
