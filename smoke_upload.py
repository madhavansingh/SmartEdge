import requests, numpy as np
from PIL import Image, ImageDraw, ImageFilter
from io import BytesIO

def make_img(color, w=400, h=300):
    img = Image.new("RGB", (w, h), (20, 20, 20))
    draw = ImageDraw.Draw(img)
    pad = max(4, min(w, h) // 6)
    draw.rectangle([pad, pad, w - pad, h - pad], fill=color)
    arr = np.array(img)
    noise = np.random.randint(-12, 12, arr.shape, dtype=np.int16)
    arr = np.clip(arr.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr).filter(ImageFilter.GaussianBlur(0.4))
    buf = BytesIO(); img.save(buf, "JPEG", quality=90); buf.seek(0)
    return buf

cases = [
    ("BISCUIT", make_img((195, 155, 65)),         "good golden biscuit"),
    ("PCB",     make_img((40, 100, 60)),           "green PCB"),
    ("BISCUIT", BytesIO(b"not-an-image"),          "corrupt file"),
    ("BISCUIT", make_img((195, 155, 65), 80, 60), "too small (<100px)"),
]

for ptype, buf, label in cases:
    r = requests.post(
        "http://localhost:8000/predict-upload",
        data={"product_type": ptype, "user_id": "smoke"},
        files={"file": ("test.jpg", buf, "image/jpeg")},
        timeout=15,
    )
    d = r.json()
    print(f"[{label}]")
    print(f"  HTTP={r.status_code}  status={d.get('status')}  conf={d.get('confidence')}")
    print(f"  reason: {d.get('reason') or d.get('message')}")
    print()
