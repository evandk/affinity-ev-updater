import axios from "axios";

const LIST_ID = 300305;
const FID_MIN = "field-5140816";
const FID_MAX = "field-5140817";
const FID_P   = "field-5150465";
const FID_EV  = "field-5305096";
const ZERO_AS_MISSING = true;

const V2 = axios.create({
  baseURL: "https://api.affinity.co/v2",
  headers: {
    Authorization: `Bearer ${process.env.AFFINITY_V2_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

function coerceObj(x) {
  if (typeof x === "string") {
    try { return JSON.parse(x); } catch { return {}; }
  }
  return x || {};
}

const safeNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

function computeEV(min, max, pPct) {
  let mi = safeNum(min), ma = safeNum(max);
  if (ZERO_AS_MISSING) {
    if (mi === 0 && ma > 0) mi = null;
    if (ma === 0 && mi > 0) ma = null;
  }
  const m = mi != null && ma != null ? (mi + ma) / 2 : (mi ?? ma ?? 0);
  const p = Math.max(0, Math.min(100, safeNum(pPct) ?? 0)) / 100;
  return Math.round(m * p);
}

export default async function handler(req, res) {
  try {
    if (!process.env.AFFINITY_V2_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing AFFINITY_V2_TOKEN" });
    }

    // Affinity webhooks often nest body twice
    const outer = coerceObj(req.body);
    const payload = coerceObj(outer.body) || outer;

    const listEntryId = String(
      payload.list_entry_id ??
      payload.listEntryId ??
      payload?.data?.list_entry_id ??
      ""
    );
    const eventListId = Number(payload?.field?.list_id ?? payload?.list_id ?? LIST_ID);

    if (!listEntryId) return res.status(200).json({ skipped: true, reason: "no_list_entry_id", payload });
    if (eventListId !== LIST_ID) return res.status(200).json({ skipped: true, reason: "different_list", eventListId });

    // Per-entry read
    const { data: fieldsResp } = await V2.get(`/lists/${LIST_ID}/list-entries/${listEntryId}/fields`);
    const fieldMap = new Map((fieldsResp?.data ?? []).map(f => [String(f.id), f.value?.data]));
    const min = safeNum(fieldMap.get(FID_MIN));
    const max = safeNum(fieldMap.get(FID_MAX));
    const p   = safeNum(fieldMap.get(FID_P));
    const ev  = computeEV(min, max, p);

    // Write EV
    const post = await V2.post(
      `/lists/${LIST_ID}/list-entries/${listEntryId}/fields/${FID_EV}`,
      { value: { type: "number", data: ev } }
    );
    if (post.status < 200 || post.status >= 300) {
      return res.status(200).json({ ok: false, step: "post_ev", status: post.status, data: post.data, listEntryId, min, max, p, ev });
    }

    // Verify
    const { data: after } = await V2.get(`/lists/${LIST_ID}/list-entries/${listEntryId}/fields`);
    const persisted = safeNum(new Map((after?.data ?? []).map(f => [String(f.id), f.value?.data])).get(FID_EV));

    return res.status(200).json({ ok: true, listEntryId, min, max, p, ev, persisted });
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || e.message;
    return res.status(200).json({ ok: false, error: { status, data } });
  }
}


