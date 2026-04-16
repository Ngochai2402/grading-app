const express = require(‘express’);
const multer = require(‘multer’);
const path = require(‘path’);
const fs = require(‘fs’);
const Anthropic = require(’@anthropic-ai/sdk’);
const { GoogleGenerativeAI } = require(’@google/generative-ai’);
const { v4: uuidv4 } = require(‘uuid’);

const router = express.Router();

const storage = multer.diskStorage({
destination: (req, file, cb) => cb(null, path.join(__dirname, ‘../uploads’)),
filename: (req, file, cb) => {
const ext = path.extname(file.originalname);
cb(null, `${uuidv4()}${ext}`);
}
});

const upload = multer({
storage,
limits: { fileSize: 20 * 1024 * 1024 },
fileFilter: (req, file, cb) => {
const allowed = [‘image/jpeg’, ‘image/png’, ‘image/webp’];
if (allowed.includes(file.mimetype)) cb(null, true);
else cb(new Error(‘Chỉ chấp nhận ảnh JPG, PNG, WebP’));
}
});

function uploadMiddleware(req, res, next) {
upload.array(‘images[]’, 20)(req, res, err => {
if (err && err.code === ‘LIMIT_UNEXPECTED_FILE’) upload.array(‘images’, 20)(req, res, next);
else next(err);
});
}

// ── GIAI ĐOẠN 1: Gemini đọc & gõ lại chữ viết tay ──────────────────────────
async function transcribeWithGemini(files, subject) {
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: ‘gemini-2.5-flash’ });

// Chuẩn bị ảnh cho Gemini
const imageParts = files.map(file => ({
inlineData: {
data: fs.readFileSync(file.path).toString(‘base64’),
mimeType: file.mimetype
}
}));

const prompt = `Bạn là chuyên gia OCR bài thi môn ${subject} bằng tiếng Việt, đặc biệt giỏi đọc ký hiệu toán học viết tay.
Nhiệm vụ DUY NHẤT: GÕ LẠI chính xác toàn bộ nội dung bài làm học sinh trong ảnh.

CHÚ Ý ĐẶC BIỆT VỀ KÝ HIỆU TOÁN (dễ nhầm nhất):

- Phân số: phân biệt rõ tử số và mẫu số. Ví dụ: 7/2 là bảy phần hai, KHÔNG phải (-7)
- Số âm vs phân số: “-7” khác hoàn toàn với “7/2”. Đọc kỹ có gạch ngang ngang (âm) hay gạch ngang dọc (phân số)
- Chỉ số dưới: x₁, x₂ — chữ số nhỏ phía dưới bên phải
- Chỉ số trên (lũy thừa): x², (7/2)² — chữ số nhỏ phía trên bên phải
- Ngoặc: phân biệt (7/2)² với (-7)² — trong ngoặc là gì phải đọc thật kỹ
- Dấu nhân: 3.2 nghĩa là 3×2=6, không phải số thập phân 3.2
- Công thức Vi-et: x₁+x₂ = -b/a, x₁x₂ = c/a

NGUYÊN TẮC:

- Gõ lại CHÍNH XÁC từng ký tự — KHÔNG sửa, KHÔNG thêm, KHÔNG nhận xét
- Giữ nguyên xuống dòng như trong ảnh
- Chữ mờ không đọc được: ghi [?]
- Hình vẽ/đồ thị: mô tả ngắn trong [], ví dụ [Đồ thị parabol qua O, (-2;8), (2;8)]
- Nhiều ảnh: phân biệt [Trang 1], [Trang 2]…

Trả về JSON (không thêm text nào khác):
```json
{
“cac_cau”: [
{
“so_cau”: “Câu 1”,
“noi_dung_goc”: [
“dòng 1 học sinh viết”,
“dòng 2 học sinh viết”
]
}
]
}
````;

// Retry tối đa 3 lần nếu 503
let text = ‘’;
for (let attempt = 1; attempt <= 3; attempt++) {
try {
const result = await model.generateContent([prompt, …imageParts]);
text = result.response.text();
break;
} catch (err) {
if (attempt === 3) throw err;
const isOverload = err.message?.includes(‘503’) || err.message?.includes(‘overloaded’) || err.message?.includes(‘unavailable’);
if (!isOverload) throw err;
console.log(`Gemini 503, thử lại lần ${attempt + 1}...`);
await new Promise(r => setTimeout(r, 3000 * attempt));
}
}
const m = text.match(/`json\n?([\s\S]*?)\n?`/) || text.match(/({[\s\S]*})/);
return JSON.parse(m ? m[1] : text);
}

