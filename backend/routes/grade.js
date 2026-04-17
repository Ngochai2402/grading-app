const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận ảnh JPG, PNG, WebP'));
  }
});

function uploadMiddleware(req, res, next) {
  upload.array('images[]', 20)(req, res, err => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      upload.array('images', 20)(req, res, next);
      return;
    }
    next(err);
  });
}

// ════════════════════════════════════════════════════════════════
// GIAI ĐOẠN 1: Gemini OCR — chỉ được chép lại, không tính toán
// ════════════════════════════════════════════════════════════════
async function transcribeWithGemini(files, subject) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const imageParts = files.map(file => ({
    inlineData: {
      data: fs.readFileSync(file.path).toString('base64'),
      mimeType: file.mimetype
    }
  }));

  const prompt = `Bạn là MÁY QUÉT bài thi môn ${subject}. Bạn KHÔNG phải giáo viên. Bạn KHÔNG biết tính toán.

NHIỆM VỤ DUY NHẤT: Chép lại đúng y hệt từng dòng chữ trong ảnh. Không hơn không kém.

TUYỆT ĐỐI CẤM:
1. CẤM sửa phép tính, dù học sinh viết sai. Ví dụ: "delta = 20" thì chỉ ghi "delta = 20", KHÔNG đổi thành giá trị khác.
2. CẤM thêm chú thích "(sai)", "(đúng)", "(học sinh ghi...)", "[thực ra là...]" hay bất cứ thứ gì thêm vào.
3. CẤM đoán khi không đọc được — ghi [?].
4. CẤM bỏ qua bất kỳ dòng nào, kể cả dòng bị gạch xóa.

QUY TẮC:
- Ký hiệu phân số: chép đúng tử/mẫu (vd: 7/2).
- Chỉ số trên/dưới: x², x₁.
- Hình vẽ: mô tả ngắn trong [], vd [Đồ thị parabol].
- Nhiều ảnh: phân biệt [Trang 1], [Trang 2]...
- Giữ nguyên xuống dòng như trong ảnh.

Trả về JSON (không thêm text nào khác):
\`\`\`json
{
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "noi_dung_goc": [
        "dòng 1 học sinh viết",
        "dòng 2 học sinh viết"
      ]
    }
  ]
}
\`\`\``;

  let text = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent([prompt, ...imageParts]);
      text = result.response.text();
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      const isOverload = err.message?.includes('503') || err.message?.includes('overloaded') || err.message?.includes('unavailable');
      if (!isOverload) throw err;
      console.log(`Gemini 503, thử lại lần ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }

  const m = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/({[\s\S]*})/);
  return JSON.parse(m ? m[1] : text);
}

// ════════════════════════════════════════════════════════════════
// GIAI ĐOẠN 2: Claude chấm — KHÔNG viết lại nội dung HS
//
// Cơ chế: Claude chỉ trả "dong_index" (số thứ tự dòng).
// Backend tự điền "dong" từ noi_dung_goc Gemini theo index đó.
// Claude không thể sửa bài vì không được phép viết lại nội dung.
// ════════════════════════════════════════════════════════════════
async function gradeWithClaude(transcribed, rubric, studentName, subject) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Đánh index toàn bộ dòng → Claude chỉ tham chiếu số index
  const indexedLines = [];
  (transcribed.cac_cau || []).forEach(cau => {
    (cau.noi_dung_goc || []).forEach(dong => {
      indexedLines.push({ cau: cau.so_cau, dong });
    });
  });

  const indexedText = indexedLines
    .map((item, idx) => `[${idx}] (${item.cau}) ${item.dong}`)
    .join('\n');

  const prompt = `Bạn là giáo viên ${subject} chuyên nghiệp. Chấm bài học sinh ${studentName}.

=== BÀI LÀM (mỗi dòng có INDEX ở đầu) ===
${indexedText}

=== RUBRIC CHÍNH THỨC ===
${JSON.stringify(rubric, null, 2)}

=== NGUYÊN TẮC CHẤM — BẮT BUỘC ===

QUAN TRỌNG NHẤT — Trường "dong_index":
- "dong_index" là SỐ INDEX của dòng (số trong []).
- TUYỆT ĐỐI KHÔNG viết lại nội dung dòng đó. Chỉ điền số index.
- Ví dụ: dòng [3] thì "dong_index": 3. Không ghi thêm gì khác.

Các nguyên tắc chấm:
1. "ket_qua" = chỉ "✓ Đúng" hoặc "✗ Sai". Không dùng giá trị khác.
2. "ghi_chu" = nếu sai: chỉ ra sai ở bước nào (tối đa 1 câu). Nếu đúng: để "".
3. Chỉ cho điểm những gì HS THỰC SỰ viết — không suy diễn bước trung gian.
4. Cách làm khác vẫn được điểm nếu đúng toán VÀ đáp ứng tiêu chí rubric.
5. Nếu HS bỏ trống: diem_dat = 0, cham_tung_dong = [].
6. "loi_sai": 1 câu mô tả lỗi chính. Để "" nếu đúng. KHÔNG viết cách sửa.
7. KHÔNG tạo trường "goi_y_sua". KHÔNG viết hướng dẫn sửa ở bất cứ đâu.
8. "nhan_xet_chung": nhận xét tổng quát. KHÔNG hướng dẫn sửa bài.

Trả về JSON (không thêm text nào khác):
\`\`\`json
{
  "tong_diem": 0,
  "diem_toi_da": 0,
  "phan_tram": 0,
  "xep_loai": "Yếu",
  "nhan_xet_chung": "nhận xét ngắn, không hướng dẫn sửa",
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "diem_dat": 0,
      "diem_toi_da": 0,
      "trang_thai": "Sai",
      "cham_tung_dong": [
        { "dong_index": 0, "ket_qua": "✗ Sai", "ghi_chu": "sai ở bước nào" }
      ],
      "diem_tieu_chi": [
        { "tieu_chi": "tên tiêu chí", "dat": false, "diem": 0 }
      ],
      "loi_sai": "mô tả lỗi, không hướng dẫn sửa"
    }
  ]
}
\`\`\``;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content?.[0]?.text || '';
  const m = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/({[\s\S]*})/);
  let jsonStr = m ? m[1] : raw;
  jsonStr = repairJson(jsonStr);

  const parsed = JSON.parse(jsonStr);

  // ── LỚP BẢO VỆ CHÍNH: Ép dong = nội dung Gemini theo dong_index ─────────
  (parsed.cac_cau || []).forEach(cau => {
    (cau.cham_tung_dong || []).forEach(d => {
      const idx = typeof d.dong_index === 'number'
        ? d.dong_index
        : parseInt(d.dong_index);

      if (!isNaN(idx) && indexedLines[idx]) {
        // Luôn ghi đè bằng nội dung Gemini gốc — Claude không thể thay đổi
        d.dong = indexedLines[idx].dong;
      } else if (typeof d.dong === 'string' && d.dong.trim()) {
        // Fallback: Claude lỡ tự viết nội dung → tìm dòng gốc gần nhất
        d.dong = findClosestOriginalLine(d.dong, indexedLines) || d.dong;
        console.warn(`[WARN] Claude không dùng dong_index. Câu: ${cau.so_cau}, dong: ${d.dong.substring(0, 30)}`);
      }
      delete d.dong_index;
    });
  });

  // ── Sanitize: xóa goi_y_sua, làm sạch nội dung ──────────────────────────
  sanitizeGradingResult(parsed);

  // ── Tính lại điểm từ rubric (không tin AI tự cộng) ───────────────────────
  recomputeScoresFromRubric(parsed, rubric);

  return parsed;
}

