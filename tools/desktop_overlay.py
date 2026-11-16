"""
desktop_overlay.py — Transparent Always-On-Top Desktop Anime Companion

Launches Jinx as a transparent, frameless, floating desktop pet/assistant that
sits on top of your Windows desktop and other applications.

You can drag her anywhere on your screens, speak to her via voice (Whisper STT),
or type tasks into her floating glass command bar. She will animate, gesture,
and talk back via Piper TTS with real-time lip-sync.
"""

import sys
import argparse
import socket
import webview

# Socket-based single-instance lock (fails instantly if another instance holds the port)
_lock_socket = None

def acquire_single_instance_lock():
    global _lock_socket
    try:
        _lock_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _lock_socket.bind(('127.0.0.1', 49199))
    except (socket.error, OSError):
        print("==========================================================")
        print("  [Jinx] Notice: Desktop Overlay is already active!")
        print("  Prevented duplicate instance to avoid audio echo/doubling.")
        print("==========================================================")
        sys.exit(0)

def main():
    acquire_single_instance_lock()
    parser = argparse.ArgumentParser(description="Jinx Transparent Desktop Overlay")
    parser.add_argument("--url", default="http://127.0.0.1:5180/?overlay=1", help="URL to companion app")
    parser.add_argument("--width", type=int, default=420, help="Window width")
    parser.add_argument("--height", type=int, default=660, help="Window height")
    parser.add_argument("--no-top", action="store_true", help="Disable always-on-top")
    args = parser.parse_args()

    # Determine primary monitor dimensions
    screens = webview.screens
    screen = screens[0] if screens else None

    # Position in bottom-right corner of screen (above taskbar)
    if screen:
        x = max(20, screen.width - args.width - 30)
        y = max(20, screen.height - args.height - 50)
    else:
        x, y = 1000, 200

    print("==========================================================")
    print("  [Jinx] 3D Anime Companion - Desktop Overlay Mode")
    print("==========================================================")
    print(f"  * Target:     {args.url}")
    print(f"  * Position:   ({x}, {y}) | Size: {args.width}x{args.height}")
    print(f"  * Always Top: {not args.no_top}")
    print("  * Features:   Transparent Canvas, Easy Drag, Voice Dictate")
    print("==========================================================")
    print("  Drag Jinx by her body or bar to move her anywhere on screen.")
    print("  Close the window to exit overlay mode.\n")

    window = webview.create_window(
        title="Jinx - Desktop Companion",
        url=args.url,
        width=args.width,
        height=args.height,
        x=x,
        y=y,
        frameless=True,
        on_top=not args.no_top,
        transparent=True,
        easy_drag=True,
        background_color='#000000'
    )

    webview.start(debug=False)

if __name__ == "__main__":
    main()