// ── Sửa JSON bị cắt giữa chừng ──────────────────────────────────────────────
function repairJson(str) {
// Cắt bỏ phần thừa sau object chính
let s = str.trim();
// Đếm số dấu mở/đóng để đóng nốt
let opens = 0, inStr = false, esc = false;
for (let i = 0; i < s.length; i++) {
const c = s[i];
if (esc) { esc = false; continue; }
if (c === ‘\’ && inStr) { esc = true; continue; }
if (c === ‘”’) { inStr = !inStr; continue; }
if (inStr) continue;
if (c === ‘{’ || c === ‘[’) opens++;
if (c === ‘}’ || c === ‘]’) opens–;
}
// Nếu JSON bị cắt (opens > 0), thử đóng lại
if (opens > 0) {
// Tìm điểm cắt hợp lý: kết thúc object cuối cùng hoàn chỉnh trong cac_cau
// Đơn giản: trim trailing comma rồi đóng
s = s.replace(/,\s*$/, ‘’);
// Đóng các cấu trúc còn hở
const stack = [];
inStr = false; esc = false;
for (let i = 0; i < s.length; i++) {
const c = s[i];
if (esc) { esc = false; continue; }
if (c === ‘\’ && inStr) { esc = true; continue; }
if (c === ‘”’) { inStr = !inStr; continue; }
if (inStr) continue;
if (c === ‘{’) stack.push(’}’);
else if (c === ‘[’) stack.push(’]’);
else if ((c === ‘}’ || c === ‘]’) && stack.length) stack.pop();
}
s += stack.reverse().join(’’);
}
return s;
}

// ── Helper: normalize text để match số câu ───────────────────────────────────
function normalizeText(s) {
return String(s || ‘’).normalize(‘NFC’).replace(/\s+/g, ’ ’).trim().toLowerCase();
}

function rubricMapFromRubric(rubric) {
const map = new Map();
for (const cau of rubric.cac_cau || []) {
map.set(normalizeText(cau.so_cau), cau);
}
return map;
}

// ── Lớp 2: Tính lại điểm từ rubric, không tin AI hoàn toàn ──────────────────
function recomputeScoresFromRubric(parsed, rubric) {
const rubricMap = rubricMapFromRubric(rubric);
let tong = 0;

parsed.cac_cau = (parsed.cac_cau || []).map(cau => {
const rubricCau = rubricMap.get(normalizeText(cau.so_cau));
if (!rubricCau) {
return {
…cau,
diem_dat: 0,
diem_toi_da: cau.diem_toi_da || 0,
co_nghi_van_rubric: true,
ghi_chu_noi_bo: cau.ghi_chu_noi_bo || ‘Không khớp số câu với rubric’
};
}

```
const rubricCriteria = rubricCau.tieu_chi || [];
const aiCriteria = Array.isArray(cau.diem_tieu_chi) ? cau.diem_tieu_chi : [];

const fixedCriteria = rubricCriteria.map((tc, idx) => {
  const aiTc = aiCriteria[idx] || {};
  const dat = aiTc.dat === true;
  return {
    tieu_chi: tc.mo_ta,
    dat,
    diem: dat ? Number(tc.diem || 0) : 0
  };
});

const diemDat = fixedCriteria.reduce((sum, tc) => sum + Number(tc.diem || 0), 0);
tong += diemDat;

return {
  ...cau,
  diem_dat: Math.round(diemDat * 100) / 100,
  diem_toi_da: Number(rubricCau.diem || 0),
  diem_tieu_chi: fixedCriteria
};
```

});

parsed.tong_diem = Math.round(tong * 100) / 100;
parsed.diem_toi_da = Number(rubric.tong_diem || 0);
parsed.phan_tram = parsed.diem_toi_da > 0
? Math.round((parsed.tong_diem / parsed.diem_toi_da) * 1000) / 10
: 0;
const pct = parsed.phan_tram;
parsed.xep_loai = pct >= 80 ? ‘Giỏi’ : pct >= 65 ? ‘Khá’ : pct >= 50 ? ‘Trung bình’ : ‘Yếu’;
return parsed;
}