// Fallback: tìm dòng gốc gần nhất khi Claude lỡ tự viết lại
function findClosestOriginalLine(aiWritten, indexedLines) {
  if (!aiWritten || !indexedLines.length) return null;
  const clean = s => String(s).replace(/\s+/g, '').toLowerCase();
  const target = clean(aiWritten);
  let best = null, bestScore = 0;
  for (const item of indexedLines) {
    const orig = clean(item.dong);
    if (!orig) continue;
    let common = 0;
    const shorter = orig.length < target.length ? orig : target;
    const longer = orig.length >= target.length ? orig : target;
    for (const ch of shorter) {
      if (longer.includes(ch)) common++;
    }
    const score = common / Math.max(orig.length, target.length, 1);
    if (score > bestScore && score > 0.7) { bestScore = score; best = item.dong; }
  }
  return best;
}

// Xóa nội dung bị cấm (hướng dẫn sửa, goi_y_sua...)
function stripForbiddenContent(text) {
  let t = String(text || '').trim();
  t = t.replace(/\b(?:hãy|nên|cần)\s+(?:làm|sửa|viết|đổi|tính|thực hiện)\b[^.]*[.!]?\s*/gi, '').trim();
  t = t.replace(/^(gợi ý|hướng sửa|cách sửa|hướng dẫn|cách làm đúng)\s*[:\-]?\s*/i, '').trim();
  return t;
}

function sanitizeGradingResult(parsed) {
  if (!parsed || !Array.isArray(parsed.cac_cau)) return parsed;
  parsed.nhan_xet_chung = stripForbiddenContent(parsed.nhan_xet_chung);
  parsed.cac_cau = parsed.cac_cau.map(cau => {
    const cham = Array.isArray(cau.cham_tung_dong) ? cau.cham_tung_dong : [];
    cau.cham_tung_dong = cham.map(d => ({
      dong: String(d?.dong || '').trim(),
      ket_qua: String(d?.ket_qua || '').includes('✓') ? '✓ Đúng' : '✗ Sai',
      ghi_chu: stripForbiddenContent(d?.ghi_chu || '')
    }));
    cau.loi_sai = stripForbiddenContent(cau.loi_sai || '');
    delete cau.goi_y_sua;
    return cau;
  });
  return parsed;
}

