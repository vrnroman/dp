import Link from "next/link";
import { doSignIn } from "../actions.ts";

const messages: Record<string, string> = {
  "not-allowed": "That email is not on the list yet. Ask the owner to let you in.",
  "invalid-email": "That does not look like an email address. Try again.",
};

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message = reason ? messages[reason] : null;

  return (
    <main>
      <header className="top">
        <h1>Sign in</h1>
        <Link className="ghost btn" href="/">
          Back
        </Link>
      </header>

      {message && <div className="banner">{message}</div>}

      <form className="card" action={doSignIn}>
        <p className="muted" style={{ marginTop: 0 }}>
          Enter your email. If you are on the list, you are in.
        </p>
        <div className="field">
          <input type="email" name="email" placeholder="you@example.com" required autoFocus />
        </div>
        <button type="submit">Let me in</button>
      </form>
    </main>
  );
}
