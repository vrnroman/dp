import Link from "next/link";
import { getUser, userHasRole } from "@platform/auth/next";
import { listNotes } from "../lib/db.ts";
import { postNote, doSignOut } from "./actions.ts";

export const dynamic = "force-dynamic";

const title = process.env.GUESTBOOK_TITLE ?? "Guestbook";

export default async function Home() {
  const user = await getUser();
  // Use userHasRole (not rolesForUser().includes) so `deployctl check` scans this role name too
  // and catches a mistyped role before deploy, exactly like it does for requireRole.
  const canPost = await userHasRole("editor");
  const notes = await listNotes();

  return (
    <main>
      <header className="top">
        <h1>{title}</h1>
        <div className="row">
          {user ? (
            <>
              <span className="who">{user.name || user.email}</span>
              {user.role === "owner" && (
                <Link className="tag" href="/settings">
                  who&apos;s in
                </Link>
              )}
              <form action={doSignOut}>
                <button className="ghost" type="submit">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link className="btn" href="/signin">
              Sign in
            </Link>
          )}
        </div>
      </header>

      {user && canPost ? (
        <form className="card" action={postNote} encType="multipart/form-data">
          <div className="field">
            <textarea name="body" placeholder={`Say hello, ${(user.name || user.email).split("@")[0]}…`} required />
          </div>
          <div className="row">
            <input type="file" name="photo" accept="image/*" />
            <span className="spacer" />
            <button type="submit">Leave a note</button>
          </div>
        </form>
      ) : user ? (
        <div className="banner">
          You are signed in and can read every note. To leave one, ask the owner to add you as
          someone who can post.
        </div>
      ) : (
        <div className="banner">
          This guestbook is live. <Link href="/signin">Sign in</Link> to read along. The owner can
          let people leave notes too.
        </div>
      )}

      {notes.map((note) => (
        <div className="card note" key={note.id}>
          <div className="meta">
            {note.author_email} · {new Date(note.created_at).toLocaleString()}
          </div>
          <div className="body">{note.body}</div>
          {note.photo_url && <img src={note.photo_url} alt="" />}
        </div>
      ))}
    </main>
  );
}
