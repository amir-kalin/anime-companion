"""
Print the true frame range of every action in a set of FBX files.

    blender --background --factory-startup --python tools/blender-durations.py -- a.fbx b.fbx

Needed because the Node-side check reported three different source animations
as the same 8.33s after the mesh-stripping export, which is not credible and
needs a second opinion from the tool that actually wrote the files.
"""

import sys
import bpy

files = sys.argv[sys.argv.index("--") + 1:]

for path in files:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    frames = []
    for fc in (fc for a in bpy.data.actions for fc in a.fcurves):
        frames.extend(fc.keyframe_points[i].co[0] for i in (0, -1))
    lo, hi = (min(frames), max(frames)) if frames else (0, 0)
    print(f"{path}")
    print(f"   armatures={len(arms)} bones={len(arms[0].data.bones) if arms else 0} meshes={len(meshes)}")
    print(f"   actions={[(a.name, len(a.fcurves)) for a in bpy.data.actions]}")
    print(f"   frame range = {lo:.2f} .. {hi:.2f}   ({hi - lo:.2f}s @ 30fps)")
    print()