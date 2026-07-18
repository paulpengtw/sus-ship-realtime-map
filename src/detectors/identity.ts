import type { Config } from "../config";
import { haversineM } from "../geo/geo";
import type { AisIdentity, AisPosition, AnomalyEvent, VesselState } from "../types";

// MMSI MID (first 3 digits) → ISO country, strait-relevant subset. Extend as needed.
const MID: Record<string, string> = {
  "412": "CN", "413": "CN", "414": "CN", "416": "TW", "440": "KR", "441": "KR",
  "431": "JP", "432": "JP", "273": "RU", "511": "PW", "352": "PA", "354": "PA",
  "353": "PA", "563": "SG", "564": "SG", "477": "HK", "312": "BZ", "620": "GA",
  "572": "TV", "574": "VN", "533": "MY", "667": "SL", "671": "TG",
};

// ITU callsign prefix → ISO country, same subset. First match on 2-char then 1-char prefix.
const CALLSIGN: Record<string, string> = {
  "BV": "TW", "BM": "TW", "BN": "TW", "BO": "TW", "BQ": "TW",
  "3E": "PA", "3F": "PA", "H3": "PA", "H8": "PA", "H9": "PA", "HO": "PA", "HP": "PA",
  "9V": "SG", "HL": "KR", "DS": "KR", "JA": "JP", "7J": "JP", "UA": "RU", "T8": "PW",
  "V3": "BZ", "TR": "GA", "T2": "TV", "XV": "VN", "9M": "MY",
};

export function midCountry(mmsi: number): string | null {
  return MID[String(mmsi).padStart(9, "0").slice(0, 3)] ?? null;
}

export function callsignCountry(callsign: string): string | null {
  const cs = callsign.trim().toUpperCase();
  if (!cs) return null;
  return CALLSIGN[cs.slice(0, 2)] ?? CALLSIGN[cs.slice(0, 1)] ?? null;
}

export function identityOnStatic(s: VesselState, ident: AisIdentity, cfg: Config): AnomalyEvent[] {
  const out: AnomalyEvent[] = [];
  const real = (v: string) => { const t = v.trim(); return t !== "" && t !== "0"; };
  const prev = s.identities.length ? s.identities[s.identities.length - 1] : null;
  const rawChanged = prev !== null && (prev.name !== ident.name || prev.callsign !== ident.callsign);
  const changed = prev !== null && (
    (real(prev.name) && real(ident.name) && prev.name !== ident.name) ||
    (real(prev.callsign) && real(ident.callsign) && prev.callsign !== ident.callsign)
  );

  if (changed) {
    out.push({
      id: `identity-${s.mmsi}-${ident.ts}`,
      type: "identity", severity: 4, mmsi: s.mmsi,
      lon: s.ring.length ? s.ring[s.ring.length - 1].lon : 0,
      lat: s.ring.length ? s.ring[s.ring.length - 1].lat : 0,
      startTs: ident.ts, endTs: ident.ts,
      evidence: { kind: "identity_change", prevName: prev.name, newName: ident.name, prevCallsign: prev.callsign, newCallsign: ident.callsign },
    });
  }

  if (prev === null || rawChanged) {
    s.identities.push(ident);
    if (s.identities.length > cfg.identityHistorySize) s.identities.shift();

    const mc = midCountry(ident.mmsi);
    const cc = callsignCountry(ident.callsign);
    if (mc && cc && mc !== cc) {
      out.push({
        id: `identity-${s.mmsi}-${ident.ts}-flag`,
        type: "identity", severity: 4, mmsi: s.mmsi,
        lon: s.ring.length ? s.ring[s.ring.length - 1].lon : 0,
        lat: s.ring.length ? s.ring[s.ring.length - 1].lat : 0,
        startTs: ident.ts, endTs: ident.ts,
        evidence: { kind: "flag_mismatch", midCountry: mc, callsignCountry: cc, callsign: ident.callsign },
      });
    }
  }

  s.name = ident.name;
  s.callsign = ident.callsign;
  return out;
}

export function teleportOnMessage(s: VesselState, msg: AisPosition, cfg: Config): AnomalyEvent[] {
  const lp = s.ring.length ? s.ring[s.ring.length - 1] : null;
  if (!lp) return [];
  const dtMs = msg.ts - lp.ts;
  if (dtMs <= 0 || dtMs > cfg.teleportMaxGapMs) return [];
  const distM = haversineM([lp.lon, lp.lat], [msg.lon, msg.lat]);
  const impliedSpeedKn = distM / 1852 / (dtMs / 3_600_000);
  if (impliedSpeedKn <= cfg.impossibleSpeedKn) return [];
  return [{
    id: `identity-${s.mmsi}-${msg.ts}-teleport`,
    type: "identity", severity: 4, mmsi: s.mmsi,
    lon: msg.lon, lat: msg.lat,
    startTs: lp.ts, endTs: msg.ts,
    evidence: { kind: "teleport", impliedSpeedKn: Math.round(impliedSpeedKn), distanceM: Math.round(distM), dtMs, from: [lp.lon, lp.lat], to: [msg.lon, msg.lat] },
  }];
}
