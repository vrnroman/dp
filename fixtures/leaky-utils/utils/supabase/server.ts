// Regression fixture: a secret hidden in utils/ (where the Supabase Next.js quickstart puts
// it). The conformance scanner must catch this, not just secrets in app/ or lib/.
export const serviceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.s3cr3t-signature-value-1234567890";
