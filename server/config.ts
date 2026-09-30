import { env, argv } from "node:process";

export const dev = !argv.includes("--packaged") && !env.CITROPY_REMOTE_ID && (argv.includes("--dev") || env.CITROPY_DEVELOPMENT === "1");
export const port = Number(env.CITROPY_PORT ?? (dev ? 4278 : 4277));
export const host = env.CITROPY_HOST ?? "127.0.0.1";
export const origin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
export const developmentOrigin = `http://127.0.0.1:${env.CITROPY_UI_PORT ?? 5277}`;
