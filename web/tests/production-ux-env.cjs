// Explicit task and loopback origins; never use a production login/session.
const fs = require("node:fs");
const path = require("node:path");
const project = process.env.MW_UX_PROJECT;
if (!/^mw-ux-acceptance-[a-z0-9-]+$/.test(project || ""))
  throw Error("Set MW_UX_PROJECT to a new task-owned UX acceptance project");
function loopback(name) {
  const url = new URL(process.env[name]);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw Error(name + " must be a loopback HTTP origin with explicit port");
  return url.origin;
}
const root = path.resolve(__dirname, "../..");
const privateDir = "/tmp/" + project + "-private";
const out = path.join(root, "artifacts", project);
fs.mkdirSync(out, { recursive: true });
module.exports = {
  root,
  project,
  privateDir,
  out,
  base: loopback("MW_UX_BASE"),
  origin: loopback("MW_UX_CHART_ORIGIN"),
  password: fs.readFileSync(path.join(privateDir, "password"), "utf8"),
};
