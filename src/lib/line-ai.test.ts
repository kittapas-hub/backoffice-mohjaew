import assert from "node:assert";
import { parseCampaignDrafts } from "./line-ai.ts";

const draft = { headline: "หัวข้อ", body: "เนื้อหา", cta: "จองคิว", angle: "ช่วยตัดสินใจ", caution: "ไม่รับประกันผล" };
assert.deepEqual(parseCampaignDrafts(JSON.stringify({ drafts: [draft, draft, draft] })), [draft, draft, draft]);
assert.deepEqual(parseCampaignDrafts({ drafts: [draft, draft, draft] }), [draft, draft, draft]);
assert.equal(parseCampaignDrafts("not json"), null);
assert.equal(parseCampaignDrafts({}), null);
assert.equal(parseCampaignDrafts({ drafts: [draft] }), null);
assert.equal(parseCampaignDrafts({ drafts: [draft, draft, { ...draft, body: "" }] }), null);

console.log("LINE AI parser self-check passed");
