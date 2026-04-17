// ─────────────────────────────────────────────────────────────────────────────
// grade.js — Pipeline chấm bài AN TOÀN TỐI ĐA
//
// 4 LỚP AN TOÀN CHỐNG LỖI:
//
//   LỚP 1 — Double-OCR Consensus:
//     Gọi Gemini 2.5 Flash 2 lần song song với prompt hơi khác nhau.
//     So sánh kết quả: dòng khớp → tin tuyệt đối, dòng lệch → cảnh báo.
//
//   LỚP 2 — Claude chấm với ẢNH GỐC + text OCR:
//     Claude Sonnet 4.6 nhận cả ảnh gốc + text OCR.
//     Nếu OCR lệch (từ Lớp 1), Claude tự quyết định dựa trên ảnh.
//     Prompt caching rubric để tiết kiệm chi phí.
//
//   LỚP 3 — Verify Integrity (chống AI sửa bài):
//     So sánh từng "dong" Claude trả về với OCR gốc bằng math signature.
//     Nếu AI tự sửa số → tự động khôi phục, flag cảnh báo.
//
//   LỚP 4 — Tính lại điểm từ rubric:
//     Không tin AI tự cộng điểm. Tính lại từ diem_tieu_chi và rubric.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const { verifyIntegrity, mergeDoubleOcr } = require('./verify');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Cấu hình upload
// ─────────────────────────────────────────────────────────────────────────────
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
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') upload.array('images', 20)(req, res, next);
    else next(err);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LỚP 1: Gemini OCR với prompt có ví dụ cụ thể
// ─────────────────────────────────────────────────────────────────────────────
const OCR_PROMPT_BASE = (subject) => `Bạn là máy OCR bài thi môn ${subject}. NHIỆM VỤ DUY NHẤT: chép lại y hệt những gì thấy trong ảnh.

⚠️ BẠN KHÔNG PHẢI GIÁO VIÊN. KHÔNG ĐƯỢC TÍNH TOÁN. KHÔNG ĐƯỢC SỬA LẠI CÁI SAI CỦA HỌC SINH.

NGUYÊN TẮC TUYỆT ĐỐI — VI PHẠM = SAI HOÀN TOÀN:

1. DÙ HỌC SINH VIẾT SAI LOGIC, SAI TOÁN, SAI KẾT QUẢ → vẫn phải ghi y hệt cái sai đó.
   VÍ DỤ QUAN TRỌNG:
   - Học sinh viết "Δ = b² - 4ac = -6² - 4·2·(-7) = 20" (sai, đúng phải là 92)
     → CHÉP Y HỆT: "Δ = b² - 4ac = -6² - 4·2·(-7) = 20"
     → TUYỆT ĐỐI KHÔNG sửa thành 92, KHÔNG thêm "(sai)" hay "(đúng ra là 92)"
   - Học sinh viết "2 + 2 = 5" → chép "2 + 2 = 5", KHÔNG sửa thành 4
   - Học sinh viết "x² = -4x" → chép "x² = -4x" dù logic có sai
   - Học sinh viết "h = 2√21" → chép y hệt, KHÔNG tự tính lại

2. TUYỆT ĐỐI KHÔNG chèn thêm "(sai)", "(đúng)", "(học sinh ghi…)", "(đáng ra là…)" hay bất kỳ bình luận nào.

3. KÝ HIỆU TOÁN — chép CHÍNH XÁC:
   - Phân số: phân biệt rõ tử/mẫu. "7/2" khác "-7". "a/b" viết 2 dòng vẫn là "a/b".
   - Chỉ số dưới: x₁, x₂, a₁₀ — dùng ký tự Unicode ₁₂₃...
   - Chỉ số trên (lũy thừa): x², x³, 10⁻² — dùng Unicode ²³...
   - Căn: √21, ∛8, ⁿ√x
   - Ký hiệu hình học: ⊥ (vuông góc), ∥ (song song), ∽ (đồng dạng), △ (tam giác), ∠ (góc), ⌢ (cung)
   - Ký hiệu logic: ⇒ (suy ra), ⇔ (tương đương), ∈ (thuộc), ∉ (không thuộc)
   - Delta Δ, pi π, theta θ, alpha α, beta β
   - Dấu xấp xỉ ≈, khác ≠, nhỏ hơn bằng ≤, lớn hơn bằng ≥

4. HÌNH VẼ / ĐỒ THỊ: mô tả ngắn trong [], ví dụ:
   - [Đồ thị parabol y = -2x² hướng xuống, qua O(0;0), (-2;-8), (2;-8)]
   - [Tam giác ABC nội tiếp đường tròn (O), H là chân đường cao từ A xuống BC]
   - [Bảng giá trị: x = -2,-1,0,1,2 tương ứng y = -8,-2,0,-2,-8]

5. Chữ mờ không đọc được: ghi [?]. Không đoán.

6. Giữ nguyên thứ tự xuống dòng. Mỗi dòng trên giấy = 1 phần tử trong mảng.

7. Nhiều ảnh: ghi [Trang 1], [Trang 2]... ở đầu mỗi trang.

8. Tổ chức theo câu: nhận biết "Câu 1", "Câu 2", "Bài 1", "a)", "b)" để nhóm đúng câu.

Trả về JSON thuần (không markdown, không text thừa):
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

// Prompt biến thể để tạo diversity cho double-OCR
const OCR_PROMPT_VARIANT = (subject) => OCR_PROMPT_BASE(subject) + `

