/**
 * Storage slot. On the personal profile this is Supabase Storage, reached over its REST
 * API with platform-injected credentials. The app only ever calls uploadPhoto(); it does
 * not know or care which storage provider is behind it. If storage is not configured the
 * upload simply returns null and the rest of the app keeps working (never-a-blank-screen).
 */
const BUCKET = "photos";

export async function uploadPhoto(bytes: Buffer, contentType: string): Promise<string | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  const name = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const path = `${BUCKET}/${name}`;
  const res = await fetch(`${base}/storage/v1/object/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) return null;
  // Public URL (the platform creates the bucket as public on deploy).
  return `${base}/storage/v1/object/public/${path}`;
}
