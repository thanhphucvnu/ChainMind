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