LƯU Ý BỔ SUNG (phiên bản kiểm tra chéo):
- Đặc biệt chú ý các số, dấu, ký hiệu đặc biệt.
- Nếu không chắc chắn ký tự nào, ưu tiên chép chính xác số và toán tử hơn chữ.
- Với biểu thức nhiều tầng (phân số có phân số, căn có căn), đọc từ trong ra ngoài.`;

async function runGemini(files, prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0,       // Deterministic để OCR nhất quán
      maxOutputTokens: 65536 // Tối đa của Gemini 2.5 Flash — tránh bị cắt khi bài nhiều câu
    }
  });

  const imageParts = files.map(file => ({
    inlineData: {
      data: fs.readFileSync(file.path).toString('base64'),
      mimeType: file.mimetype
    }
  }));

  // Retry tối đa 3 lần nếu 503
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
  
  const m = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
  const jsonStr = m ? m[1] : text;
  return JSON.parse(repairJson(jsonStr));
}

// Double-OCR: chạy 2 lần song song rồi merge
async function transcribeWithDoubleOCR(files, subject) {
  console.log('  [OCR] Bắt đầu double-OCR song song...');
  const t0 = Date.now();
  
  const [ocr1, ocr2] = await Promise.all([
    runGemini(files, OCR_PROMPT_BASE(subject)),
    runGemini(files, OCR_PROMPT_VARIANT(subject))
  ]);
  
  const merged = mergeDoubleOcr(ocr1, ocr2);
  const dt = Date.now() - t0;
  console.log(`  [OCR] Xong sau ${dt}ms. Tổng dòng: ${merged.thong_ke.tong_dong}, khớp: ${merged.thong_ke.dong_khop}, lệch: ${merged.thong_ke.dong_lech}`);
  
  if (merged.canh_bao_ocr.length > 0) {
    console.log(`  [OCR] ⚠️ ${merged.canh_bao_ocr.length} dòng OCR 2 lần cho kết quả khác nhau — sẽ để Claude quyết định từ ảnh gốc`);
  }
  
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sửa JSON bị cắt giữa chừng (an toàn với escape)
// ─────────────────────────────────────────────────────────────────────────────
function repairJson(str) {
  let s = String(str).trim();
  
  // Đếm cấu trúc mở/đóng
  const stack = [];
  let inStr = false;
  let esc = false;
  
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.length) stack.pop();
    }
  }
  
  // Nếu đang trong string → đóng string
  if (inStr) s += '"';
  
  // Cắt bỏ trailing comma
  s = s.replace(/,\s*$/, '');
  
  // Đóng các cấu trúc còn hở
  if (stack.length > 0) {
    s += stack.reverse().join('');
  }
  
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// LỚP 2: Claude chấm với ẢNH GỐC + text OCR + prompt caching
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_GRADING = `Bạn là giáo viên chấm bài chuyên nghiệp. Bạn chấm bài theo rubric và tuân thủ nghiêm ngặt các nguyên tắc sau:

=== NGUYÊN TẮC VÀNG — TUYỆT ĐỐI KHÔNG VI PHẠM ===

