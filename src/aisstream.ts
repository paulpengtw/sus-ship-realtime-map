// src/aisstream.ts — AISStream.io wire format → internal types. Never throws.
import type { AisIdentity, AisPosition } from "./types";

export function parseAisTime(s: string): number | null {
  // "2026-07-04 12:34:56.789101 +0000 UTC" → ISO
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? \+0000 UTC$/.exec(s);
  if (!m) return null;
  const frac = m[3] ? m[3].slice(0, 4) : "";
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function parseAisStreamMessage(raw: unknown): { pos?: AisPosition; ident?: AisIdentity } | null {
  try {
    const r = raw as any;
    if (!r || typeof r !== "object" || !r.MetaData) return null;
    const mmsi = Number(r.MetaData.MMSI);
    const ts = parseAisTime(String(r.MetaData.time_utc ?? ""));
    if (!Number.isInteger(mmsi) || mmsi <= 0 || ts === null) return null;

    if (r.MessageType === "PositionReport" && r.Message?.PositionReport) {
      const pr = r.Message.PositionReport;
      const lat = Number(r.MetaData.latitude), lon = Number(r.MetaData.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const heading = Number(pr.TrueHeading);
      return {
        pos: {
          mmsi, lon, lat,
          sog: Number(pr.Sog) || 0,
          cog: Number(pr.Cog) || 0,
          heading: Number.isFinite(heading) && heading !== 511 ? heading : null,
          ts,
        },
      };
    }

    if (r.MessageType === "ShipStaticData" && r.Message?.ShipStaticData) {
      const sd = r.Message.ShipStaticData;
      return { ident: { mmsi, name: String(sd.Name ?? "").trim(), callsign: String(sd.CallSign ?? "").trim(), shipType: null, ts } };
    }

    return null;
  } catch {
    return null;
  }
}
