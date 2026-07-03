import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser, groupsOverview, listPeople, signupMode } from "@platform/auth/next";
import {
  makeGroup,
  removeGroup,
  addToGroup,
  takeFromGroup,
  chooseGroupRoles,
} from "../actions.ts";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const user = await getUser();
  if (!user) redirect("/signin");
  if (user.role !== "owner") redirect("/");

  const { groups, specs, defaultRole } = await groupsOverview();
  const people = await listPeople();
  const canFor = (role: string) => specs.find((s) => s.name === role)?.can ?? role;
  const everyoneCan = defaultRole ? canFor(defaultRole) : null;
  const inviteOnly = signupMode() === "invite";

  return (
    <main>
      <header className="top">
        <h1>Who&apos;s in</h1>
        <Link className="ghost btn" href="/">
          Back
        </Link>
      </header>

      <div className="banner">
        {inviteOnly
          ? `Only people you invite can sign in${everyoneCan ? `, and they can ${everyoneCan}` : ""}. `
          : `Anyone can sign in with Google${everyoneCan ? ` and ${everyoneCan}` : ""}. `}
        To let some people do more, make a group and drop them into it.
      </div>

      {/* Make a new group */}
      <form className="card" action={makeGroup}>
        <div className="row">
          <input type="text" name="name" placeholder="name a group, e.g. Family" required />
          <button type="submit">Make a group</button>
        </div>
      </form>

      {/* Each group: what it can do, and who is in it */}
      {groups.map((g) => (
        <div className="card" key={g.id}>
          <div className="list-item">
            <strong>{g.name}</strong>
            <form action={removeGroup}>
              <input type="hidden" name="groupId" value={g.id} />
              <button className="ghost" type="submit">
                Delete group
              </button>
            </form>
          </div>

          {/* What this group can do — the app's own plain sentences, never the word "role" */}
          <form action={chooseGroupRoles} style={{ marginTop: 8 }}>
            <input type="hidden" name="groupId" value={g.id} />
            <p className="muted" style={{ margin: "0 0 6px" }}>
              People in this group can:
            </p>
            {specs.map((s) => (
              <label key={s.name} style={{ display: "block", marginBottom: 4 }}>
                <input type="checkbox" name="role" value={s.name} defaultChecked={g.roles.includes(s.name)} />{" "}
                {s.can}
              </label>
            ))}
            <button className="ghost" type="submit" style={{ marginTop: 6 }}>
              Save what they can do
            </button>
          </form>

          {/* Who is in this group */}
          <div style={{ marginTop: 10 }}>
            {g.members.length === 0 && <p className="muted">Nobody here yet.</p>}
            {g.members.map((email) => (
              <div className="list-item" key={email}>
                <span>{email}</span>
                <form action={takeFromGroup}>
                  <input type="hidden" name="groupId" value={g.id} />
                  <input type="hidden" name="email" value={email} />
                  <button className="ghost" type="submit">
                    Take out
                  </button>
                </form>
              </div>
            ))}
          </div>

          <form action={addToGroup} style={{ marginTop: 8 }}>
            <input type="hidden" name="groupId" value={g.id} />
            <div className="row">
              <input type="email" name="email" placeholder="add someone by email…" required />
              <button type="submit">Add</button>
            </div>
          </form>
        </div>
      ))}

      {/* Just arrived — everyone who has signed in, newest first */}
      {people.length > 0 && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Just arrived
          </p>
          {people.map((p) => (
            <div className="list-item" key={p.email}>
              <span>
                {p.name ? `${p.name} · ` : ""}
                {p.email}
              </span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
