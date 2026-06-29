// A deliberately "interesting" app for the compliance evaluator: it reaches two third-party
// systems and stores personal data with no sign-in. The reviewer should surface all of that.

export async function charge(amount: number, token: string) {
  // Real outbound connection to a third-party payment API.
  return fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    body: new URLSearchParams({ amount: String(amount), source: token }),
  });
}

export async function summarize(text: string) {
  // A second third-party system.
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    body: JSON.stringify({ input: text }),
  });
}
