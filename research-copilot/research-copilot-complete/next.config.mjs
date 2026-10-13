/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Streaming routes need the Node runtime for the OpenAI SDK + long responses.
    serverComponentsExternalPackages: ["openai"],
  },
};
export default nextConfig;
