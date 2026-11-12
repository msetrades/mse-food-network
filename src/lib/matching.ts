export type OfferMatchInput = { expires_at: string; pickup_region: string; storage: string };

export function hoursLeft(value: string, now: number) {
  return Math.max(0, Math.ceil((new Date(value).getTime() - now) / 3_600_000));
}

export function matchScore(offer: OfferMatchInput, region: string, now: number) {
  const expiry = hoursLeft(offer.expires_at, now);
  const urgency = expiry <= 12 ? 42 : expiry <= 24 ? 33 : expiry <= 48 ? 24 : 12;
  const normalizedRegion = region.trim().toLowerCase();
  const pickupRegion = offer.pickup_region.trim().toLowerCase();
  const local = pickupRegion === normalizedRegion;
  const proximity = local
    ? 38
    : offer.pickup_region.trim().toLowerCase().split(/[ ,/-]+/).some((word) => word.length > 2 && normalizedRegion.includes(word)) ? 22 : 8;
  const storage = offer.storage.toLowerCase();
  const handling = storage.includes("ambient") || storage.includes("dry") ? 20 : 12;
  return { score: Math.min(100, urgency + proximity + handling), local, urgency };
}
