// Vercel 서버리스 함수: 좌표 → 기상청 초단기실황(getUltraSrtNcst)
// 인증키는 환경변수 KMA_SERVICE_KEY 로만 읽습니다. (코드·저장소에 키를 쓰지 않음)
const BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";

// 위도/경도 → 기상청 격자(nx, ny) : 기상청 공식 Lambert 변환식
function toGrid(lat, lng) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const D = Math.PI / 180, re = RE / GRID;
  const slat1 = SLAT1 * D, slat2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * D * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lng * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// 한국 시간 기준 base_date/base_time (실황은 매시 40분 이후 제공 → 40분 전이면 이전 시각)
function baseTime(backHours = 0) {
  const t = new Date(Date.now() + 9 * 3600 * 1000 - backHours * 3600 * 1000);
  if (backHours === 0 && t.getUTCMinutes() < 40) t.setUTCHours(t.getUTCHours() - 1);
  const p = (n) => String(n).padStart(2, "0");
  return { date: `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`, time: `${p(t.getUTCHours())}00` };
}

async function request(key, nx, ny, bt) {
  const qs = new URLSearchParams({ pageNo: "1", numOfRows: "10", dataType: "JSON", base_date: bt.date, base_time: bt.time, nx: String(nx), ny: String(ny) });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
  try {
    // serviceKey 는 이미 인코딩된 값일 수 있어 그대로 붙임
    const res = await fetch(`${BASE}?serviceKey=${key}&${qs}`, { signal: ctl.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("기상청이 JSON이 아닌 응답을 보냈어요"); }
    const head = json && json.response && json.response.header;
    if (!head) throw new Error("기상청 응답 형식이 달라요");
    if (head.resultCode !== "00") throw new Error(`기상청 오류 ${head.resultCode} ${head.resultMsg || ""}`.trim());
    const items = json.response.body && json.response.body.items && json.response.body.items.item;
    if (!items || !items.length) throw new Error("해당 시각의 관측 자료가 아직 없어요");
    return items;
  } finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");
  try {
    const key = process.env.KMA_SERVICE_KEY;
    if (!key) return res.status(500).json({ error: "서버에 KMA_SERVICE_KEY 환경변수가 설정되지 않았어요" });
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 32 || lat > 34.5 || lng < 125 || lng > 128)
      return res.status(400).json({ error: "제주 지역의 위도·경도가 필요해요" });

    const { nx, ny } = toGrid(lat, lng);
    let bt = baseTime(), items;
    try { items = await request(key, nx, ny, bt); }
    catch (e) { bt = baseTime(1 + (bt.time === baseTime(1).time ? 1 : 0)); items = await request(key, nx, ny, bt); } // 한 번만 이전 시각으로 재시도

    const v = {};
    items.forEach((i) => { v[i.category] = i.obsrValue; });
    const num = (x) => (x === undefined || x === "" ? null : Number(x));
    return res.status(200).json({
      nx, ny, base_date: bt.date, base_time: bt.time,
      temperature: num(v.T1H), humidity: num(v.REH), wind_speed: num(v.WSD), wind_direction: num(v.VEC),
      rain_1h: v.RN1 === undefined ? null : v.RN1, pty: num(v.PTY) || 0,
    });
  } catch (e) {
    // 키 값 등 민감 정보가 메시지에 섞이지 않도록 일반화해서 응답
    const msg = e && e.name === "AbortError" ? "기상청 응답 시간 초과" : String((e && e.message) || "알 수 없는 오류").replace(/serviceKey=[^&\s]+/gi, "serviceKey=***");
    return res.status(502).json({ error: msg });
  }
};
