"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getUser,
  requireUser,
  requireRole,
  signOut,
  createGroup,
  deleteGroup,
  addPersonToGroup,
  removePersonFromGroup,
  setGroupRoles,
} from "@platform/auth/next";
import { addNote } from "../lib/db.ts";
import { uploadPhoto } from "../lib/storage.ts";

export async function doSignOut(): Promise<void> {
  await signOut();
  redirect("/");
}

export async function postNote(formData: FormData): Promise<void> {
  // Leaving a note needs the "editor" role. Everyone can read (the default "viewer" role);
  // only people the owner put in an editor group can post.
  const user = await requireRole("editor");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) redirect("/");

  let photoUrl: string | null = null;
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    const bytes = Buffer.from(await photo.arrayBuffer());
    photoUrl = await uploadPhoto(bytes, photo.type || "application/octet-stream");
  }

  await addNote(user.email, body, photoUrl);
  revalidatePath("/");
  redirect("/");
}

/* ---- the owner's "who can do what" screen (groups) ---- */

export async function makeGroup(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (name) await createGroup(name);
  revalidatePath("/settings");
  redirect("/settings");
}

export async function removeGroup(formData: FormData): Promise<void> {
  const id = String(formData.get("groupId") ?? "");
  if (id) await deleteGroup(id);
  revalidatePath("/settings");
  redirect("/settings");
}

export async function addToGroup(formData: FormData): Promise<void> {
  const id = String(formData.get("groupId") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  if (id && email) await addPersonToGroup(id, email);
  revalidatePath("/settings");
  redirect("/settings");
}

export async function takeFromGroup(formData: FormData): Promise<void> {
  const id = String(formData.get("groupId") ?? "");
  const email = String(formData.get("email") ?? "");
  if (id && email) await removePersonFromGroup(id, email);
  revalidatePath("/settings");
  redirect("/settings");
}

export async function chooseGroupRoles(formData: FormData): Promise<void> {
  const id = String(formData.get("groupId") ?? "");
  const roles = formData.getAll("role").map((r) => String(r));
  if (id) await setGroupRoles(id, roles);
  revalidatePath("/settings");
  redirect("/settings");
}

// Re-exported for server components that need the current user.
export async function currentUser() {
  return getUser();
}