// ── GIAI ĐOẠN 2: Claude chấm từng dòng ──────────────────────────────────────
async function gradeWithClaude(transcribed, rubric, studentName, subject) {
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const baiLamText = transcribed.cac_cau
.map(c => `${c.so_cau}:\n${c.noi_dung_goc.join('\n')}`)
.join(’\n\n’);

const prompt = `Bạn là giáo viên ${subject} chuyên nghiệp. Chấm bài học sinh ${studentName}.

=== BÀI LÀM (đã OCR chính xác) ===
${baiLamText}

=== RUBRIC CHÍNH THỨC ===
${JSON.stringify(rubric, null, 2)}

=== NGUYÊN TẮC CHẤM BẮT BUỘC ===

1. “dong” = chép NGUYÊN XI từng dòng học sinh viết — TUYỆT ĐỐI không thêm, không sửa, không bình luận.
1. “ket_qua” = chỉ “✓ Đúng” hoặc “✗ Sai” — không giải thích thêm.
1. “ghi_chu” = chỉ ra SAI Ở ĐÂU trong dòng đó (nếu sai), tối đa 1 câu ngắn. Không viết cách sửa. Nếu đúng thì để “”.
1. Chỉ cho điểm những gì học sinh THỰC SỰ viết — không suy diễn bước học sinh không làm.
1. Tiêu chí chưa rõ ràng → KHÔNG cho điểm.
1. Cách làm khác đáp án vẫn được nếu đúng toán VÀ đáp ứng tiêu chí rubric.
1. Nếu học sinh bỏ trống: điểm = 0, cham_tung_dong = [].
1. “loi_sai”: 1 câu mô tả lỗi chính học sinh mắc. Để “” nếu đúng hết.
1. “goi_y_sua”: để “” — không cần.
1. “tong_diem” = tổng diem_dat các câu.

=== QUY TẮC CÔNG THỨC ===

- Chữ tiếng Việt: viết ngoài dấu $
- Công thức, số, biến: viết trong $…$
- ✅ ĐÚNG: Thay $y = 2x$ vào $y = -2x^2$, ta được: $2x = -2x^2$
- “ket_qua”: chỉ “✓ Đúng” hoặc “✗ Sai”
- Không thêm gì ngoài JSON

Trả về JSON:
```json
{
“tong_diem”: 0,
“diem_toi_da”: 0,
“phan_tram”: 0.0,
“xep_loai”: “Giỏi”,
“nhan_xet_chung”: “nhận xét ngắn về toàn bài”,
“cac_cau”: [
{
“so_cau”: “Câu 1”,
“diem_dat”: 0,
“diem_toi_da”: 0,
“trang_thai”: “Đúng”,
“cham_tung_dong”: [
{“dong”: “chép nguyên xi dòng học sinh viết”, “ket_qua”: “✓ Đúng”, “ghi_chu”: “”},
{“dong”: “chép nguyên xi dòng sai”, “ket_qua”: “✗ Sai”, “ghi_chu”: “sai ở điểm nào, ngắn gọn”}
],
“diem_tieu_chi”: [{“tieu_chi”: “tiêu chí”, “dat”: true, “diem”: 0}],
“loi_sai”: “”,
“goi_y_sua”: “”
}
]
}
````;

const response = await client.messages.create({
model: ‘claude-sonnet-4-6’,
max_tokens: 16000,
temperature: 0,
messages: [{ role: ‘user’, content: prompt }]
});

const raw = response.content[0].text;
const m = raw.match(/`json\n?([\s\S]*?)\n?`/) || raw.match(/({[\s\S]*})/);
let jsonStr = m ? m[1] : raw;
// Fix backslash: AI đôi khi gửi \frac thay vì \frac trong JSON string
jsonStr = jsonStr.replace(/(?<!\)\(?=[a-zA-Z])/g, ‘\\’);
// Fix JSON bị cắt giữa chừng
jsonStr = repairJson(jsonStr);
const parsed = JSON.parse(jsonStr);

// Override diem_toi_da/phan_tram/xep_loai từ rubric (không để AI tự tính sai)
// recomputeScoresFromRubric tạm tắt — cần log AI response trước khi bật lại
const diemToiDa = Number(rubric.tong_diem) || parsed.diem_toi_da;
parsed.diem_toi_da = diemToiDa;
parsed.phan_tram = diemToiDa > 0
? Math.round((parsed.tong_diem / diemToiDa) * 1000) / 10
: 0;
const pct = parsed.phan_tram;
parsed.xep_loai = pct >= 80 ? ‘Giỏi’ : pct >= 65 ? ‘Khá’ : pct >= 50 ? ‘Trung bình’ : ‘Yếu’;

// Log để debug diem_tieu_chi AI trả về
console.log(’[DEBUG diem_tieu_chi]’, JSON.stringify(
(parsed.cac_cau || []).map(c => ({ so_cau: c.so_cau, diem_dat: c.diem_dat, tieu_chi: c.diem_tieu_chi }))
, null, 2));

return parsed;
}

