/**
 * Bundled impostor (other-human) baseline for gate calibration (spec 04 §5 →
 * eval-harness §6 §12.2). The hybrid impostor source (see build-profile.ts) unions
 * this fixed baseline with any OTHER authors present in storage, so calibration
 * works on day one (when the operator is the only voice) and sharpens as more
 * authorized voices are onboarded.
 *
 * These are short, register-varied snippets of generic human prose in distinct
 * voices — deliberately NOT the operator's. Keep them mundane and impersonal; their
 * only job is to be "human, but not you" so Cosine-Delta has a contrast class.
 * Expand this set over time; it is the floor, not the ceiling, of the negatives.
 */
export const BUNDLED_NEGATIVES: string[] = [
  "Hi all, just a quick heads up that the office will be closed on Monday for the public holiday. Normal hours resume Tuesday. If you need building access over the long weekend let facilities know by end of day Friday so they can arrange a pass.",
  "Thanks for getting back to me so fast. I went through the numbers again last night and I think the second option actually makes more sense once you factor in the renewal. Happy to jump on a call tomorrow morning if that's easier than going back and forth over email.",
  "honestly the new place is great. kitchen's a bit small but the light in the mornings is unreal. took the dog to the park down the road and there's a little cafe on the corner that does a decent flat white. come visit whenever, the spare room's made up.",
  "Per the attached agenda, the committee will convene at 10:00 to review the quarterly submissions. Members are asked to read the briefing pack beforehand and to declare any conflicts of interest at the start of the session. Apologies should be sent to the secretariat.",
  "I've been meaning to write this review for ages. The book starts slow — the first hundred pages are mostly setup — but stick with it. By the midpoint the two timelines start to braid together and it becomes genuinely hard to put down. The ending divided our whole book club.",
  "Quick one: the deploy went out at 3pm and so far everything looks stable. Error rates are flat and latency's actually down a touch. I'll keep an eye on the dashboards through the evening and shout if anything moves. Nice work everyone, this was a long one.",
  "We regret to inform passengers that the 18:42 service to the coast is delayed by approximately twenty minutes due to a signalling fault further down the line. We apologise for the inconvenience and thank you for your patience. Refreshments are available in the front carriage.",
  "ok so i finally tried the recipe and a few notes for next time: halve the salt, the sauce was way too tight so add the pasta water earlier, and honestly it needs a squeeze of lemon at the end to lift it. otherwise really good, would make again, the kids actually ate it.",
  "Dear Sir or Madam, I am writing to formally request a copy of my account statements for the past twelve months. I have been unable to locate them in the online portal and would be grateful if you could post hard copies to the address on file at your earliest convenience.",
  "the trail was tougher than the guidebook made out. first couple of miles are gentle but then it just goes straight up for what feels like forever. worth it at the top though — you can see the whole valley and on a clear day apparently the sea. bring more water than you think.",
];
