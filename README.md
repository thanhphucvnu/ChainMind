## ChainMind

Web app để nhập một địa chỉ ví Ethereum và suy đoán “quốc gia” theo heuristic dựa trên danh sách nhãn đối tác trong `src/data/entities.json`.

Lưu ý: Đây **không** phải suy luận on-chain chắc chắn về quốc gia của chủ ví (blockchain không chứa quốc gia).

## Setup

1. Lấy `ETHERSCAN_API_KEY` từ Etherscan.
2. Tạo biến môi trường:
   - Local: tạo file `.env` ở root và thêm `ETHERSCAN_API_KEY=...`
   - Deploy (Vercel): set Environment Variable `ETHERSCAN_API_KEY`
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

Backend lấy tx đầu tiên của ví (theo `maxTx`), rồi đếm các counterparty trùng với `entities.json` để suy ra country “phổ biến nhất”.

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
