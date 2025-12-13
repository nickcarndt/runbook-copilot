/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize pdf-parse on the server to prevent bundling
      // This ensures the patched version from node_modules is used
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push('pdf-parse');
      } else {
        config.externals = [config.externals, 'pdf-parse'];
      }
    }
    return config;
  },
};

module.exports = nextConfig;

