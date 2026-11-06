// Load ./.env if present (Node >= 20.12 built-in; no dotenv dependency). Real env vars win.
import { existsSync } from "node:fs";

if (existsSync(".env") && typeof (process as any).loadEnvFile === "function") {
  (process as any).loadEnvFile(".env");
}
