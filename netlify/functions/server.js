// This file is overwritten at build time by: cp server.js netlify/functions/server.js
// See netlify.toml build command.
// If you are seeing this, the build step did not run.
export const handler = async () => ({ statusCode: 500, body: "Build step did not run." });
