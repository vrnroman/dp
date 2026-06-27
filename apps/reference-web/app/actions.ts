"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getUser,
  requireUser,
  signInWithEmail,
  signOut,
  inviteToAllowlist,
  removeFromAllowlist,
} from "@platform/auth/next";
import { addNote } from "../lib/db.ts";
import { uploadPhoto } from "../lib/storage.ts";

export async function doSignIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const result = await signInWithEmail(email);
  if (!result.ok) {
    redirect(`/signin?reason=${result.reason}`);
  }
  redirect("/");
}

export async function doSignOut(): Promise<void> {
  await signOut();
  redirect("/");
}

export async function postNote(formData: FormData): Promise<void> {
  const user = await requireUser();
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

export async function invite(formData: FormData): Promise<void> {
  await requireUser();
  const email = String(formData.get("email") ?? "").trim();
  if (email) await inviteToAllowlist(email);
  revalidatePath("/settings");
  redirect("/settings");
}

export async function removeMember(formData: FormData): Promise<void> {
  await requireUser();
  const email = String(formData.get("email") ?? "");
  if (email) await removeFromAllowlist(email);
  revalidatePath("/settings");
  redirect("/settings");
}

// Re-exported for server components that need the current user.
export async function currentUser() {
  return getUser();
}
