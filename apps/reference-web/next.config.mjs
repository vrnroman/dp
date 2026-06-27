/** @type {import('next').NextConfig} */
const nextConfig = {
  // @platform/auth ships TypeScript source; let Next compile it as part of this app.
  // In a deploy the platform vendors it inside the app, so the default file tracing root
  // (the app directory) already covers it.
  transpilePackages: ["@platform/auth"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
