## ChainMind

Web app để nhập một địa chỉ ví Ethereum và suy đoán “quốc gia” theo heuristic dựa trên danh sách nhãn đối tác trong `src/data/entities.json`.

Lưu ý: Đây **không** phải suy luận on-chain chắc chắn về quốc gia của chủ ví (blockchain không chứa quốc gia).

## Setup

1. Lấy API key từ các explorer (Etherscan-family) tuỳ chain bạn muốn bật:
   - `ETHERSCAN_API_KEY` (Ethereum)
   - `BSCSCAN_API_KEY` (BSC)
   - `POLYGONSCAN_API_KEY` (Polygon)
   - `ARBISCAN_API_KEY` (Arbitrum)
   - `BASESCAN_API_KEY` (Base)
2. Tạo biến môi trường:
   - Local: tạo file `.env` ở root và thêm các key ở trên
   - Deploy (Render/Vercel): set Environment Variables tương ứng
3. Cập nhật danh sách nhãn:
   - Sửa file `src/data/entities.json`
   - Format phần tử:

```json
[
  {
    "address": "0x1234...abcd",
    "country": "Vietnam",
    "name": "Exchange/Entity name (optional)"
  }
]
```

Backend sẽ lấy tx đầu tiên của ví (theo `maxTx`) trên nhiều chain, tạo histogram theo giờ UTC để **ước lượng timezone**.
Phần `entities.json` vẫn có thể dùng cho heuristic theo nhãn (tuỳ bạn mở rộng tiếp).

## Run locally

```bash
npm run dev
```

Mở `http://localhost:3000`.

## Deploy on Vercel

1. Push code lên GitHub.
2. Import repo vào Vercel.
3. Set `ETHERSCAN_API_KEY`.
4. Deploy.

## Tuning (optional)

Bạn có thể tune engine qua env (không cần sửa code), ví dụ:

- `LOOKUP_PROFILE=safe|balanced|aggressive` (khuyến nghị set trước)
- `LOOKUP_TWO_HOP_MAX_NEIGHBORS`, `LOOKUP_TWO_HOP_MAX_MILLIS`, `LOOKUP_TWO_HOP_WEIGHT`
- `LOOKUP_PRIOR_ENTROPY_CUTOFF`, `LOOKUP_PRIOR_LOW_TX_CUTOFF`

Chi tiết đầy đủ xem `ENV_EXAMPLE.md`.

## Huấn luyện với data (địa chỉ + quốc gia)

1. Tạo file nhãn (mỗi dòng một JSON), ví dụ theo `training/examples/labels.example.jsonl`: `{"address":"0x...","country":"Vietnam"}`.  
   **Không** đưa file nhãn thật (vd. `src/data/data.csv`) lên GitHub — file đó đã được liệt kê trong `.gitignore`; nếu trước đó đã `git add` nhầm, chạy `git rm --cached src/data/data.csv` rồi commit.
2. Chạy app local (`npm run dev`) với **`LEARNED_MODEL_BLEND=0`** (mặc định), rồi export vector đặc trưng (gọi API lookup, tuân thủ rate limit Etherscan):

```bash
npm run train:export -- --input path/to/labels.jsonl --out training/data/features.jsonl --delay-ms 400
```

3. Cài Python deps và train multiclass logistic (scikit-learn), xuất JSON cho app:

```bash
cd training
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python train_multicountry.py --data data/features.jsonl --out ../src/data/learnedCountryModel.json
```

4. Bật mô hình trong `.env`: `LEARNED_COUNTRY_MODEL_PATH=src/data/learnedCountryModel.json` và `LEARNED_MODEL_BLEND=0.35` (chỉnh 0–1).

Vector đặc trưng được định nghĩa tại `src/lib/trainingFeatures.ts` (histogram 24h, timezone/engine top-5, entropy, số đối tác, loại ví, confidence…). Tên quốc gia trong nhãn nên **thống nhất** với chuỗi mà bạn muốn API trả về (hoặc post-process sau train).

### Nâng độ chính xác (on-chain + off-chain + data có sẵn)

- **Mở rộng `entities.json` / `entityLabels.json`:** nhãn CEX, bridge, payment theo khu vực — đây là lever mạnh nhất cho tín hiệu đối tác + tín hiệu **giao dịch sớm** (on-ramp).
- **Đa chuỗi:** set `LOOKUP_EXTRA_CHAIN_IDS` (vd. `8453,42161`) nếu ví hoạt động nhiều trên L2 — histogram và graph gộp thêm dữ liệu (tốn thêm quota API).
- **Train lại ML** sau khi thu thập thêm nhãn và sau mỗi lần đổi engine/features: `train:export` → `train:model`. Model cũ không khớp số chiều vector mới sẽ bị bỏ qua.
- **Off-chain (tùy nghiệp vụ):** có thể bổ sung pipeline riêng (KYC, CRM, sanctions list) rồi **trộn** với kết quả API hoặc thêm vào `entities` — không có trong repo mặc định.
- **API bên thứ ba:** Arkham, Nansen, Chainalysis… (cần key + tuân thủ điều khoản) nếu ngân sách cho phép.
