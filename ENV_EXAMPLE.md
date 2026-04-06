## Env variables

### Required
- `ETHERSCAN_API_KEY`: API key để backend gọi Etherscan.

### Optional tuning (lookup engine)
- `LOOKUP_PROFILE` (default `balanced`, values: `safe` | `balanced` | `aggressive`)
- `LOOKUP_ONE_HOP_TOP_N` (default `80`)
- `LOOKUP_ONE_HOP_MIN_TX_COUNT` (default `2`)
- `LOOKUP_UI_ONE_HOP_TOP_N` (default `12`)
- `LOOKUP_TWO_HOP_INPUT_TOP_N` (default `20`)
- `LOOKUP_TWO_HOP_MAX_NEIGHBORS` (default `6`)
- `LOOKUP_TWO_HOP_MAX_MILLIS` (default `6500`)
- `LOOKUP_TWO_HOP_NEIGHBOR_OFFSET` (default `60`)
- `LOOKUP_TWO_HOP_WEIGHT` (default `0.45`)
- `LOOKUP_NEIGHBOR_CACHE_TTL_MS` (default `300000`)
- `LOOKUP_PRIOR_ENTROPY_CUTOFF` (default `0.88`)
- `LOOKUP_PRIOR_LOW_TX_CUTOFF` (default `25`)
- `LOOKUP_PRIOR_VERY_LOW_TX_CUTOFF` (default `10`)
- `LOOKUP_PRIOR_ALPHA_VERY_LOW_TX` (default `0.55`)
- `LOOKUP_PRIOR_ALPHA_LOW_TX` (default `0.35`)

### Quick start
- Muốn chạy ổn định/nhanh: `LOOKUP_PROFILE=safe`
- Mặc định cân bằng: `LOOKUP_PROFILE=balanced`
- Muốn bắt signal mạnh hơn (đổi lại tốn API hơn): `LOOKUP_PROFILE=aggressive`

Các biến chi tiết bên trên sẽ **override** profile.

### Giao dịch đầu chuỗi (anchor)
- `LOOKUP_TX_ANCHOR_ASC_OFFSET`: sau khi tải `maxTx` giao dịch **mới nhất** (sort `desc`), backend gọi thêm một lần mỗi loại (`txlist` / `internal` / `token`) với `sort=asc` và `offset` = min(giá trị này, `maxTx`) để **luôn gộp các giao dịch cũ nhất on-chain** vào phân tích. Mặc định `25`; `0` = tắt. Giúp ví nhiều giao dịch vẫn thấy on-ramp đầu (vd. Bitbank) dù không nằm trong cửa sổ “mới nhất”.

### Đa chuỗi + tín hiệu sớm (tùy chọn — tăng độ phủ on-chain)
- `LOOKUP_EXTRA_CHAIN_IDS`: danh sách `chainId` Etherscan API v2 (cùng key `ETHERSCAN_API_KEY`), cách nhau dấu phẩy. Ví dụ: `8453,42161,137` (Base, Arbitrum, Polygon). Mặc định rỗng = chỉ Ethereum.
- `LOOKUP_EXTRA_CHAIN_MAX`: tối đa số chain phụ (mặc định `3`, max `8`).
- `LOOKUP_EXTRA_CHAIN_TX_OFFSET`: số tx tối đa mỗi loại (txlist / internal / token) trên mỗi chain phụ (mặc định `150`).
- `LOOKUP_EARLY_ENTITY_WEIGHT`: trọng số trộn “đối tác đã gắn nhãn trong các giao dịch **sớm nhất**” (CEX/bridge…), `0..1.5` (mặc định `0.48`).
- `LOOKUP_EARLY_TX_WINDOW`: số giao dịch theo thời gian từ cũ → mới để tìm tín hiệu sớm (mặc định `80`).

### Suy luận nhãn động (tra cứu tên trên explorer → quốc gia)
- `LOOKUP_NAMETAG_CHRONO_MAX`: quét giao dịch theo thời gian **cũ → mới** trong batch; với mỗi đối tác mới, gọi Etherscan `getaddresstag` cho đến khi có nhãn kiểu sàn (thương hiệu suy ra được, label Exchange, hoặc dạng `Tên 123`). Mặc định `25`; `0` = không gọi nametag (chỉ dùng `entityLabels.json`). Thường cần **Etherscan Pro Plus**.
- `LOOKUP_NAMETAG_MAX_CALLS`: (legacy) nếu &gt; `LOOKUP_NAMETAG_CHRONO_MAX` thì dùng giá trị này làm trần số lần gọi nametag.
- `LOOKUP_NAMETAG_DELAY_MS`: nghỉ giữa các lần gọi nametag (mặc định `520`, tối đa `5000`).
- `LOOKUP_FIRST_TX_COUNTRY_BLEND`: nếu giao dịch sớm nhất trong batch có đối tác đã gắn quốc gia (entity / suy từ tên CEX), trộn phân phối quốc gia cuối: tỉ lệ `alpha` cho prior từ CEX đó, `(1-alpha)` cho kết quả fuse hiện tại (mặc định `0.78`, `0` = tắt).

### Learned model (optional — sau khi train)
- `LEARNED_COUNTRY_MODEL_PATH`: đường dẫn tới file JSON do `training/train_multicountry.py` sinh ra (vd. `src/data/learnedCountryModel.json`).
- `LEARNED_MODEL_BLEND`: trọng số trộn mô hình học với engine heuristic, `0..1` (vd. `0.35`). Mặc định `0` = tắt.

**Lưu ý:** Sau khi cập nhật vector đặc trưng ML (thêm `trainingShape` / chiều mới), cần **`npm run train:export`** và **`npm run train:model`** lại; model cũ (43 chiều) sẽ không còn tương thích.