1. TRƯỜNG "dong" PHẢI LÀ BẢN SAO Y HỆT những gì học sinh đã viết:
   - LẤY TRỰC TIẾP từ mảng "noi_dung_goc" của text OCR + đối chiếu với ảnh gốc.
   - TUYỆT ĐỐI KHÔNG TỰ TÍNH LẠI rồi ghi kết quả đúng vào "dong".
   - VÍ DỤ: học sinh viết "Δ = 20" (sai, đúng là 92) → "dong" phải là "Δ = 20", KHÔNG phải "Δ = 92".
   - TUYỆT ĐỐI KHÔNG thêm "(sai)", "(đúng)", "(học sinh ghi...)" vào "dong".
   - Mọi nhận xét đi vào trường "ghi_chu", "loi_sai", KHÔNG đi vào "dong".

2. Khi OCR text và ảnh gốc LỆCH NHAU:
   - Tin ảnh gốc. OCR có thể sai, ảnh học sinh viết là bản gốc.
   - Ghi rõ trong trường "ocr_sua_lai" của câu đó.

3. CHỈ CHO ĐIỂM NHỮNG GÌ HỌC SINH THỰC SỰ VIẾT:
   - Không suy diễn, không "cho qua" bước thiếu.
   - Tiêu chí rubric chưa đáp ứng → không cho điểm.
   - Cách làm khác vẫn được công nhận NẾU đúng toán VÀ đáp ứng tiêu chí.

4. Học sinh bỏ trống câu → diem_dat = 0, cham_tung_dong = [].

=== ĐỊNH DẠNG CÔNG THỨC TRONG JSON ===
- Chữ tiếng Việt: viết ngoài dấu $
- Công thức, số, biến: viết trong $...$
- Ví dụ: "Thay $y = 2x$ vào $y = -2x^2$, ta được $2x = -2x^2$"
- Sử dụng LaTeX: \\\\frac{a}{b}, \\\\sqrt{x}, x^2, x_1 (lưu ý dùng 4 dấu gạch chéo trong JSON string)

=== CẤU TRÚC KẾT QUẢ ===
Trả về JSON thuần (không markdown, không text thừa):
{
  "tong_diem": 0,
  "diem_toi_da": 0,
  "phan_tram": 0,
  "xep_loai": "Giỏi|Khá|Trung bình|Yếu",
  "nhan_xet_chung": "nhận xét ngắn toàn bài, 1-2 câu",
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "diem_dat": 0,
      "diem_toi_da": 0,
      "trang_thai": "Đúng|Sai|Đúng một phần|Bỏ trống",
      "ocr_sua_lai": "",
      "cham_tung_dong": [
        {
          "dong": "CHÉP NGUYÊN VĂN học sinh viết, không sửa",
          "ket_qua": "✓ Đúng|✗ Sai",
          "ghi_chu": "nếu sai: chỉ ra sai ở đâu, 1 câu ngắn. Nếu đúng: để rỗng"
        }
      ],
      "diem_tieu_chi": [
        { "tieu_chi": "mô tả tiêu chí từ rubric", "dat": true, "diem": 0 }
      ],
      "loi_sai": "1 câu mô tả lỗi chính, hoặc rỗng nếu đúng hết",
      "goi_y_sua": ""
    }
  ]
}`;

async function gradeWithClaude({ 
  transcribed, 
  rubric, 
  studentName, 
  subject, 
  imageFiles,   // để gửi ảnh gốc cho Claude
  ocrWarnings   // cảnh báo từ double-OCR
}) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Chuẩn bị text OCR (kèm cờ độ tin cậy nếu có)
  const baiLamParts = [];
  for (const cau of transcribed.cac_cau || []) {
    const lines = cau.noi_dung_goc || [];
    const tinCay = cau.do_tin_cay || [];
    const altLines = cau.noi_dung_goc_alt || [];
    
    baiLamParts.push(`\n${cau.so_cau}:`);
    for (let i = 0; i < lines.length; i++) {
      const conf = tinCay[i] || 'unknown';
      const alt = altLines[i] || '';
      
      if (conf === 'thap' && alt && alt !== lines[i]) {
        baiLamParts.push(`  ${lines[i]}   [OCR không chắc chắn — lần 2 đọc: "${alt}" → đối chiếu ảnh gốc]`);
      } else {
        baiLamParts.push(`  ${lines[i]}`);
      }
    }
  }
  const baiLamText = baiLamParts.join('\n');

  // Cảnh báo OCR nếu có
  let ocrWarningText = '';
  if (ocrWarnings && ocrWarnings.length > 0) {
    ocrWarningText = `\n\n⚠️ CẢNH BÁO OCR: ${ocrWarnings.length} dòng OCR 2 lần cho kết quả khác nhau. Vui lòng đối chiếu với ảnh gốc để quyết định. Chi tiết trong text bài làm đã đánh dấu.`;
  }

  // Chuẩn bị ảnh gốc để gửi cho Claude (tối đa 20 ảnh, giảm size nếu cần)
  const imageBlocks = [];
  for (const file of imageFiles) {
    const imageData = fs.readFileSync(file.path).toString('base64');
    imageBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: file.mimetype,
        data: imageData
      }
    });
  }

  // Prompt user: ảnh + text OCR + yêu cầu
  const userContent = [
    ...imageBlocks,
    {
      type: 'text',
      text: `Đây là bài làm của học sinh "${studentName}" môn ${subject}.

