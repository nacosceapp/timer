/** @type {import('next').NextConfig} */
const isGithubPages = process.env.GITHUB_PAGES === "true";

const nextConfig = {
  output: "export",
  images: {
    unoptimized: true
  },
  trailingSlash: true,
  basePath: isGithubPages ? "/timer" : undefined,
  assetPrefix: isGithubPages ? "/timer/" : undefined,
  experimental: {
    typedRoutes: false
  }
};

export default nextConfig;