// ── POST /api/grade ── Main endpoint: Gemini transcribe → Claude grade
router.post(’/’, uploadMiddleware, async (req, res) => {
try {
const { rubric: rubricStr, studentName = ‘Học sinh’, subject = ‘Bài kiểm tra’ } = req.body;

```
if (!req.files?.length)
  return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
if (!rubricStr)
  return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });

let rubric;
try { rubric = JSON.parse(rubricStr); }
catch { return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' }); }

// Kiểm tra API keys
if (!process.env.GEMINI_API_KEY)
  return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY trong biến môi trường' });
if (!process.env.ANTHROPIC_API_KEY)
  return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY trong biến môi trường' });

console.log(`[${studentName}] Bắt đầu giai đoạn 1: Gemini OCR...`);
const transcribed = await transcribeWithGemini(req.files, subject);
console.log(`[${studentName}] Giai đoạn 1 xong. Bắt đầu giai đoạn 2: Claude chấm...`);

const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);
console.log(`[${studentName}] Hoàn thành. Điểm: ${gradingResult.tong_diem}/${gradingResult.diem_toi_da}`);

const resultId = uuidv4();
const resultData = {
  id: resultId, studentName, subject,
  gradingResult, transcribed,
  imageFiles: req.files.map(f => f.filename),
  rubric, createdAt: new Date().toISOString()
};

const resultsDir = path.join(__dirname, '../results');
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, `${resultId}.json`), JSON.stringify(resultData, null, 2));

res.json({
  success: true, resultId, studentName, subject,
  gradingResult, transcribed,
  imageUrls: req.files.map(f => `/uploads/${f.filename}`)
});
```

} catch (error) {
console.error(‘Lỗi chấm bài:’, error);
res.status(500).json({ error: error.message });
}
});

// ── POST /api/grade/transcribe ── Chỉ OCR (dùng Gemini)
router.post(’/transcribe’, uploadMiddleware, async (req, res) => {
try {
if (!req.files?.length) return res.status(400).json({ error: ‘Vui lòng upload ít nhất 1 ảnh’ });
const { subject = ‘Toán’ } = req.body;
const transcribed = await transcribeWithGemini(req.files, subject);

```
const sessionId = uuidv4();
const sessionsDir = path.join(__dirname, '../results/sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(
  path.join(sessionsDir, `${sessionId}.json`),
  JSON.stringify({ sessionId, imageFiles: req.files.map(f => f.filename), transcribed, createdAt: new Date().toISOString() }, null, 2)
);

res.json({ success: true, sessionId, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
```

} catch (error) {
res.status(500).json({ error: error.message });
}
});

// ── POST /api/grade/score ── Chỉ chấm (dùng Claude)
router.post(’/score’, async (req, res) => {
try {
const { sessionId, transcribed, rubric: rubricStr, studentName = ‘Học sinh’, subject = ‘Bài kiểm tra’ } = req.body;
if (!transcribed || !rubricStr) return res.status(400).json({ error: ‘Thiếu dữ liệu’ });

```
let rubric;
try { rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr; }
catch { return res.status(400).json({ error: 'Rubric không đúng JSON' }); }

const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);

let imageFiles = [];
if (sessionId) {
  const sp = path.join(__dirname, '../results/sessions', `${sessionId}.json`);
  if (fs.existsSync(sp)) imageFiles = JSON.parse(fs.readFileSync(sp, 'utf8')).imageFiles;
}

const resultId = uuidv4();
const resultData = { id: resultId, studentName, subject, gradingResult, transcribed, imageFiles, rubric, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(__dirname, '../results', `${resultId}.json`), JSON.stringify(resultData, null, 2));

res.json({ success: true, resultId, studentName, subject, gradingResult, transcribed, imageUrls: imageFiles.map(f => `/uploads/${f}`) });
```

} catch (error) {
res.status(500).json({ error: error.message });
}
});

// ── GET /api/grade/:id
router.get(’/:id’, (req, res) => {
const fp = path.join(__dirname, ‘../results’, `${req.params.id}.json`);
if (!fs.existsSync(fp)) return res.status(404).json({ error: ‘Không tìm thấy’ });
res.json(JSON.parse(fs.readFileSync(fp, ‘utf8’)));
});

// ── GET /api/grade
router.get(’/’, (req, res) => {
const dir = path.join(__dirname, ‘../results’);
if (!fs.existsSync(dir)) return res.json([]);
const list = fs.readdirSync(dir).filter(f => f.endsWith(’.json’)).map(f => {
const d = JSON.parse(fs.readFileSync(path.join(dir, f), ‘utf8’));
return { id: d.id, studentName: d.studentName, subject: d.subject, tongDiem: d.gradingResult?.tong_diem, diemToiDa: d.gradingResult?.diem_toi_da, createdAt: d.createdAt };
});
list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
res.json(list);
});

module.exports = router;