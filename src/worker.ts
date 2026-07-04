export { TrackerDO } from "./do/tracker";

export interface Env {
  DB: D1Database;
  TRACKER: DurableObjectNamespace;
  ASSETS: Fetcher;
  AISSTREAM_KEY: string;
  GFW_TOKEN: string;
}

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
