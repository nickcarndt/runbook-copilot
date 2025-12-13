/** @type {import('next').NextConfig} */
const nextConfig = {
  // Externalize pdf-parse to prevent bundling issues in serverless environments
  serverExternalPackages: ['pdf-parse'],
};

module.exports = nextConfig;

