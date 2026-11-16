import os
from PIL import Image

ROOT = r"C:\Users\KALI\Documents\anime-companion"
src = os.path.join(ROOT, "android", "app", "src", "main", "res", "mipmap-xxxhdpi", "ic_launcher.png")
build_dir = os.path.join(ROOT, "build")
os.makedirs(build_dir, exist_ok=True)
dst = os.path.join(build_dir, "icon.ico")

img = Image.open(src)
img.save(dst, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print(f"Created {dst} successfully!")
