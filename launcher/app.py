"""
app.py — Standalone Desktop Launcher for Jinx (3D Anime AI Companion)

Binds an embedded static server and launches a frameless transparent
desktop overlay with pywebview.
"""

import sys
import os
import socket
import threading
import mimetypes
from http.server import HTTPServer, SimpleHTTPRequestHandler
import urllib.request
import json
import argparse
import webview

# Add custom MIME types for 3D formats
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/octet-stream", ".fbx")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")

def get_base_dir():
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def get_dist_dir():
    base = get_base_dir()
    cand1 = os.path.join(base, "dist")
    if os.path.isdir(cand1):
        return cand1
    cand2 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
    if os.path.isdir(cand2):
        return cand2
    return base

class CompanionHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=get_dist_dir(), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        # API Health Endpoint
        if self.path.startswith("/api/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            # Probe voice service and local bridge
            voice_ok = False
            llm_ok = False
            is_gemini = False
            try:
                req = urllib.request.urlopen("http://127.0.0.1:4123/health", timeout=0.8)
                if req.status == 200:
                    voice_ok = True
            except:
                pass

            try:
                req = urllib.request.urlopen("http://127.0.0.1:5200/health", timeout=0.8)
                if req.status == 200:
                    llm_ok = True
                    is_gemini = True
            except:
                pass

            resp = {
                "ok": True,
                "llm": llm_ok,
                "llmModel": "gemini-agent" if is_gemini else None,
                "isGemini": is_gemini,
                "voice": voice_ok,
                "stt": voice_ok,
                "sttDevice": "cpu"
            }
            self.wfile.write(json.dumps(resp).encode("utf-8"))
            return

        # API Affection Endpoint
        if self.path.startswith("/api/affection"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            affection_data = {
                "points": 50,
                "level": 2,
                "title": "Partner in Crime",
                "desc": "Trusts you with the detonator; loves coding together.",
                "mood": "chaotic"
            }
            # Attempt to read data/affection.json if it exists
            data_file = os.path.join(get_base_dir(), "data", "affection.json")
            if os.path.isfile(data_file):
                try:
                    with open(data_file, "r", encoding="utf-8") as f:
                        saved = json.load(f)
                        affection_data.update(saved)
                except:
                    pass
            self.wfile.write(json.dumps(affection_data).encode("utf-8"))
            return

        return super().do_GET()

    def log_message(self, format, *args):
        # Suppress noisy HTTP request logging in GUI
        pass

def start_server():
    server = HTTPServer(("127.0.0.1", 0), CompanionHTTPHandler)
    port = server.server_port
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return port

_lock_socket = None
def acquire_single_instance_lock():
    global _lock_socket
    try:
        _lock_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _lock_socket.bind(("127.0.0.1", 49199))
    except (socket.error, OSError):
        print("[Jinx] Notice: Another instance is already running.")
        sys.exit(0)

def main():
    acquire_single_instance_lock()
    
    parser = argparse.ArgumentParser(description="Jinx - 3D Anime AI Companion")
    parser.add_argument("--window", action="store_true", help="Launch in standard windowed mode rather than transparent overlay")
    parser.add_argument("--tray", action="store_true", help="Started at Windows boot")
    args = parser.parse_args()

    port = start_server()
    is_overlay = not args.window
    target_url = f"http://127.0.0.1:{port}/?overlay=1" if is_overlay else f"http://127.0.0.1:{port}/"

    screens = webview.screens
    screen = screens[0] if screens else None

    if is_overlay:
        width, height = 420, 660
        if screen:
            x = max(20, screen.width - width - 30)
            y = max(20, screen.height - height - 50)
        else:
            x, y = 1000, 200

        window = webview.create_window(
            title="Jinx - Desktop Companion",
            url=target_url,
            width=width,
            height=height,
            x=x,
            y=y,
            frameless=True,
            easy_drag=True,
            on_top=True,
            transparent=True,
            background_color="#00000000",
        )
    else:
        width, height = 1100, 750
        window = webview.create_window(
            title="Jinx - 3D Anime AI Companion",
            url=target_url,
            width=width,
            height=height,
            frameless=False,
            easy_drag=False,
            on_top=False,
        )

    webview.start(debug=False)

if __name__ == "__main__":
    main()
