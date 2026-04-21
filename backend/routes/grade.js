const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const { verifyIntegrity } = require('./verify');
const { textToKatex } = require('./latex-utils');

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
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  });

  const imageParts = files.map(file => ({
    inlineData: {
      data: fs.readFileSync(file.path).toString('base64'),
      mimeType: file.mimetype
    }
  }));

  const prompt = `Bạn là MÁY QUÉT bài thi môn ${subject}. Bạn KHÔNG phải giáo viên. Bạn KHÔNG biết tính toán.

NHIỆM VỤ DUY NHẤT: Chép lại CHÍNH XÁC TỪNG KÝ TỰ học sinh viết trên ảnh. Không thêm bớt, không diễn giải.

TUYỆT ĐỐI CẤM:
1. CẤM sửa phép tính dù học sinh viết sai. Ví dụ HS viết "Δ = 20" thì CHỈ ghi "Δ = 20". KHÔNG bao giờ đổi thành giá trị bạn tự tính.
2. CẤM thêm chú thích "(sai)", "(đúng)", "(HS viết...)", "[thực ra...]".
3. Nếu không đọc rõ ký tự → ghi [?] ngay tại vị trí đó. KHÔNG đoán.
4. CẤM bỏ qua dòng nào, kể cả dòng gạch xóa — ghi dòng gạch xóa nguyên văn.
5. CẤM gộp 2 dòng thành 1. Học sinh xuống dòng ở đâu, bạn xuống dòng ở đó.

QUY TẮC VIẾT CÔNG THỨC TOÁN (ưu tiên LaTeX trong $...$ để tránh nhập nhằng):
- Phân số a/b nằm dọc: $\\dfrac{a}{b}$. Phân số ngang viết tay: a/b.
- Lũy thừa: $x^2$, $x^{10}$, $a^{n+1}$.
- Chỉ số dưới: $x_1$, $a_{ij}$.
- Căn: $\\sqrt{21}$, $\\sqrt[3]{8}$.
- Chữ Hy Lạp: $\\Delta$, $\\alpha$, $\\pi$, $\\theta$ (không dùng Δ Unicode vì dễ nhầm △ tam giác).
- Tam giác: $\\triangle ABC$.
- Ngoặc đa cấp: $\\left(\\frac{a+b}{c}\\right)$.
- Mũi tên: $\\Rightarrow$, $\\Leftrightarrow$.
- Dấu so sánh: $\\leq$, $\\geq$, $\\neq$, $\\approx$.
- Các ký hiệu bình thường (+, -, =, <, >) có thể viết thẳng không cần $...$.

VÍ DỤ TỐT:
- HS viết "x² + 2x + 1" → ghi "$x^2 + 2x + 1$" hoặc "x² + 2x + 1" (cả hai đều chấp nhận, nhưng LaTeX được ưu tiên).
- HS viết "Δ = b² - 4ac" → ghi "$\\Delta = b^2 - 4ac$".
- HS viết phân số 3/4 → ghi "$\\dfrac{3}{4}$".
- HS viết "√25 = 5" → ghi "$\\sqrt{25} = 5$".

QUY TẮC PHÂN CÂU:
- Mỗi câu (Câu 1, Câu 2, Bài 1a, …) là 1 phần tử trong "cac_cau".
- "so_cau" = đúng chuỗi học sinh viết: "Câu 1", "Câu 2a", "Bài 3", …
- "noi_dung_goc" = mảng các dòng, mỗi phần tử là 1 dòng HS viết.
- Nếu nhiều ảnh: ghi "[Trang 1]", "[Trang 2]" ở đầu noi_dung_goc của mỗi trang.

KIỂM TRA TRƯỚC KHI TRẢ LỜI:
- Đếm số câu trong ảnh → số phần tử cac_cau phải khớp.
- Mọi con số, ký tự bạn viết có KHỚP CHÍNH XÁC với ảnh không? Nếu không chắc → dùng [?].

Trả về JSON thuần (không markdown, không text phụ):
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
}`;

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

  // Build rubric dạng rõ ràng: liệt kê tiêu chí có ID để Claude tham chiếu
  const rubricSpec = (rubric.cac_cau || []).map(cau => {
    const tcList = (cau.tieu_chi || []).map((tc, idx) =>
      `    [TC${idx}] "${tc.mo_ta}" — ${tc.diem} điểm`
    ).join('\n');
    return `• ${cau.so_cau} (tối đa ${cau.diem}đ):
  Đề: ${cau.noi_dung || '(không có)'}
  Đáp án chuẩn: ${cau.dap_an || '(không có)'}
  Tiêu chí chấm:
${tcList}`;
  }).join('\n\n');

  const rubricCauList = (rubric.cac_cau || []).map(c => c.so_cau).join(', ');

  const prompt = `Bạn là giáo viên ${subject} chuyên nghiệp, chấm nghiêm túc. Học sinh: ${studentName}.

=== BÀI LÀM HỌC SINH (mỗi dòng có INDEX [n] ở đầu) ===
${indexedText || '(Học sinh không viết gì)'}

=== RUBRIC CHÍNH THỨC ===
${rubricSpec}

Tổng điểm tối đa: ${rubric.tong_diem}
Số câu phải chấm: ${(rubric.cac_cau || []).length} — ${rubricCauList}

=== NGUYÊN TẮC CHẤM — BẮT BUỘC ===

A. VỀ THAM CHIẾU DÒNG — TUYỆT ĐỐI CẤM BỊA:
- "dong_index" là SỐ NGUYÊN trong [] ở đầu mỗi dòng bài làm.
- MỖI entry trong "cham_tung_dong" PHẢI có "dong_index" khớp với 1 dòng CÓ THẬT trong bài làm (từ [0] đến [${Math.max(indexedLines.length - 1, 0)}]).
- TUYỆT ĐỐI KHÔNG viết lại, sửa, hoặc tóm tắt nội dung dòng. Chỉ điền số.
- TUYỆT ĐỐI KHÔNG thêm bước trung gian mà HS KHÔNG viết. Ví dụ: HS viết "x²/2 = 18" rồi nhảy thẳng đến "x = ±6", bạn KHÔNG được chèn thêm "x² = 36" vì đó là bước HS bỏ qua.
- Nếu HS thiếu bước quan trọng → nêu trong "loi_sai" của câu, KHÔNG tạo entry cham_tung_dong cho bước không tồn tại.
- Không được dùng lại cùng 1 dong_index nhiều lần trong cùng câu.
- Mọi entry không có dong_index hợp lệ sẽ bị backend LOẠI BỎ và bạn sẽ bị đánh dấu là hallucinating.

B. VỀ CHẤM TIÊU CHÍ (quan trọng nhất cho tính điểm):
- Với MỖI câu, bạn PHẢI trả về "diem_tieu_chi" có ĐÚNG ${(rubric.cac_cau || []).length > 0 ? 'số lượng và ĐÚNG thứ tự' : ''} tiêu chí như rubric trên.
- Nếu rubric câu có 3 tiêu chí [TC0], [TC1], [TC2] → bạn phải trả về mảng 3 phần tử theo đúng thứ tự đó.
- Mỗi phần tử: { "tieu_chi_index": <số TC>, "tieu_chi": "<copy nguyên văn mo_ta>", "dat": true|false }
- "dat" = true CHỈ KHI học sinh thực sự đáp ứng tiêu chí đó. Nếu không rõ ràng → false.
- KHÔNG tự cộng điểm. Backend sẽ tính điểm từ rubric dựa trên "dat".

C. VỀ NỘI DUNG CHẤM:
1. "ket_qua" chỉ: "✓ Đúng" hoặc "✗ Sai".
2. "ghi_chu": nếu sai thì chỉ ra sai ở đâu (≤1 câu). Nếu đúng để "".
3. Chỉ chấm đúng những gì HS THỰC SỰ viết — KHÔNG suy diễn bước trung gian.
4. Cách giải khác vẫn được điểm nếu đúng toán học VÀ đạt tiêu chí rubric.
5. Nếu HS bỏ trống câu: "diem_tieu_chi" vẫn phải đủ, tất cả dat=false; "cham_tung_dong"=[]; "trang_thai"="Bỏ trống".
6. "loi_sai": 1 câu mô tả lỗi chính (không hướng dẫn sửa). Để "" nếu đúng.
7. CẤM tạo "goi_y_sua" hoặc viết hướng dẫn sửa bài.
8. "nhan_xet_chung": nhận xét tổng quát ngắn. KHÔNG hướng dẫn sửa.
9. "trang_thai" ∈ { "Đúng", "Đúng một phần", "Sai", "Bỏ trống" }.

D. VỀ ĐẦY ĐỦ:
- PHẢI chấm đủ ${(rubric.cac_cau || []).length} câu, đúng tên: ${rubricCauList}.
- Nếu không tìm thấy dòng nào của câu → vẫn trả về entry câu đó với cham_tung_dong=[], trang_thai="Bỏ trống".

Trả về JSON (không thêm text nào khác):
\`\`\`json
{
  "nhan_xet_chung": "nhận xét ngắn",
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "trang_thai": "Sai",
      "cham_tung_dong": [
        { "dong_index": 0, "ket_qua": "✗ Sai", "ghi_chu": "sai ở bước nào" }
      ],
      "diem_tieu_chi": [
        { "tieu_chi_index": 0, "tieu_chi": "copy mo_ta từ rubric", "dat": false }
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

  // ── LỚP BẢO VỆ CHÍNH: STRICT — chỉ chấp nhận entry có dong_index hợp lệ ──
  // Mọi entry Claude cố tình bịa (không có dong_index hoặc index sai) sẽ bị DROP.
  // KHÔNG fuzzy-match — vì đó là kẽ hở để Claude chèn bước trung gian tự nghĩ ra.
  const droppedByCau = new Map();    // so_cau → [entries bị drop]
  (parsed.cac_cau || []).forEach(cau => {
    const usedIdx = new Set();
    const kept = [];
    const dropped = [];
    for (const d of (cau.cham_tung_dong || [])) {
      const rawIdx = d.dong_index;
      const idx = typeof rawIdx === 'number' ? rawIdx : parseInt(rawIdx);

      if (isNaN(idx) || !indexedLines[idx]) {
        dropped.push({ reason: 'missing_or_invalid_dong_index', data: { ...d } });
        continue;
      }
      if (usedIdx.has(idx)) {
        // Claude dùng lại cùng 1 dòng 2 lần → có thể đang cố nhân bản
        dropped.push({ reason: 'duplicate_dong_index', data: { ...d } });
        continue;
      }
      usedIdx.add(idx);

      // LUÔN ghi đè dong bằng OCR gốc — Claude không thể thay đổi nội dung
      d.dong = indexedLines[idx].dong;
      delete d.dong_index;
      kept.push(d);
    }
    cau.cham_tung_dong = kept;
    if (dropped.length > 0) {
      droppedByCau.set(cau.so_cau, dropped);
      console.warn(`[STRICT] ${cau.so_cau}: đã drop ${dropped.length} entry Claude bịa:`,
        dropped.map(x => `(${x.reason}) ${JSON.stringify(x.data).slice(0, 80)}`).join(' | '));
    }
  });

  // Gắn thông tin entries bị drop vào result để giáo viên/UI biết
  if (droppedByCau.size > 0) {
    parsed.canh_bao_hallucination = {
      co_bia_dong: true,
      so_cau_bi_bia: droppedByCau.size,
      chi_tiet: Array.from(droppedByCau.entries()).map(([so_cau, dropped]) => ({
        so_cau,
        so_dong_bi_drop: dropped.length,
        dong_bi_drop: dropped.map(x => ({
          ly_do: x.reason,
          dong_claude_bia: x.data.dong || '(không có)',
          ghi_chu_claude: x.data.ghi_chu || ''
        }))
      })),
      canh_bao_chung: `⚠️ Phát hiện Claude bịa ${Array.from(droppedByCau.values()).reduce((s,a)=>s+a.length,0)} dòng không có trong bài làm HS. Đã loại bỏ khỏi kết quả.`
    };
  }

  // ── Sanitize: xóa goi_y_sua, làm sạch nội dung ──────────────────────────
  sanitizeGradingResult(parsed);

  // ── Tính lại điểm từ rubric (không tin AI tự cộng) ───────────────────────
  recomputeScoresFromRubric(parsed, rubric);

  // ── Kiểm tra toàn vẹn: đảm bảo Claude không tự sửa nội dung HS ───────────
  let finalResult = parsed;
  try {
    const { gradingResult: verified, stats } = verifyIntegrity(parsed, transcribed);
    if (stats.violationCount > 0) {
      console.warn(`[VERIFY] ${stats.violationCount}/${stats.totalLines} dòng nghi bị AI sửa. Auto-fixed: ${stats.autoFixedCount}`);
    }
    finalResult = verified;
  } catch (e) {
    console.warn('[VERIFY] Lỗi kiểm tra toàn vẹn, bỏ qua:', e.message);
  }

  // ── Preprocess math: wrap Unicode math trong $...$ cho KaTeX ─────────────
  // Giữ trường gốc cho audit, thêm trường _katex cho render.
  prepareForDisplay(finalResult);

  return finalResult;
}

// Thêm bản đã wrap $...$ để KaTeX render. Giữ bản gốc để verify / export LaTeX.
function prepareForDisplay(result) {
  if (!result || typeof result !== 'object') return result;

  const safeKatex = (v) => {
    if (typeof v !== 'string' || !v) return v;
    try { return textToKatex(v); } catch { return v; }
  };

  result.nhan_xet_chung_katex = safeKatex(result.nhan_xet_chung);

  (result.cac_cau || []).forEach(cau => {
    cau.loi_sai_katex = safeKatex(cau.loi_sai);
    (cau.cham_tung_dong || []).forEach(d => {
      d.dong_katex = safeKatex(d.dong);
      d.ghi_chu_katex = safeKatex(d.ghi_chu);
    });
  });

  return result;
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

// Match tiêu chí AI với rubric: ưu tiên tieu_chi_index → mo_ta text → fallback theo vị trí
function resolveCriterionMatch(aiCriteria, rubricCriteria) {
  const usedAi = new Set();
  const result = new Array(rubricCriteria.length).fill(null);

  // Lần 1: match theo tieu_chi_index (nếu AI trả về đúng)
  aiCriteria.forEach((ai, aiIdx) => {
    const idx = typeof ai?.tieu_chi_index === 'number' ? ai.tieu_chi_index : parseInt(ai?.tieu_chi_index);
    if (!isNaN(idx) && idx >= 0 && idx < rubricCriteria.length && !result[idx]) {
      result[idx] = ai;
      usedAi.add(aiIdx);
    }
  });

  // Lần 2: match theo mo_ta (normalize)
  rubricCriteria.forEach((rc, rcIdx) => {
    if (result[rcIdx]) return;
    const rcNorm = normalizeText(rc.mo_ta);
    for (let aiIdx = 0; aiIdx < aiCriteria.length; aiIdx++) {
      if (usedAi.has(aiIdx)) continue;
      const aiNorm = normalizeText(aiCriteria[aiIdx]?.tieu_chi);
      if (aiNorm && aiNorm === rcNorm) {
        result[rcIdx] = aiCriteria[aiIdx];
        usedAi.add(aiIdx);
        break;
      }
    }
  });

  // Lần 3: fallback theo vị trí cho các slot còn trống
  rubricCriteria.forEach((_, rcIdx) => {
    if (result[rcIdx]) return;
    for (let aiIdx = 0; aiIdx < aiCriteria.length; aiIdx++) {
      if (usedAi.has(aiIdx)) continue;
      if (aiIdx === rcIdx) {
        result[rcIdx] = aiCriteria[aiIdx];
        usedAi.add(aiIdx);
        break;
      }
    }
  });

  return result;
}

function deriveTrangThai(diemDat, diemMax, chamTungDong) {
  if (diemMax <= 0) return 'Bỏ trống';
  const soDong = Array.isArray(chamTungDong) ? chamTungDong.length : 0;
  if (soDong === 0 && diemDat === 0) return 'Bỏ trống';
  if (diemDat >= diemMax - 1e-9) return 'Đúng';
  if (diemDat <= 1e-9) return 'Sai';
  return 'Đúng một phần';
}

function recomputeScoresFromRubric(parsed, rubric) {
  const rubricCauList = Array.isArray(rubric.cac_cau) ? rubric.cac_cau : [];
  const aiByKey = new Map();
  for (const cau of parsed.cac_cau || []) {
    aiByKey.set(normalizeText(cau.so_cau), cau);
  }

  // Bắt đầu từ RUBRIC để đảm bảo không thiếu câu nào
  const newCacCau = rubricCauList.map(rubricCau => {
    const aiCau = aiByKey.get(normalizeText(rubricCau.so_cau)) || {};
    const rubricCriteria = Array.isArray(rubricCau.tieu_chi) ? rubricCau.tieu_chi : [];
    const aiCriteria = Array.isArray(aiCau.diem_tieu_chi) ? aiCau.diem_tieu_chi : [];

    const matched = resolveCriterionMatch(aiCriteria, rubricCriteria);
    const fixedCriteria = rubricCriteria.map((tc, idx) => {
      const dat = matched[idx]?.dat === true;
      return {
        tieu_chi: tc.mo_ta,
        dat,
        diem: dat ? Number(tc.diem || 0) : 0,
        diem_toi_da: Number(tc.diem || 0)
      };
    });

    const diemDat = fixedCriteria.reduce((s, tc) => s + Number(tc.diem || 0), 0);
    const diemMax = Number(rubricCau.diem || 0);
    const chamTungDong = Array.isArray(aiCau.cham_tung_dong) ? aiCau.cham_tung_dong : [];

    const trangThai = deriveTrangThai(diemDat, diemMax, chamTungDong);

    return {
      so_cau: rubricCau.so_cau,
      diem_dat: Math.round(diemDat * 100) / 100,
      diem_toi_da: diemMax,
      trang_thai: trangThai,
      cham_tung_dong: chamTungDong,
      diem_tieu_chi: fixedCriteria,
      loi_sai: stripForbiddenContent(aiCau.loi_sai || '')
    };
  });

  // Ghi chú câu AI chấm nhưng không có trong rubric (đánh dấu để giáo viên review)
  const rubricKeys = new Set(rubricCauList.map(c => normalizeText(c.so_cau)));
  for (const aiCau of parsed.cac_cau || []) {
    if (!rubricKeys.has(normalizeText(aiCau.so_cau))) {
      newCacCau.push({
        ...aiCau,
        diem_dat: 0,
        diem_toi_da: 0,
        co_nghi_van_rubric: true,
        ghi_chu_noi_bo: 'Câu này không có trong rubric — không tính điểm'
      });
    }
  }

  parsed.cac_cau = newCacCau;

  const tong = newCacCau.reduce((s, c) => s + Number(c.diem_dat || 0), 0);
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
