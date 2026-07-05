// web/src/mid.ts — MMSI MID prefix → flag. Static subset: East Asia + majors + common flags of convenience.
const MID: Record<number, { country: string; flag: string }> = {
  201: { country: "Albania", flag: "🇦🇱" }, 209: { country: "Cyprus", flag: "🇨🇾" }, 210: { country: "Cyprus", flag: "🇨🇾" },
  211: { country: "Germany", flag: "🇩🇪" }, 219: { country: "Denmark", flag: "🇩🇰" }, 220: { country: "Denmark", flag: "🇩🇰" },
  224: { country: "Spain", flag: "🇪🇸" }, 225: { country: "Spain", flag: "🇪🇸" },
  226: { country: "France", flag: "🇫🇷" }, 227: { country: "France", flag: "🇫🇷" }, 228: { country: "France", flag: "🇫🇷" },
  232: { country: "United Kingdom", flag: "🇬🇧" }, 233: { country: "United Kingdom", flag: "🇬🇧" }, 234: { country: "United Kingdom", flag: "🇬🇧" }, 235: { country: "United Kingdom", flag: "🇬🇧" },
  237: { country: "Greece", flag: "🇬🇷" }, 239: { country: "Greece", flag: "🇬🇷" }, 240: { country: "Greece", flag: "🇬🇷" }, 241: { country: "Greece", flag: "🇬🇷" },
  244: { country: "Netherlands", flag: "🇳🇱" }, 245: { country: "Netherlands", flag: "🇳🇱" }, 246: { country: "Netherlands", flag: "🇳🇱" },
  247: { country: "Italy", flag: "🇮🇹" }, 248: { country: "Malta", flag: "🇲🇹" }, 249: { country: "Malta", flag: "🇲🇹" }, 256: { country: "Malta", flag: "🇲🇹" },
  257: { country: "Norway", flag: "🇳🇴" }, 258: { country: "Norway", flag: "🇳🇴" }, 259: { country: "Norway", flag: "🇳🇴" },
  263: { country: "Portugal", flag: "🇵🇹" }, 271: { country: "Türkiye", flag: "🇹🇷" }, 272: { country: "Ukraine", flag: "🇺🇦" },
  273: { country: "Russia", flag: "🇷🇺" },
  303: { country: "United States", flag: "🇺🇸" }, 304: { country: "Antigua & Barbuda", flag: "🇦🇬" }, 305: { country: "Antigua & Barbuda", flag: "🇦🇬" },
  308: { country: "Bahamas", flag: "🇧🇸" }, 309: { country: "Bahamas", flag: "🇧🇸" }, 311: { country: "Bahamas", flag: "🇧🇸" },
  312: { country: "Belize", flag: "🇧🇿" }, 338: { country: "United States", flag: "🇺🇸" },
  351: { country: "Panama", flag: "🇵🇦" }, 352: { country: "Panama", flag: "🇵🇦" }, 353: { country: "Panama", flag: "🇵🇦" },
  354: { country: "Panama", flag: "🇵🇦" }, 355: { country: "Panama", flag: "🇵🇦" }, 356: { country: "Panama", flag: "🇵🇦" }, 357: { country: "Panama", flag: "🇵🇦" },
  366: { country: "United States", flag: "🇺🇸" }, 367: { country: "United States", flag: "🇺🇸" }, 368: { country: "United States", flag: "🇺🇸" }, 369: { country: "United States", flag: "🇺🇸" },
  370: { country: "Panama", flag: "🇵🇦" }, 371: { country: "Panama", flag: "🇵🇦" }, 372: { country: "Panama", flag: "🇵🇦" }, 373: { country: "Panama", flag: "🇵🇦" },
  375: { country: "St. Vincent & Grenadines", flag: "🇻🇨" }, 376: { country: "St. Vincent & Grenadines", flag: "🇻🇨" }, 377: { country: "St. Vincent & Grenadines", flag: "🇻🇨" },
  412: { country: "China", flag: "🇨🇳" }, 413: { country: "China", flag: "🇨🇳" }, 414: { country: "China", flag: "🇨🇳" },
  416: { country: "Taiwan", flag: "🇹🇼" }, 419: { country: "India", flag: "🇮🇳" }, 422: { country: "Iran", flag: "🇮🇷" },
  431: { country: "Japan", flag: "🇯🇵" }, 432: { country: "Japan", flag: "🇯🇵" },
  440: { country: "South Korea", flag: "🇰🇷" }, 441: { country: "South Korea", flag: "🇰🇷" }, 445: { country: "North Korea", flag: "🇰🇵" },
  457: { country: "Mongolia", flag: "🇲🇳" }, 470: { country: "UAE", flag: "🇦🇪" }, 471: { country: "UAE", flag: "🇦🇪" },
  477: { country: "Hong Kong", flag: "🇭🇰" }, 511: { country: "Palau", flag: "🇵🇼" },
  514: { country: "Cambodia", flag: "🇰🇭" }, 515: { country: "Cambodia", flag: "🇰🇭" }, 518: { country: "Cook Islands", flag: "🇨🇰" },
  525: { country: "Indonesia", flag: "🇮🇩" }, 533: { country: "Malaysia", flag: "🇲🇾" }, 538: { country: "Marshall Islands", flag: "🇲🇭" },
  548: { country: "Philippines", flag: "🇵🇭" },
  563: { country: "Singapore", flag: "🇸🇬" }, 564: { country: "Singapore", flag: "🇸🇬" }, 565: { country: "Singapore", flag: "🇸🇬" }, 566: { country: "Singapore", flag: "🇸🇬" },
  567: { country: "Thailand", flag: "🇹🇭" }, 572: { country: "Tuvalu", flag: "🇹🇻" }, 574: { country: "Vietnam", flag: "🇻🇳" },
  620: { country: "Gabon", flag: "🇬🇦" }, 636: { country: "Liberia", flag: "🇱🇷" },
  667: { country: "Sierra Leone", flag: "🇸🇱" }, 671: { country: "Togo", flag: "🇹🇬" },
  674: { country: "Tanzania", flag: "🇹🇿" }, 677: { country: "Tanzania", flag: "🇹🇿" },
};

export function flagForMmsi(mmsi: number): { country: string; flag: string } | null {
  if (!Number.isInteger(mmsi) || mmsi < 100_000_000) return null;
  return MID[Math.floor(mmsi / 1_000_000)] ?? null;
}
