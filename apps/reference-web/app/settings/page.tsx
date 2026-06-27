import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser, getAllowlist } from "@platform/auth/next";
import { invite, removeMember } from "../actions.ts";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const user = await getUser();
  if (!user) redirect("/signin");
  if (user.role !== "owner") redirect("/");

  const people = await getAllowlist();

  return (
    <main>
      <header className="top">
        <h1>Who&apos;s in</h1>
        <Link className="ghost btn" href="/">
          Back
        </Link>
      </header>

      <div className="banner">
        These are the only people who can sign in. Add your mom, your friends, anyone you trust. They
        just enter their email and they are in.
      </div>

      <form className="card" action={invite}>
        <div className="row">
          <input type="email" name="email" placeholder="add an email…" required />
          <button type="submit">Let them in</button>
        </div>
      </form>

      <div className="card">
        {people.map((p) => (
          <div className="list-item" key={p.email}>
            <span>
              {p.email} {p.role === "owner" && <span className="tag">owner</span>}
            </span>
            {p.role !== "owner" && (
              <form action={removeMember}>
                <input type="hidden" name="email" value={p.email} />
                <button className="ghost" type="submit">
                  Remove
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
