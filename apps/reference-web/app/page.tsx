import Link from "next/link";
import { getUser } from "@platform/auth/next";
import { listNotes } from "../lib/db.ts";
import { postNote, doSignOut } from "./actions.ts";

export const dynamic = "force-dynamic";

const title = process.env.GUESTBOOK_TITLE ?? "Guestbook";

export default async function Home() {
  const user = await getUser();
  const notes = await listNotes();

  return (
    <main>
      <header className="top">
        <h1>{title}</h1>
        <div className="row">
          {user ? (
            <>
              <span className="who">{user.email}</span>
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

      {user ? (
        <form className="card" action={postNote} encType="multipart/form-data">
          <div className="field">
            <textarea name="body" placeholder={`Say hello, ${user.email.split("@")[0]}…`} required />
          </div>
          <div className="row">
            <input type="file" name="photo" accept="image/*" />
            <span className="spacer" />
            <button type="submit">Leave a note</button>
          </div>
        </form>
      ) : (
        <div className="banner">
          This guestbook is live. <Link href="/signin">Sign in</Link> to leave a note. Only people the
          owner has let in can post.
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
