/**
 * Run the CLI from source (same options as `npx @itsoltech/jev-code-review`), for example:
 *
 *   npm run review-local -- --base main
 *   npm run review-local -- --pr 389 --repo itsoltech/canopy-desktop --config examples/canopy/jev-review.yml
 *
 * See `npm run review-local -- --help`.
 */
import { runCli, systemIo } from "../src/cli/main.js";

process.exitCode = await runCli(process.argv.slice(2), systemIo());
