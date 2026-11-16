"""
Is Piper thread-starved?

Piper's ONNX graph runs per audio frame, so its cost scales with the thread
count available. If the default session is using one thread on a 10-core CPU,
explicitly raising intra_op_num_threads is a free several-fold speedup. This
benchmarks the same model at several thread counts.
"""
import time

import numpy as np
import onnxruntime as ort

PIPER = r"C:\Users\KALI\Downloads\en_US-lessac-medium.onnx"


def bench(threads):
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    s = ort.InferenceSession(PIPER, so, providers=["CPUExecutionProvider"])
    feed = {}
    for i in s.get_inputs():
        shape = [d if isinstance(d, int) else 1 for d in i.shape]
        # The model mixes float audio features with int64 token ids, so the
        # dtype has to follow the graph's declaration rather than assuming float.
        dtype = np.int64 if "int64" in i.type else np.float32
        if np.issubdtype(dtype, np.integer):
            feed[i.name] = np.zeros(shape, dtype=np.int64)
        else:
            feed[i.name] = np.random.rand(*shape).astype(np.float32)
    s.run(None, feed)  # warm
    n = 3
    t = time.time()
    for _ in range(n):
        s.run(None, feed)
    return (time.time() - t) / n


print("frames/sec implied by ms/frame (higher is better):")
best = None
for n in [0, 2, 4, 6, 8, 10, 16]:
    try:
        per = bench(n)
    except Exception as e:  # noqa: BLE001
        print(f"threads={n:2d}  FAILED: {e}")
        continue
    print(f"threads={n:2d}  {per*1000:8.2f} ms/frame  -> {1/per:7.1f} frames/s")
    if best is None or per < best[1]:
        best = (n, per)

print(f"\nbest: {best[0]} threads at {best[1]*1000:.2f} ms/frame")
print("Piper generates at 22050 Hz, so frames/s must exceed 22050 for >1x realtime.")
