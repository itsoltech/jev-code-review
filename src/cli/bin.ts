import { runCli, systemIo } from "./main.js";

process.exitCode = await runCli(process.argv.slice(2), systemIo());