// Tính lại điểm từ rubric
function normalizeText(s) {
  return String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function rubricMapFromRubric(rubric) {
  const map = new Map();
  for (const cau of rubric.cac_cau || []) {
    map.set(normalizeText(cau.so_cau), cau);
  }
  return map;
}

function recomputeScoresFromRubric(parsed, rubric) {
  const rubricMap = rubricMapFromRubric(rubric);
  let tong = 0;
  parsed.cac_cau = (parsed.cac_cau || []).map(cau => {
    const rubricCau = rubricMap.get(normalizeText(cau.so_cau));
    if (!rubricCau) {
      return {
        ...cau,
        diem_dat: Number(cau.diem_dat || 0),
        diem_toi_da: Number(cau.diem_toi_da || 0),
        co_nghi_van_rubric: true,
        ghi_chu_noi_bo: 'Không khớp số câu với rubric'
      };
    }
    const rubricCriteria = Array.isArray(rubricCau.tieu_chi) ? rubricCau.tieu_chi : [];
    const aiCriteria = Array.isArray(cau.diem_tieu_chi) ? cau.diem_tieu_chi : [];
    const fixedCriteria = rubricCriteria.map((tc, idx) => {
      const dat = (aiCriteria[idx] || {}).dat === true;
      return { tieu_chi: tc.mo_ta, dat, diem: dat ? Number(tc.diem || 0) : 0 };
    });
    const diemDat = fixedCriteria.reduce((sum, tc) => sum + Number(tc.diem || 0), 0);
    tong += diemDat;
    return {
      ...cau,
      diem_dat: Math.round(diemDat * 100) / 100,
      diem_toi_da: Number(rubricCau.diem || 0),
      diem_tieu_chi: fixedCriteria
    };
  });
  parsed.tong_diem = Math.round(tong * 100) / 100;
  parsed.diem_toi_da = Number(rubric.tong_diem || 0);
  parsed.phan_tram = parsed.diem_toi_da > 0
    ? Math.round((parsed.tong_diem / parsed.diem_toi_da) * 1000) / 10 : 0;
  const pct = parsed.phan_tram;
  parsed.xep_loai = pct >= 80 ? 'Giỏi' : pct >= 65 ? 'Khá' : pct >= 50 ? 'Trung bình' : 'Yếu';
  return parsed;
}

function repairJson(str) {
  let s = String(str || '').trim();
  if (!s) return s;
  s = s.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  let stack = [], inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if ((c === '}' || c === ']') && stack.length) stack.pop();
  }
  s = s.replace(/,\s*$/, '');
  if (stack.length) s += stack.reverse().join('');
  return s;
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

router.post('/', uploadMiddleware, async (req, res) => {
  try {
    const { rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
    if (!rubricStr) return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });
    let rubric;
    try { rubric = JSON.parse(rubricStr); }
    catch { return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' }); }
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY' });

    console.log(`[${studentName}] OCR...`);
    const transcribed = await transcribeWithGemini(req.files, subject);
    console.log(`[${studentName}] Chấm...`);
    const gradingResult = await gradeWithClaude(transcribed, rubric, studentName, subject);
    console.log(`[${studentName}] Xong: ${gradingResult.tong_diem}/${gradingResult.diem_toi_da}`);

    const resultId = uuidv4();
    const resultData = { id: resultId, studentName, subject, gradingResult, transcribed, imageFiles: req.files.map(f => f.filename), rubric, createdAt: new Date().toISOString() };
    const resultsDir = path.join(__dirname, '../results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${resultId}.json`), JSON.stringify(resultData, null, 2));
    res.json({ success: true, resultId, studentName, subject, gradingResult, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
  } catch (error) {
    console.error('Lỗi chấm bài:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/transcribe', uploadMiddleware, async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    const { subject = 'Toán' } = req.body;
    const transcribed = await transcribeWithGemini(req.files, subject);
    const sessionId = uuidv4();
    const sessionsDir = path.join(__dirname, '../results/sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({ sessionId, imageFiles: req.files.map(f => f.filename), transcribed, createdAt: new Date().toISOString() }, null, 2));
    res.json({ success: true, sessionId, transcribed, imageUrls: req.files.map(f => `/uploads/${f.filename}`) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/score', async (req, res) => {
  try {
    const { sessionId, transcribed, rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;
    if (!transcribed || !rubricStr) return res.status(400).json({ error: 'Thiếu dữ liệu' });
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  const fp = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

router.get('/', (req, res) => {
  const dir = path.join(__dirname, '../results');
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: d.id, studentName: d.studentName, subject: d.subject, tongDiem: d.gradingResult?.tong_diem, diemToiDa: d.gradingResult?.diem_toi_da, createdAt: d.createdAt };
  });
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

module.exports = router;