=== TEXT OCR TỪ BÀI LÀM ===
${baiLamText}${ocrWarningText}

=== NHIỆM VỤ ===
1. Đối chiếu text OCR với ảnh gốc. Nếu OCR sai, ghi bản đúng vào "ocr_sua_lai" của câu đó.
2. Chấm từng dòng theo rubric đã cung cấp trong system prompt.
3. Trường "dong" của mỗi dòng PHẢI là bản chép y hệt học sinh viết (không phải bản đúng toán).
4. Trả về JSON đúng cấu trúc. Không thêm text nào ngoài JSON.`
    }
  ];

  // System prompt với cache rubric
  // Rubric được cache để các bài sau của cùng lớp không phải trả phí input rubric nữa
  const systemPrompt = [
    {
      type: 'text',
      text: SYSTEM_PROMPT_GRADING
    },
    {
      type: 'text',
      text: `\n\n=== RUBRIC CHÍNH THỨC (dùng chung cho cả lớp) ===\n${JSON.stringify(rubric, null, 2)}`,
      cache_control: { type: 'ephemeral' }  // ← CACHE RUBRIC
    }
  ];

  // Sonnet 4.6 hỗ trợ tối đa 64k output tokens — tương thích mọi version SDK
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 64000,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  });

  // Log cache usage để theo dõi tiết kiệm
  const usage = response.usage || {};
  console.log(`  [Claude] Input: ${usage.input_tokens || 0} tokens, Output: ${usage.output_tokens || 0} tokens, Cache write: ${usage.cache_creation_input_tokens || 0}, Cache read: ${usage.cache_read_input_tokens || 0}`);

  // Extract text từ response
  const rawText = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  const m = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/(\{[\s\S]*\})/);
  let jsonStr = m ? m[1] : rawText;
  jsonStr = repairJson(jsonStr);
  
  const parsed = JSON.parse(jsonStr);
  return { parsed, usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// LỚP 4: Tính lại điểm từ rubric (không tin AI tự cộng)
// ─────────────────────────────────────────────────────────────────────────────
function normalizeText(s) {
  return String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function recomputeScoresFromRubric(parsed, rubric) {
  const rubricMap = new Map();
  for (const cau of rubric.cac_cau || []) {
    rubricMap.set(normalizeText(cau.so_cau), cau);
  }
  
  let tong = 0;
  parsed.cac_cau = (parsed.cac_cau || []).map(cau => {
    const rubricCau = rubricMap.get(normalizeText(cau.so_cau));
    if (!rubricCau) {
      return {
        ...cau,
        diem_dat: 0,
        diem_toi_da: cau.diem_toi_da || 0,
        co_nghi_van_rubric: true,
        ghi_chu_noi_bo: 'Không khớp số câu với rubric'
      };
    }

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
  });

  parsed.tong_diem = Math.round(tong * 100) / 100;
  parsed.diem_toi_da = Number(rubric.tong_diem || 0);
  parsed.phan_tram = parsed.diem_toi_da > 0
    ? Math.round((parsed.tong_diem / parsed.diem_toi_da) * 1000) / 10
    : 0;
  const pct = parsed.phan_tram;
  parsed.xep_loai = pct >= 80 ? 'Giỏi' : pct >= 65 ? 'Khá' : pct >= 50 ? 'Trung bình' : 'Yếu';
  
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// TÍNH CHI PHÍ (để bạn theo dõi từng bài)
// ─────────────────────────────────────────────────────────────────────────────
function computeCost(usage) {
  // Giá tháng 4/2026
  const SONNET_INPUT = 3 / 1_000_000;           // $3/MTok
  const SONNET_OUTPUT = 15 / 1_000_000;         // $15/MTok
  const SONNET_CACHE_WRITE = 3.75 / 1_000_000;  // $3.75/MTok (cache creation 1.25x)
  const SONNET_CACHE_READ = 0.30 / 1_000_000;   // $0.30/MTok (cache read 0.1x)
  
  const input = (usage.input_tokens || 0) * SONNET_INPUT;
  const output = (usage.output_tokens || 0) * SONNET_OUTPUT;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) * SONNET_CACHE_WRITE;
  const cacheRead = (usage.cache_read_input_tokens || 0) * SONNET_CACHE_READ;
  
  return {
    input_usd: Math.round(input * 10000) / 10000,
    output_usd: Math.round(output * 10000) / 10000,
    cache_write_usd: Math.round(cacheWrite * 10000) / 10000,
    cache_read_usd: Math.round(cacheRead * 10000) / 10000,
    total_usd: Math.round((input + output + cacheWrite + cacheRead) * 10000) / 10000,
    total_vnd: Math.round((input + output + cacheWrite + cacheRead) * 25000 * 100) / 100
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT CHÍNH: POST /api/grade
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', uploadMiddleware, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { rubric: rubricStr, studentName = 'Học sinh', subject = 'Bài kiểm tra' } = req.body;

    if (!req.files?.length)
      return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh bài làm' });
    if (!rubricStr)
      return res.status(400).json({ error: 'Vui lòng cung cấp rubric' });

    let rubric;
    try { rubric = JSON.parse(rubricStr); }
    catch { return res.status(400).json({ error: 'Rubric không đúng định dạng JSON' }); }

    if (!process.env.GEMINI_API_KEY)
      return res.status(500).json({ error: 'Thiếu GEMINI_API_KEY trong biến môi trường' });
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(500).json({ error: 'Thiếu ANTHROPIC_API_KEY trong biến môi trường' });

    console.log(`\n[${studentName}] ─── BẮT ĐẦU CHẤM BÀI (an toàn tối đa) ───`);
    console.log(`[${studentName}] Số ảnh: ${req.files.length}, môn: ${subject}`);

    // ═══ LỚP 1: Double-OCR ═══
    console.log(`[${studentName}] LỚP 1: Double-OCR Gemini 2.5 Flash...`);
    const transcribed = await transcribeWithDoubleOCR(req.files, subject);
    
    // ═══ LỚP 2: Claude Sonnet 4.6 với ảnh gốc + cache rubric ═══
    console.log(`[${studentName}] LỚP 2: Claude Sonnet 4.6 chấm (với ảnh gốc)...`);
    const { parsed, usage } = await gradeWithClaude({
      transcribed,
      rubric,
      studentName,
      subject,
      imageFiles: req.files,
      ocrWarnings: transcribed.canh_bao_ocr
    });
    
    // ═══ LỚP 3: Verify Integrity ═══
    console.log(`[${studentName}] LỚP 3: Verify chống AI sửa bài...`);
    const { gradingResult: verified, violations, stats } = verifyIntegrity(parsed, transcribed);
    
    if (violations.length > 0) {
      console.log(`[${studentName}]   ⚠️ Phát hiện ${violations.length} dòng AI tự sửa, đã khôi phục ${stats.autoFixedCount} từ OCR gốc`);
    } else {
      console.log(`[${studentName}]   ✓ Không phát hiện AI sửa bài (${stats.totalLines} dòng sạch)`);
    }
    
    // ═══ LỚP 4: Tính lại điểm từ rubric ═══
    console.log(`[${studentName}] LỚP 4: Tính lại điểm từ rubric...`);
    const finalResult = recomputeScoresFromRubric(verified, rubric);
    
    // ═══ Kết quả cuối ═══
    const elapsed = Date.now() - startTime;
    const cost = computeCost(usage);
    console.log(`[${studentName}] ═══ HOÀN THÀNH: ${finalResult.tong_diem}/${finalResult.diem_toi_da} (${finalResult.phan_tram}% - ${finalResult.xep_loai})`);
    console.log(`[${studentName}] Thời gian: ${elapsed}ms | Chi phí: $${cost.total_usd} (~${cost.total_vnd}đ)`);

    // Lưu kết quả
    const resultId = uuidv4();
    const resultData = {
      id: resultId,
      studentName,
      subject,
      gradingResult: finalResult,
      transcribed,
      imageFiles: req.files.map(f => f.filename),
      rubric,
      metadata: {
        elapsed_ms: elapsed,
        cost,
        usage,
        ocr_warnings: transcribed.canh_bao_ocr?.length || 0,
        integrity_violations: violations.length,
        auto_fixed: stats.autoFixedCount
      },
      createdAt: new Date().toISOString()
    };

    const resultsDir = path.join(__dirname, '../results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${resultId}.json`), JSON.stringify(resultData, null, 2));

    res.json({
      success: true,
      resultId,
      studentName,
      subject,
      gradingResult: finalResult,
      transcribed,
      imageUrls: req.files.map(f => `/uploads/${f.filename}`),
      metadata: resultData.metadata
    });

  } catch (error) {
    console.error('Lỗi chấm bài:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: /api/grade/transcribe — chỉ OCR
// ─────────────────────────────────────────────────────────────────────────────
router.post('/transcribe', uploadMiddleware, async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Vui lòng upload ít nhất 1 ảnh' });
    const { subject = 'Toán' } = req.body;
    const transcribed = await transcribeWithDoubleOCR(req.files, subject);

    const sessionId = uuidv4();
    const sessionsDir = path.join(__dirname, '../results/sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({ 
        sessionId, 
        imageFiles: req.files.map(f => f.filename), 
        transcribed, 
        createdAt: new Date().toISOString() 
      }, null, 2)
    );

    res.json({ 
      success: true, 
      sessionId, 
      transcribed, 
      imageUrls: req.files.map(f => `/uploads/${f.filename}`) 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: /api/grade/score — chấm từ session đã OCR sẵn
// ─────────────────────────────────────────────────────────────────────────────
router.post('/score', async (req, res) => {
  try {
    const { 
      sessionId, 
      transcribed: transcribedInput, 
      rubric: rubricStr, 
      studentName = 'Học sinh', 
      subject = 'Bài kiểm tra' 
    } = req.body;
    
    if (!transcribedInput || !rubricStr) 
      return res.status(400).json({ error: 'Thiếu dữ liệu' });

    let rubric;
    try { rubric = typeof rubricStr === 'string' ? JSON.parse(rubricStr) : rubricStr; }
    catch { return res.status(400).json({ error: 'Rubric không đúng JSON' }); }

    // Lấy lại ảnh từ session
    let imageFiles = [];
    if (sessionId) {
      const sp = path.join(__dirname, '../results/sessions', `${sessionId}.json`);
      if (fs.existsSync(sp)) {
        const session = JSON.parse(fs.readFileSync(sp, 'utf8'));
        imageFiles = session.imageFiles.map(filename => ({
          filename,
          path: path.join(__dirname, '../uploads', filename),
          mimetype: filename.match(/\.png$/i) ? 'image/png' : 
                    filename.match(/\.webp$/i) ? 'image/webp' : 'image/jpeg'
        }));
      }
    }

    const transcribed = typeof transcribedInput === 'string' ? JSON.parse(transcribedInput) : transcribedInput;

    const { parsed, usage } = await gradeWithClaude({
      transcribed,
      rubric,
      studentName,
      subject,
      imageFiles,
      ocrWarnings: transcribed.canh_bao_ocr
    });
    
    const { gradingResult: verified, violations, stats } = verifyIntegrity(parsed, transcribed);
    const finalResult = recomputeScoresFromRubric(verified, rubric);

    const resultId = uuidv4();
    const resultData = {
      id: resultId,
      studentName,
      subject,
      gradingResult: finalResult,
      transcribed,
      imageFiles: imageFiles.map(f => f.filename),
      rubric,
      metadata: {
        cost: computeCost(usage),
        integrity_violations: violations.length,
        auto_fixed: stats.autoFixedCount
      },
      createdAt: new Date().toISOString()
    };
    
    fs.writeFileSync(
      path.join(__dirname, '../results', `${resultId}.json`), 
      JSON.stringify(resultData, null, 2)
    );

    res.json({ 
      success: true, 
      resultId, 
      studentName, 
      subject, 
      gradingResult: finalResult, 
      transcribed, 
      imageUrls: imageFiles.map(f => `/uploads/${f.filename}`),
      metadata: resultData.metadata
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET endpoints (giữ nguyên như cũ)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const fp = path.join(__dirname, '../results', `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

router.get('/', (req, res) => {
  const dir = path.join(__dirname, '../results');
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          id: d.id,
          studentName: d.studentName,
          subject: d.subject,
          tongDiem: d.gradingResult?.tong_diem,
          diemToiDa: d.gradingResult?.diem_toi_da,
          phanTram: d.gradingResult?.phan_tram,
          xepLoai: d.gradingResult?.xep_loai,
          coCanhBao: (d.metadata?.integrity_violations || 0) > 0 || (d.metadata?.ocr_warnings || 0) > 0,
          createdAt: d.createdAt
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

module.exports = router;
