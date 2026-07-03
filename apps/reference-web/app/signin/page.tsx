import Link from "next/link";

// Plain-English reasons the front door might turn someone away. Never jargon.
const messages: Record<string, string> = {
  "not-allowed": "You are not on the guest list yet. Ask the owner to let you in.",
  cancelled: "No problem, nothing happened. You can try again whenever you like.",
  expired: "That took a little too long. Please try signing in again.",
  "bad-state": "Something did not line up. Please try signing in again.",
  "bad-callback": "Something did not line up. Please try signing in again.",
  "verify-failed": "We could not confirm that sign-in. Please try again.",
};

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message = reason ? messages[reason] ?? "Please try signing in again." : null;

  return (
    <main>
      <header className="top">
        <h1>Sign in</h1>
        <Link className="ghost btn" href="/">
          Back
        </Link>
      </header>

      {message && <div className="banner">{message}</div>}

      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Sign in to leave a note. It takes one tap.
        </p>
        <a className="btn" href="/auth/google" style={{ display: "inline-block" }}>
          Continue with Google
        </a>
      </div>
    </main>
  );
}
