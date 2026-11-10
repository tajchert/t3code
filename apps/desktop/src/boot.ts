// Fork flavor: a packaged build keeps its own T3 home and Electron profile so it
// runs beside the official app. See FORK.md. Dev runs keep upstream behaviour.
if (!process.env.VITE_DEV_SERVER_URL) {
  process.env.T3CODE_HOME ||= require("node:path").join(require("node:os").homedir(), ".t3-custom");
  process.env.T3CODE_DESKTOP_USER_DATA_DIR ||= "t3code-custom";
}
require("./compileCache.cjs");
require("./main.cjs");
