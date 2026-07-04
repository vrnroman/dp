// Finish sign-in when it came through the platform auth relay (relay mode). The platform verifies
// the relay's signed identity assertion and sets the session. No-op env in direct-Google mode.
export { googleComplete as GET } from "@platform/auth/next";
