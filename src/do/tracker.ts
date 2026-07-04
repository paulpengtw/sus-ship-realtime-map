export class TrackerDO implements DurableObject {
  async fetch(_req: Request): Promise<Response> {
    return new Response("ok");
  }
}
