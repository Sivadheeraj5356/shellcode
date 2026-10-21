import { maybeRunSubcommand } from "./cli";

if (await maybeRunSubcommand(process.argv.slice(2))) process.exit(process.exitCode ?? 0);

const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { App } = await import("./app");
const renderer = await createCliRenderer({ targetFps: 60, exitOnCtrlC: false });
createRoot(renderer).render(<App />);
