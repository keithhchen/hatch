import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { IpInfo } from "./ipInfo.js";
import { PageSpeed } from "./pageSpeed.js";
import { PlaceSearch } from "./placeSearch.js";
import { SITE_RESEARCH_CAPABILITY, SiteResearchMode } from "./tools.js";
import { UrlScan } from "./urlScan.js";

type Call = { url: string; init: RequestInit };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fake = (handler: (call: Call) => Response) => { const calls: Call[] = []; const fetcher = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler({ url, init }); }) as typeof fetch; return { calls, fetcher }; };

test("page_speed returns a compact result: score, metrics, top 5 opportunities", async () => {
  const audits: Record<string, unknown> = { "largest-contentful-paint": { displayValue: "2.1 s", numericValue: 2100 }, "cumulative-layout-shift": { displayValue: "0", numericValue: 0 } };
  for (let i = 1; i <= 7; i++) audits[`o${i}`] = { title: `Fix ${i}`, displayValue: `${i} s`, details: { type: "opportunity", overallSavingsMs: i * 100 } };
  const { calls, fetcher } = fake(() => reply({ lighthouseResult: { finalUrl: "https://x.test/", categories: { performance: { score: 0.45 } }, audits } }));
  const result = await new PageSpeed(fetcher, "KEY").run({ url: "https://x.test/" }) as any;
  assert.equal(result.performance_score, 45);
  assert.equal(result.strategy, "mobile");
  assert.deepEqual(result.metrics.lcp, { display: "2.1 s", value: 2100 });
  assert.deepEqual(result.opportunities.map((o: { title: string }) => o.title), ["Fix 7", "Fix 6", "Fix 5", "Fix 4", "Fix 3"]);
  assert.match(calls[0]!.url, /strategy=mobile/);
});

test("an API error surfaces as a tool error, without the key", async () => {
  const { fetcher } = fake(() => reply({ error: { message: "Quota exceeded" } }, 429));
  const mode = new SiteResearchMode(new InMemoryProductCapabilities([["p", SITE_RESEARCH_CAPABILITY]]), { page_speed: new PageSpeed(fetcher, "SECRETKEY") });
  const turn = await mode.turnFor("p");
  const result = await turn!.tools.run("page_speed", { url: "https://x.test/" }) as any;
  assert.equal(result.status, "error");
  assert.match(result.error.message, /429.*Quota exceeded/);
  assert.doesNotMatch(JSON.stringify(result), /SECRETKEY/);
  assert.deepEqual(turn!.extraTools, ["site.page_speed"]);
});

test("place_search sends the query with the field mask and returns up to five places", async () => {
  const places = Array.from({ length: 7 }, (_, i) => ({ displayName: { text: `P${i}` }, formattedAddress: "addr", rating: 4.5 }));
  const { calls, fetcher } = fake(() => reply({ places }));
  const result = await new PlaceSearch(fetcher, "K").run({ query: "Aoneng" }) as any;
  assert.equal(result.places.length, 5);
  assert.equal(result.places[0].name, "P0");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["X-Goog-Api-Key"], "K");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { textQuery: "Aoneng" });
});

test("ip_info resolves a host name and reports country and network per address", async () => {
  const { calls, fetcher } = fake(() => reply({ result: { ip: { location: "CN", locationName: "China", asn: "4134", asnName: "CHINANET" } } }));
  const result = await new IpInfo(fetcher, "T", async () => ["1.2.3.4"]).run({ target: "example.test" }) as any;
  assert.deepEqual(result.ips, [{ ip: "1.2.3.4", country: "China", country_code: "CN", asn: "4134", asn_name: "CHINANET", organization: undefined }]);
  assert.match(calls[0]!.url, /ip=1\.2\.3\.4/);
  await assert.rejects(new IpInfo(fetcher, "T", async () => { throw new Error("ENOTFOUND"); }).run({ target: "nope.test" }), /no IPv4/);
});

test("url_scan always submits Unlisted, polls past 404 and summarises", async () => {
  let polls = 0;
  const { calls, fetcher } = fake(({ url }) => {
    if (url.endsWith("/scan")) return reply({ uuid: "u1" });
    return ++polls < 2 ? reply({ errors: [{ message: "not found" }] }, 404) : reply({
      task: { url: "https://x.test/" }, page: { url: "https://x.test/en", ip: "1.2.3.4", country: "CN", asn: "4134", asnname: "CHINANET" },
      data: { requests: [{ response: { response: { status: 200 } } }] },
      lists: { domains: ["x.test"], urls: ["https://www.x.test/a", "https://cdn.other.com/a.js", "https://cdn.other.com/b.js"], certificates: [{ issuer: "R3", validFrom: 1, validTo: 2 }] },
      meta: { processors: { wappa: { data: [{ app: "nginx" }] } } }
    });
  });
  const result = await new UrlScan(fetcher, "T", "acc", { pollMs: 1, maxWaitMs: 50, submitGapMs: 1 }).run({ url: "https://x.test/" }) as any;
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { url: "https://x.test/", visibility: "Unlisted" });
  assert.match(calls[0]!.url, /accounts\/acc\/urlscanner\/v2\/scan/);
  assert.deepEqual(result.third_party_domains, ["cdn.other.com"]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.technologies, ["nginx"]);
  assert.equal(result.certificate.issuer, "R3");
});

test("url_scan gives up with a timeout error when the scan never finishes", async () => {
  const { fetcher } = fake(({ url }) => url.endsWith("/scan") ? reply({ uuid: "u" }) : reply({ errors: [{ message: "nf" }] }, 404));
  await assert.rejects(new UrlScan(fetcher, "T", "acc", { pollMs: 1, maxWaitMs: 5, submitGapMs: 1 }).run({ url: "https://x.test/" }), /did not finish/);
});

test("a Product without the capability has no site tools", async () => {
  const { fetcher } = fake(() => reply({}));
  const mode = new SiteResearchMode(new InMemoryProductCapabilities(), { place_search: new PlaceSearch(fetcher, "K") });
  assert.equal(await mode.turnFor("p"), undefined);
});
