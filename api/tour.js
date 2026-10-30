// Vercel 서버리스 함수: 좌표 → 주변 관광지 (한국관광공사 국문 관광정보 서비스, 위치기반 조회)
// 인증키는 환경변수 KTO_SERVICE_KEY 로만 읽습니다. (코드·저장소에 키를 쓰지 않음)
const BASE = "https://apis.data.go.kr/B551011/KorService2/locationBasedList2";
const TYPES = { 12: "관광지", 14: "문화시설", 15: "축제·공연", 25: "여행코스", 28: "레포츠", 32: "숙박", 38: "쇼핑", 39: "음식점" };

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=3600");
  try {
    const key = process.env.KTO_SERVICE_KEY;
    if (!key) return res.status(500).json({ error: "서버에 KTO_SERVICE_KEY 환경변수가 설정되지 않았어요" });
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 32 || lat > 34.5 || lng < 125 || lng > 128)
      return res.status(400).json({ error: "제주 지역의 위도·경도가 필요해요" });

    const qs = new URLSearchParams({
      MobileOS: "ETC", MobileApp: "JejuHistory", _type: "json", arrange: "E",
      mapX: String(lng), mapY: String(lat), radius: "5000", numOfRows: "6", pageNo: "1",
    });
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    let text;
    try {
      // serviceKey 는 이미 인코딩된 값일 수 있어 그대로 붙임
      const r = await fetch(`${BASE}?serviceKey=${key}&${qs}`, { signal: ctl.signal });
      text = await r.text();
    } finally { clearTimeout(timer); }

    let json;
    try { json = JSON.parse(text); } catch { throw new Error("한국관광공사가 JSON이 아닌 응답을 보냈어요"); }
    const head = json && json.response && json.response.header;
    if (!head) throw new Error("한국관광공사 응답 형식이 달라요");
    if (head.resultCode !== "0000") throw new Error(`한국관광공사 오류 ${head.resultCode} ${head.resultMsg || ""}`.trim());

    const body = json.response.body || {};
    const raw = body.items && body.items.item ? body.items.item : [];
    const list = (Array.isArray(raw) ? raw : [raw]).map((i) => ({
      title: i.title, address: [i.addr1, i.addr2].filter(Boolean).join(" "),
      type: TYPES[i.contenttypeid] || "기타", dist: i.dist ? Math.round(Number(i.dist)) : null,
      tel: i.tel || "",
    }));
    return res.status(200).json({ total: body.totalCount || list.length, items: list });
  } catch (e) {
    // 키 값 등 민감 정보가 메시지에 섞이지 않도록 일반화해서 응답
    const msg = e && e.name === "AbortError" ? "한국관광공사 응답 시간 초과" : String((e && e.message) || "알 수 없는 오류").replace(/serviceKey=[^&\s]+/gi, "serviceKey=***");
    return res.status(502).json({ error: msg });
  }
};
