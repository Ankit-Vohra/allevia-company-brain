// A fake public-data door for tests: records each run, answers from a per-actor script, and spends nothing. The fixture
// items have the shapes the real actors return (camelCase, the odd snake_case field, hidden likes as -1).
import type { ActorId } from "../../src/publicdata/actors.js";
import type { PublicDataPort, PublicRun, PublicRunRequest } from "../../src/publicdata/service.js";

export type Script = Partial<Record<ActorId, (req: PublicRunRequest) => unknown[] | PublicRun>>;

export class FakePublicData implements PublicDataPort {
  readonly enabled = true;
  runs: PublicRunRequest[] = [];
  constructor(public script: Script, private readonly asOf = "2026-10-15T09:00:00.000Z") {}
  quote(): number { return 0.01; }
  budget() { return { spentThisMonth: 0, monthly: 2, spentToday: 0, daily: 3 }; }
  async run(req: PublicRunRequest): Promise<PublicRun> {
    this.runs.push(req);
    const fn = this.script[req.actor as ActorId];
    if (!fn) return { ok: false, reason: "error", why: `no fake for ${req.actor}` };
    const out = fn(req);
    if (!Array.isArray(out)) return out;
    return { ok: true, actor: req.actor as ActorId, items: out, usd: 0.02, asOf: this.asOf };
  }
}

export const placeItem = (o: { website?: string; title?: string } = {}) => ({
  title: o.title ?? "Kestrel Bakes", placeId: "ChIJfakeplace0001", url: "https://www.google.com/maps/place/?q=place_id:ChIJfakeplace0001",
  address: "12 Mill Lane, Leeds LS1 4AB, United Kingdom", city: "Leeds", countryCode: "GB", categoryName: "Bakery",
  website: o.website ?? "https://kestrelbakes.example/", phone: "+44 7700 900123", totalScore: 4.6, reviewsCount: 132,
  openingHours: [{ day: "Monday", hours: "8 AM–5 PM" }, { day: "Sunday", hours: "Closed" }],
  reviews: [
    { name: "Jane Q. Doe", reviewerId: "1234567890", reviewerUrl: "https://www.google.com/maps/contrib/1234567890", stars: 5, publishedAtDate: "2026-10-10T10:00:00.000Z", reviewId: "rev-1",
      text: "Best sourdough in Leeds. Ask for Sam, or mail jane.doe@example.com", responseFromOwnerText: "Thank you!" },
    { name: "M", stars: 2, publishedAtDate: "2026-10-02T10:00:00.000Z", reviewId: "rev-2", text: "Queue was long. Call me on +44 7700 900456" },
    { name: "Ravi", stars: 4, publishedAtDate: "2026-09-28T10:00:00.000Z", reviewId: "rev-3", text: null },
  ],
});

const post = (i: number, o: { likes?: number; comments?: number; views?: number; type?: string } = {}) => ({
  type: o.type ?? "Image", shortCode: `Cfake${i}`, url: `https://www.instagram.com/p/Cfake${i}/`, caption: `Fresh bake number ${i}`,
  likesCount: o.likes ?? 100 + i, commentsCount: o.comments ?? 10, ...(o.views !== undefined ? { videoViewCount: o.views } : {}),
  timestamp: new Date(Date.parse("2026-10-14T08:00:00Z") - i * 2 * 86_400_000).toISOString(),
});

export const igItem = (handle: string, o: { followers?: number; private?: boolean; posts?: number } = {}) => ({
  username: handle, fullName: handle === "kestrelbakes" ? "Kestrel Bakes" : "Rival Rolls", followersCount: o.followers ?? 2000, followsCount: 300,
  postsCount: 240, private: o.private ?? false, isBusinessAccount: true, businessCategoryName: "Bakery",
  biography: "Bakery in Leeds. Orders: hello@example.com",
  latestPosts: Array.from({ length: o.posts ?? 6 }, (_, i) => post(i, i === 1 ? { likes: 900, comments: 40, type: "Video", views: 12000 } : i === 4 ? { likes: -1 } : {})),
});

export const metaAds = () => [
  { adArchiveID: "111222333", pageName: "Rival Rolls", isActive: true, startDate: 1759276800, publisherPlatform: ["FACEBOOK", "INSTAGRAM"],
    snapshot: { body: { text: "Two croissants for 3 pounds this week" }, title: "Croissant week", cta_text: "Order now", link_url: "https://rivalrolls.example/offer", display_format: "IMAGE" } },
  { ad_archive_id: "444555666", page_name: "Rival Rolls", is_active: false, start_date: "1756684800", end_date: "1757289600",
    snapshot: { body: "Summer sourdough", cta_text: "Learn more" } },
];

export const googleAds = () => [
  { advertiserName: "Rival Rolls Ltd", creativeId: "CR0001fake", format: "TEXT", firstShown: "2026-09-01", lastShown: "2026-10-14", url: "https://adstransparency.google.com/advertiser/AR0001fake" },
];
