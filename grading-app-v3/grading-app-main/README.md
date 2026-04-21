# 🎓 Grading App v3 — Chấm bài tự luận tối giản

Ứng dụng chấm bài kiểm tra viết tay bằng AI. Upload ảnh bài làm → nhận kết quả **đúng/sai từng dòng** + nhận xét ngắn gọn chỉ chỗ sai.

## ✨ Thay đổi v3 (so với v2)

### 🚀 Chấm nhanh hơn (~40% nhanh hơn v2)
- **Bỏ verify.js** (double-check AI sửa bài) — cơ chế `dong_index` strict đã đủ an toàn.
- **Bỏ nhan_xet_chung, loi_sai tổng, goi_y_sua** — Claude chỉ trả đúng/sai từng dòng + đạt/không từng tiêu chí.
- **Giảm max_tokens Claude** từ 16000 → 8000 (đủ cho format tối giản).

### 📊 Chấm đúng/sai
- Cột **"Bài làm học sinh" BẤT KHẢ XÂM PHẠM** — Claude chỉ trả `dong_index`, backend tự điền `dong` từ OCR gốc. Cơ chế strict: entry không có `dong_index` hợp lệ bị drop.
- Cột **"Kết quả"**: ✓ hoặc ✗ (chỉ 2 giá trị).
- Cột **"Nhận xét"**: trống nếu đúng. Chỉ ghi chỗ sai (≤1 câu) nếu sai. **KHÔNG hướng dẫn sửa** ("Hãy...", "Nên...").

### 💯 Tính điểm theo rubric
- Câu có **`tieu_chi` với điểm > 0**: cộng điểm các tiêu chí đạt. Tiêu chí có `diem=0` không tính.
- Câu **không có `tieu_chi`** (chỉ có `diem` tổng):
  - Bỏ trống → 0đ
  - Toàn đúng → full điểm
  - Có sai → điểm theo tỉ lệ `(số dòng đúng / tổng dòng) × điểm tối đa`

### 📄 Xuất PDF ổn định (đã fix lỗi compile)
- **LaTeX auto-wrap**: `\sqrt{21}` thô của Claude/Gemini tự động được bọc `$...$`.
- **Sửa typo thường gặp**: `\Detla` → `\Delta`, `\rac{` → `\frac{`, v.v.
- **Safe fallback**: unknown command như `\fracc{a}{b}` được strip thành text thường thay vì làm compile fail.
- **Strip emoji triệt để** trong cell LaTeX (TeX Gyre Termes không có bold glyph cho ✓ ✗).
- **Column layout** dùng `\raggedright\arraybackslash` + `p{width}` để text wrap đúng, tránh overfull hbox.
- **`\tolerance=2000 \emergencystretch=3em`** để compile tolerant hơn.
- **Đã test local XeLaTeX**: compile thành công cả với `Δ'`, `√(a+b)`, `$\Delta = 20$`, tên có `&`, ghi chú dài, câu bỏ trống.

## 📡 API Endpoints

| Method | URL | Mô tả |
|--------|-----|-------|
| GET | `/api/health` | Kiểm tra server |
| POST | `/api/grade` | Chấm bài (upload ảnh + rubric) |
| GET | `/api/grade` | Danh sách bài đã chấm |
| GET | `/api/grade/:id` | Chi tiết 1 bài |
| POST | `/api/rubric/parse` | Parse file Word/JSON thành rubric |
| GET | `/api/export/:id/html` | Báo cáo HTML (có nút in PDF) |
| GET | `/api/export/:id/pdf` | Xuất PDF qua XeLaTeX |
| GET | `/api/export/:id/pdf?via=latex` | Ép LaTeX, hiện lỗi JSON nếu fail (debug) |
| GET | `/api/export/:id/pdf?via=print` | Ép HTML print (không qua LaTeX) |
| GET | `/api/export/:id/latex` | Xem LaTeX source (debug) |
| GET | `/api/export/:id/annotated-all` | Ảnh bài làm kèm header điểm |

## 🛠 Env Variables

| Biến | Mô tả | Bắt buộc |
|------|-------|----------|
| `ANTHROPIC_API_KEY` | Key Claude | ✅ |
| `GEMINI_API_KEY` | Key Gemini (OCR) | ✅ |
| `PORT` | Port (mặc định 3001) | |
| `GEMINI_MODEL` | Override model Gemini (mặc định `gemini-2.5-flash`) | |
| `LATEX_SERVICE_URL` | URL XeLaTeX service (mặc định `https://overlef-my-production.up.railway.app/compile`) | |
| `LATEX_DISABLED` | Set `=1` để tắt LaTeX, luôn dùng HTML print | |

## 📋 Format Rubric JSON

```json
{
  "ten_de": "Kiểm tra 15 phút - Đại số",
  "mon_hoc": "Toán",
  "lop": "8A",
  "tong_diem": 10,
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "noi_dung": "Rút gọn: (x+2)² - (x-2)²",
      "diem": 3,
      "dap_an": "8x",
      "tieu_chi": [
        { "mo_ta": "Khai triển đúng", "diem": 2 },
        { "mo_ta": "Kết quả 8x", "diem": 1 }
      ]
    },
    {
      "so_cau": "Câu 2",
      "noi_dung": "Giải PT 2x+5=13",
      "diem": 3,
      "dap_an": "x = 4"
    }
  ]
}
```

- Câu 1 có `tieu_chi` → điểm = tổng điểm các TC đạt.
- Câu 2 không có `tieu_chi` → chấm theo tỉ lệ dòng đúng.

## 🚀 Deploy

### Bước 1 — Install
```bash
cd backend && npm install
cd ../frontend && npm install
```

### Bước 2 — Chạy local
Tạo `backend/.env`:
```
ANTHROPIC_API_KEY=sk-ant-xxx
GEMINI_API_KEY=xxx
PORT=3001
```

```bash
cd backend && npm run dev
# → http://localhost:3001/api/health
```

### Bước 3 — Deploy Railway
Backend + Frontend deploy riêng. Set env vars như trên.

## 🔍 Debug PDF lỗi

Nếu xuất PDF vẫn lỗi, thử theo thứ tự:
1. `GET /api/export/:id/pdf?via=latex` → xem error JSON từ service
2. `GET /api/export/:id/latex` → xem raw LaTeX source (có số dòng)
3. Check log Railway backend — khi LaTeX compile fail, sẽ log `═══ LATEX COMPILE ERROR ═══` với 2000 ký tự đầu của LaTeX source.
4. Fallback: `GET /api/export/:id/pdf?via=print` để ép dùng HTML print (Ctrl+P từ browser).
