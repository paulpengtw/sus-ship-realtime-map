// web/src/shiptype.ts — AIS ship-and-cargo type code → label (ITU-R M.1371 table).
export function shipTypeLabel(t: number | null | undefined): string {
  if (t == null) return "Unknown type";
  if (t === 30) return "Fishing";
  if (t === 31 || t === 32) return "Towing";
  if (t === 33) return "Dredging";
  if (t === 34) return "Diving ops";
  if (t === 35) return "Military";
  if (t === 36) return "Sailing";
  if (t === 37) return "Pleasure craft";
  if (t >= 40 && t <= 49) return "High-speed craft";
  if (t === 50) return "Pilot vessel";
  if (t === 51) return "Search & rescue";
  if (t === 52) return "Tug";
  if (t === 53) return "Port tender";
  if (t === 55) return "Law enforcement";
  if (t >= 60 && t <= 69) return "Passenger";
  if (t >= 70 && t <= 79) return "Cargo";
  if (t >= 80 && t <= 89) return "Tanker";
  return `Other (${t})`;
}
